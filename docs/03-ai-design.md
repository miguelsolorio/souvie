# 03 · AI design

Everything the model does is bounded by code. Hard constraints (allergies, budget, substitution policy) live in SQL and TypeScript. The model proposes; deterministic code checks; the user decides at one review step. This document covers model plumbing, onboarding, recommendations, import, parsing, aggregation, line-item conversion, the shopping agent, the in-app assistant, and the evaluation harness.

## 1. Model tiers and plumbing (`packages/llm`)

| Model | Use | Notes |
|---|---|---|
| `claude-haiku-5-5` | Ingredient parsing, alias canonicalization, classification, cheap re-ranks | $0.10 / $0.50 per MTok |
| `claude-sonnet-5-5` | Weekly plan composition, recipe extraction from messy text, caption-to-recipe, the shopping agent loop, the in-app assistant | $2 / $10 per MTok; cache reads $0.20 per MTok (0.1×) |
| `claude-opus-5-5` | Escalation only: ambiguous imports, complex substitution reasoning | $4 / $20 per MTok |
| Voyage AI `voyage-3` | Recipe and taste-profile embeddings (`recipes.embedding`, `profiles.taste_embedding`, 1024 dimensions) | Decided 2026-10-30; key `VOYAGE_API_KEY`; without it the pipeline falls back to catalog popularity |

Plumbing rules:
- Every call declares a zod schema and uses structured outputs (`output_config` with a JSON schema; `messages.parse()` in the SDK). Agent tools are declared with `strict: true`.
- Request shape for Sonnet 5.5 and Haiku 5.5 (confirmed 2026-10-30): omit `thinking`, which runs adaptive thinking; `thinking: {type: "disabled"}`, `budget_tokens`, and non-default `temperature`, `top_p` or `top_k` return 400. Depth is set with `output_config.effort`. On Sonnet 5.5 a forced `tool_choice` (`any` or `tool`) also returns 400, so agent tools use `auto` with `strict: true` and the prompt names the tool. `@mp/llm` sends `output_config: { effort, format }` and nothing else; the server-side refusal fallback (`fallbacks: "default"`, beta `server-side-fallback-2026-07-01`) is opt-in and off by default.
- Prompts live in `packages/llm/prompts/<name>/<version>.ts` with a registry; every `ai_runs` row records `prompt_version`.
- Prompt caching for stable blocks: the ingredient ontology excerpt, the household profile, the adapter's product schema.
- Every call writes an `ai_runs` row (model, tokens, cache reads, cost, latency, ok). `packages/llm` enforces a per-household daily cost cap read from a config table or env; over cap it throws a typed error the UI explains.
- The shopping agent uses the Anthropic SDK tool-runner loop directly, not the Agent SDK, so tools, policies, and the state machine stay in our code and are replayable in tests.
- Expected cost: a week of parsing plus planning for one household lands well under $0.50. A shopping run is typically 10–30 Sonnet turns with cached context, under $0.30.

## 2. Onboarding → curated recipes (WS06)

Hybrid: structured screens, which are reliable and designable, plus one free-text "anything else?" step the model folds into the profile.

| Step | Captures | Writes |
|---|---|---|
| 1 | Sign in; create or join household | `households`, `household_members` |
| 2 | Who's eating: adults, kids, dinners per week | `profiles.preferences.portions`, `dinners_per_week` |
| 3 | Diets and allergies | `diets[]`, `allergies[]` (hard filters, never left to the model) |
| 4 | Never-foods and favorite cuisines | `dislikes[]`, `cuisines[]` |
| 5 | Time and skill: weeknight minutes, skill level, equipment | `weeknight_minutes`, `skill`, `equipment[]` |
| 6 | Budget per week and leftovers preference | `budget_per_week_usd`, `leftovers` |
| 7 | Stores: zip → nearby QFC, Fred Meyer, Safeway, Costco; pick primary; Costco membership; connect Kroger now or later | `households.zip`, `retailer_connections` (optional), `costco_member` |
| 8 | Calibration: 12 AI-picked recipes, swipe like or skip | `recipe_feedback` seeds |
| 9 | Free text: "anything else we should know?" | Sonnet merges into `preferences.notes` and may set structured fields with user confirmation |

Output: a complete `profiles.preferences`, feedback seeds, and a first draft `meal_plans` row for the coming week. The `ProfilePreferences` zod schema and the `DIETS` and `ALLERGENS` enums (the nine FDA major allergens) defined in WS06 are canonical.

### Onboarding fields (as built, WS06)

Eight screens in `apps/mobile/app/(onboarding)/`. Each one saves its own keys when the person taps Continue, and sets `profiles.onboarding_step` to its number (never lower than it already was). Quitting on screen 5 leaves the step at 4 and the app reopens on screen 5. The free-text step 9 above is a single optional "anything else?" box at the bottom of screen 6, written to `preferences.notes`; there is no chat.

| # | Route | Field | Type and limits | Stored in |
|---|---|---|---|---|
| 1 | `01-household` | household name or invite | name 2 to 40 characters | `households`, `household_members` |
| 2 | `02-eaters` | adults, kids, dinners per week | adults 1 to 12, kids 0 to 12, dinners 1 to 7 | `preferences.household_size`, `dinners_per_week`, and `portions` (adults plus kids) |
| 3 | `03-diets-allergies` | diets, allergies | `DIETS`, `ALLERGENS`; an allergen or "No allergies" is required | `preferences.diets`, `allergies` |
| 4 | `04-dislikes-cuisines` | never-foods, cuisines | up to 20 never-foods of 60 characters, lowercased | `preferences.dislikes`, `cuisines` |
| 5 | `05-time-skill` | weeknight minutes, skill, equipment | 10 to 120; beginner, comfortable, confident | `preferences.weeknight_minutes`, `skill`, `equipment` |
| 6 | `06-budget-leftovers` | weekly budget, leftovers, note | budget empty or 20 to 1000 (empty removes the key); avoid, ok, prefer; note up to 500 characters | `preferences.budget_per_week_usd`, `leftovers`, `notes` |
| 7 | `07-stores` | ZIP, primary store, Costco membership | 5 digits; a store or "not listed"; yes or no | `preferences.primary_store_id`, `profiles.costco_member`, `households.zip` (owner only) |
| 8 | `08-calibrate` | twelve swipes | like or not for me; "Skip the rest" ends early | `recipe_feedback` (`like`, `dislike`), `profiles.taste_embedding`, first plan |

An `allergies` key in `profiles.preferences` means the person answered the allergy question, and an empty list means "none". The `suggest` function refuses to plan for someone whose key is absent, so nothing writes the form's defaults to the database. A CHECK constraint on `profiles.preferences` refuses an allergen or diet outside the lists.

## 3. Recommendation pipeline (`suggest` Edge Function, WS06)

Retrieve → filter → compose → learn.

1. **Candidates.** Build a "taste profile" embedding from liked recipes, cuisines, and notes. Query `recipes.embedding` by cosine similarity across the household's recipes and the catalog. Take the top ~60, boosted by household history (cooked recently is penalized, liked is boosted).
2. **Hard filters in SQL.** Exclude any recipe whose ingredients match an allergy, violate a diet, exceed `weeknight_minutes` on weekdays, or contain a never-food. This happens before the model sees anything.
3. **Compose with Sonnet.** Input: the filtered candidates (id, title, tags, time, main ingredients), the profile, the week's constraints (which nights are busy, how many dinners), and last week's plan. Output (structured): N entries with `recipe_id`, `date`, `slot`, `servings`, one-line `why`, plus a `shopping_overlap_note`. Objectives in the prompt: variety across proteins and cuisines, ingredient overlap to cut waste and cost, leftovers where the household wants them, time budget per night.
4. **Validate.** Code checks every returned `recipe_id` is in the candidate set (no hallucinated recipes), no duplicates, dates inside the week. Invalid output is retried once, then falls back to top-N by score.
5. **Learn.** Like, skip, cooked, swapped, and saved write `recipe_feedback`. A weekly job re-embeds the taste profile.

**As built (WS06).** The function is `supabase/functions/suggest/`; its README has the request, the errors, and the ranking formula. Where it differs from the steps above:

- **Allergen data.** The ontology has no `allergen_tags`. Allergens are matched by term lists against ingredient names and raw ingredient text, plus category rules, in SQL and again in TypeScript on the final candidates. Lists exclude when in doubt and can miss a food they do not name.
- **Diets.** Seven diets are enforced from ingredients. low carb, keto, and paleo only steer the composer.
- **Households.** Everyone's allergies and diets apply to a shared plan; the requester's never-foods and weeknight minutes steer it.
- **Safety reads.** Each member's preferences are read field by field, so one invalid field never drops their allergies or diets from the household's union. A value outside the vocabulary stops the request. A recipe with no ingredient lines is left out whenever the household has an allergy or a diet with an ingredient rule. A draft for a week that already has a plan, and a replace of one night, re-check the still-planned dinners against the current allergies and diets and replace any that fail, with no model call. The response says how many in `repaired`.
- **Never-foods.** A parsed line is judged by its canonical ingredient. A pantry staple matches only by its exact name. Any other ingredient matches by name, plural, alias, or a whole word in its name. An unparsed line is judged by its raw text. "olive" excludes olives, not olive oil, and "pepper" excludes bell peppers, not black pepper, though the seed aliases pepper to black pepper.
- **Catalog embeddings.** `backfill` and the pre-plan refresh also embed catalog recipes, which every household shares.
- **Editing later.** Household settings has "Edit food preferences", which reopens screens 2 to 6 and returns to settings. Saving screen 3 or 4 there calls `draft` for this week and the coming week (only weeks that already have dinners) so planned dinners that no longer fit are replaced or removed, and shows "Your week was updated." or "Your plan already fits."
- **Fallback.** After two invalid answers, or with no model key or no budget, the plan is the best-ranked candidates spread over cuisines, with reasons built from facts, not from a model. The response says `composedBy: "fallback"`.
- **Embeddings.** Voyage `voyage-3`. The taste vector is rebuilt on every plan (once a week in practice) rather than by a separate weekly job. Without `VOYAGE_API_KEY` ranking uses cuisine and popularity.
- **Logging.** `suggest.compose` and `suggest.embed` rows in `ai_runs`; a plan with no possible model call writes one failed `suggest.compose` row with the reason.

## 4. Recipe import (`packages/recipe-import`, WS02)

| Source | Method | Fallback |
|---|---|---|
| URL | Fetch, then the TypeScript `recipe-scrapers` port (JSON-LD, microdata, RDFa, per-site scrapers; it does not bypass bot protection) → normalized Recipe | Readability-extracted text → Sonnet structured extraction |
| Pasted text | Sonnet structured extraction | None |
| Photo (cookbook page, recipe card) | Claude vision with the Recipe JSON schema → user confirms | Retry with Opus if confidence low |
| Video (TikTok, Instagram, YouTube) | **Caption only.** The user shares the post into the app or pastes a link; we use the caption or description text that arrives with the share plus any text the user pastes; Sonnet structures it | If the recipe is not in the caption, say so and offer photo or paste import |
| AI-generated | "A 25-minute weeknight salmon" → Sonnet drafts a recipe, tagged `source_type: ai` | None |

Why caption-only for video: YouTube's captions endpoint works only for videos you own; Instagram oEmbed forbids persisting metadata; TikTok's embed API returns no description; all three terms prohibit automated download. We never fetch media or scrape transcripts. A later option is on-device Whisper transcription of a video the user already saved to their own camera roll.

Every imported recipe stores `source_url` and shows attribution. Imported recipes are `visibility: household`. The shared `catalog` holds only our own or licensed recipes.

After extraction, every ingredient line goes through the parser (section 5) and the recipe gets an embedding.

## 5. Ingredient parsing (`packages/ingredient-parser`, WS03)

Deterministic first, model second, cache always.

1. **Grammar.** Quantity (integers, fractions, unicode fractions, ranges "2–3", "a"), unit (dictionary with aliases: tbsp, T, tablespoon, tablespoons), preparation phrases ("diced", "finely chopped"), qualifiers ("to taste", "optional", "divided"), and parenthetical sizes ("1 (15 oz) can").
2. **Ontology lookup.** Match the remaining noun phrase against `ingredients.name` and `ingredient_aliases.alias` with trigram similarity; accept above 0.85.
3. **Model fallback.** Lines below the confidence threshold (0.8) go to Haiku in batches of 20 with a strict schema `{qty, unit, ingredient, prep, optional, confidence}`. Results are cached by normalized `raw_text` so the same line is never parsed twice across the household.
4. **Unknowns.** An ingredient the ontology lacks creates a proposed `ingredient_aliases` row with `source: llm` for review, and the line is kept with `ingredient_id null` so the list can still show it as free text.

Why this path: no actively maintained TypeScript ingredient parser exists. The best open one (`ingredient-parser-nlp`, ~94% sentence accuracy) is Python. Grammar plus Haiku is the pragmatic TypeScript route, and the golden set doubles as the eval set.

Ontology sources: our own seed CSV first (~600 ingredients with category, default unit, density, typical unit weight, staple flag). USDA FoodData Central (free, 1,000 req/hr) for nutrition and FoodOn ids when needed. Open Food Facts (free, ODbL, 15 req/min) for UPC → product facts when a retailer catalog lacks ingredient text.

## 6. List aggregation (`packages/core/list`, WS05)

Pure functions, fully unit-tested.

1. Normalize units: volume ↔ weight via `ingredients.density_g_per_ml`; counts via `typical_unit_weight_g`; everything to grams or milliliters internally.
2. Scale each recipe's ingredients by `entry.servings / recipe.servings`.
3. Sum per `ingredient_id` across the week's entries. Keep `source_entry_ids` so a swapped recipe re-aggregates cleanly.
4. Remove `pantry_items` with status `have` and ingredients flagged `is_staple_default` unless the household overrides.
5. Round up to purchasable quantities using the ingredient's `default_unit` and a small table of pack sizes (1.3 lb chicken → 1.5 lb; 2 cloves garlic → 1 head; 1.5 cups flour → 1 bag unless the pantry says "have").
6. Group by `ingredients.category` and order sections per store (configurable; default produce → bakery → meat → seafood → dairy → eggs → pantry → canned → baking → spices → international → snacks → frozen → beverages → household → other).

Output: `grocery_list_items` with human-friendly `display_name`, normalized `qty` and `unit`, and `section`.

## 7. Line-item conversion (WS09, uses WS07 adapters)

For each list item and the chosen retailer:

1. **Candidates.** If a pinned `product_matches` row exists, fetch that product by id (batch via `getProducts`). Otherwise `searchProducts` with the ingredient name and up to two alias variants, filtered to the store.
2. **Score** (deterministic, in code): pinned > household's past picks > unit-price fit for the required quantity > brand and size preferences from the profile > stock level. Organic or brand filters from the profile apply as soft preferences unless the user marked them hard.
3. **Model assist.** When the top two candidates are within a small score margin, or the item is ambiguous ("stock"), Sonnet picks **by candidate index** from the list we give it. The model never emits a UPC or product id.
4. **Output.** A `shopping_run_items` row with the chosen product, up to three alternatives, estimated price, and `needs_review` when confidence is low, the item is high-value (over the per-item ceiling), or a substitution crossed brands.

## 8. Shopping agent (`packages/agent`, hosted by WS09 worker or WS10 WebView)

### Tools

| Tool | Capability needed | Notes |
|---|---|---|
| `find_store` | search | Nearby stores for the household zip |
| `search_products` | search | Returns candidates with indices; results stay in memory |
| `get_product` | search | Batch by id for pinned items |
| `add_to_cart` | cartAdd | Signed quantity delta + modality; writes the ledger first |
| `set_quantity` | cartAdd (+cartRead if available) | Computes the delta from the ledger or the live cart |
| `remove_from_cart` | cartAdd or cartRead | Negative delta where no read exists |
| `view_cart` | cartRead | Absent for Kroger public tier; the agent uses the ledger |
| `get_slots`, `select_slot` | slots | Browser adapters only today |
| `request_review` | none | Pauses the run at `needs_review` or `cart_ready` and notifies |
| `checkout` | checkout | Tier 3 only; gated by policy and approval |
| `finish` | none | Closes the run with a summary |

### Policies enforced in code, not prompts

Budget cap, per-item ceiling, substitution level (none / same_brand / any), allergen block list, and the review gate. A tool call that violates policy is rejected by the host and the agent is told why.

### Run state machine

`queued → running → needs_review → cart_ready → checking_out → checked_out`, with `failed` and `cancelled` reachable from any state. Checkout proceeds only after the user approves in-app, or when the household enabled `auto_checkout` under `auto_checkout_cap_usd` on a Tier 3 connection.

### Order of operations for write-only carts

Kroger's public Cart API is add-only with no read. So:

1. Build the full proposed cart from catalog searches. No cart writes.
2. Deterministic allergen check on the proposed cart using `Product.allergens` where present, plus ingredient text from Open Food Facts for UPCs that lack it.
3. Set `needs_review` (if any item needs review) or `cart_ready`. Notify.
4. The user accepts, swaps, or removes items in the review screen (`user_decision`).
5. Push adds. Before each call, write `shopping_run_items.delta_sent` and `sent_at`; after the call, write `delta_result`. A retry resumes from rows without a result. Corrections send negative deltas.
6. Deep-link the user to checkout (Tier 1) or continue through slots and pay (Tier 3).

Where an adapter can read the cart (browser adapters, Instacart partner tier), step 5 diffs against the live cart instead.

### Audit

Every tool call appends to `shopping_runs.transcript` (timestamp, tool, input, output summary, optional screenshot path for browser steps). The review screen can show the transcript.

## 9. In-app assistant (WS06, extended by later WS)

A chat surface over the same domain services the UI uses: "swap Tuesday for something faster," "make the week vegetarian," "what can I cook with what's in the pantry," "move the Costco items to Saturday's run." It reads household context, plan, and list, and writes through the same functions as buttons do, so nothing the assistant does bypasses validation.

## 10. Evaluation harness (`pnpm eval`, WS15 wires CI; WS02, WS03, WS09 provide sets)

| Set | Location | Threshold |
|---|---|---|
| 50 recipe URLs → expected normalized recipes | `packages/recipe-import/evals/` | ≥45 pass (title, servings, ingredient count ±1, instructions non-empty) |
| 500 ingredient lines → expected parses | `packages/ingredient-parser/evals/` | ≥95% exact on qty and unit; ≥90% on ingredient id |
| 100 ingredient→product cases per retailer against MockRetailer fixtures | `packages/agent/evals/` | ≥90% pick the expected product or an accepted alternative |
| Recorded agent runs replayed against MockRetailer | `packages/agent/evals/replays/` | Same final cart; no policy violations |

CI fails a merge when any threshold regresses. Prompt changes must come with eval results in the completion report.

## 11. Safety rules the model never overrides

- Allergies are enforced by SQL filters and the deterministic cart check. A model suggestion that includes an allergen is dropped and logged, never shown.
- The model chooses among candidates by index; it never invents recipe ids, product ids, or UPCs.
- Spending is capped in code. The agent cannot raise a cap.
- Checkout requires approval or an explicit pre-set auto-approve cap, and only on Tier 3 connections.
