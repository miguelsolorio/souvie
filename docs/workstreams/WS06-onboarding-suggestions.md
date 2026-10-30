# WS06: Onboarding & suggestions

**Wave:** 3 · **Suggested model:** Sonnet · **Branch:** `ws/06-onboarding-suggestions`

## Goal
When this is done, a new user can sign in, create or join a household, answer eight short screens about who eats, what they cannot or will not eat, how much time and money they have, and which stores they use, then swipe through twelve AI-picked recipes to calibrate taste. The output is a validated `profiles.preferences` record, a set of `recipe_feedback` seed rows, and a first drafted `meal_plans` row for the coming week. A `suggest` Edge Function produces that plan and every later weekly plan by retrieving candidates with pgvector, applying hard SQL filters, and composing the week with `claude-sonnet-5-5` under a strict output schema. This is the first moment the product feels personal, and it feeds every downstream list and shopping run.

## Depends on
- WS01 (Auth & households): sign-in screens, `households`, `household_members`, `profiles` rows exist and RLS is in place. This WS adds the `preferences` payload and the onboarding flow around them.
- WS02 (Recipe domain & import): `recipes`, `recipe_ingredients`, `recipe_feedback` tables, the `recipes.embedding vector(1024)` column, the recipe card component in `packages/ui`, and the embedding helper in `packages/llm`.
- WS03 (Ingredient ontology & parser): `ingredients` table with `category` and the allergen tag set, used for hard filters and for the "never-foods" picker.
- WS07 is NOT a dependency. The stores step offers "Connect Kroger" but renders it as a placeholder button when WS07 has not merged. Guard on a capability flag exported by `packages/retailers`.

## Read first
1. `docs/03-ai-design.md` §4.1 (model tiers), §4.2 (onboarding), §4.3 (recommendation pipeline), §4.10 (eval harness).
2. `docs/02-data-model.md` sections Identity, Recipes, Planning (table shapes, RLS pattern).
3. `docs/05-security-privacy.md` paragraph on allergen safety.
4. `docs/06-risks.md` rows R3, R4, R8.
5. `packages/core/src/preferences.ts` if it already exists from WS01; otherwise you create it (see Interfaces).

## In scope
- Eight onboarding screens in `apps/mobile/app/(onboarding)/` using Expo Router, with progress, back navigation, and resume-where-you-left-off persisted in `profiles.onboarding_step`.
- The `Preferences` zod schema in `packages/core` and its JSON storage in `profiles.preferences`.
- A "stores" step that geocodes a ZIP to nearby stores (QFC, Fred Meyer, Safeway, Albertsons, Haggen, Costco) using a static WA store list seed in `supabase/seed/stores_wa.csv` for now, asks "Do you have a Costco membership?", lets the user pick a primary store, and shows "Connect Kroger" when the adapter is available.
- A twelve-card swipe calibration screen that writes `recipe_feedback` rows with `signal = like | skip`.
- The `suggest` Edge Function at `supabase/functions/suggest/` and its client hook `useSuggestWeek()` in `apps/mobile`.
- A "taste profile" embedding job: `supabase/functions/suggest/profile-embedding.ts` computes an embedding from preferences plus liked recipes and stores it in `profiles.taste_embedding vector(1024)`.
- Prompt files under `packages/llm/prompts/suggest/` with versioned names, registered in the prompt registry.
- Unit tests for the schema, the filter SQL builder, and the composition output validator. A small eval in `packages/llm/evals/suggest/` with ten household fixtures.
- Logging every model call to `ai_runs`.

### Screen-by-screen specification

| # | Route | Captures | Writes | Validation |
|---|---|---|---|---|
| 1 | `01-household` | Create household name or paste invite code | `households`, `household_members` (via WS01 hooks) | Name 2–40 chars |
| 2 | `02-eaters` | Adults, kids, dinners per week | `preferences.householdSize`, `preferences.dinnersPerWeek` | Adults ≥1, dinners 1–7 |
| 3 | `03-diets-allergies` | Diet chips, allergen chips, explicit "No allergies" | `preferences.diets`, `preferences.allergies` | Cannot continue until an allergen choice or "None" is made |
| 4 | `04-dislikes-cuisines` | Never-foods (free text with ontology autocomplete), favorite cuisines | `preferences.neverFoods`, `preferences.cuisines` | Up to 20 never-foods |
| 5 | `05-time-skill` | Weeknight minutes slider, skill, equipment chips | `preferences.weeknightMinutes`, `skill`, `equipment` | Minutes 10–120 |
| 6 | `06-budget-leftovers` | Weekly budget (optional), leftovers stance | `preferences.budgetPerWeekUsd`, `leftovers` | Budget null or 20–1000 |
| 7 | `07-stores` | ZIP, nearby stores, primary store, Costco membership, Connect Kroger | `preferences.primaryStoreId`, `profiles.costco_member`, `households.zip` | ZIP 5 digits; at least one store chosen |
| 8 | `08-calibrate` | Twelve swipes | `recipe_feedback` rows, `profiles.taste_embedding`, first `meal_plans` + `meal_plan_entries` via `suggest` | All twelve cards answered or "Skip the rest" |

Each screen writes its fields immediately on "Continue" so a crash loses at most one screen. `profiles.onboarding_step` is set to the screen number just completed.

### Candidate retrieval sketch

```sql
with filtered as (
  select r.id, r.embedding, r.cuisine, r.total_min
  from recipes r
  where (r.household_id = $household or r.visibility = 'catalog')
    and r.total_min <= $weeknight_minutes
    and not exists (
      select 1 from recipe_ingredients ri
      join ingredients i on i.id = ri.ingredient_id
      where ri.recipe_id = r.id
        and (i.allergen_tags && $allergies or i.id = any($never_food_ids))
    )
    and not (r.tags && $diet_conflict_tags)
)
select id from filtered
order by embedding <=> $taste_embedding
limit 60;
```

The composer never sees recipes that this query excluded. The twelve calibration cards come from the same query ordered by catalog popularity when `taste_embedding` is null.

## Out of scope
- Sign-in UI and household invite links (WS01).
- Recipe import and the recipe detail screen (WS02).
- The week planner UI that displays the drafted plan (WS04). This WS only writes the `meal_plans` and `meal_plan_entries` rows.
- Grocery list generation (WS05).
- Kroger OAuth itself (WS07). You render the button and call `connect()` only if the adapter exists.
- The in-app chat assistant (WS09).
- Any change to the `RetailerAdapter` contract or shared zod types other than adding `Preferences` and `profiles.taste_embedding` through a contract change request if `profiles` already has a frozen shape.

## Deliverables
- `packages/core/src/preferences.ts` (zod schema `Preferences`, type export, defaults, `ALLERGENS` const list, `DIETS` const list).
- `supabase/migrations/<timestamp>_ws06_preferences.sql`: adds `profiles.preferences jsonb not null default '{}'`, `profiles.onboarding_step smallint not null default 0`, `profiles.taste_embedding vector(1024)`, `profiles.costco_member boolean`, and index `recipes_embedding_hnsw` on `recipes.embedding` if not present.
- `supabase/seed/stores_wa.csv` with at least 60 Washington stores (banner, name, address, zip, lat, lng, kroger_location_id nullable).
- `apps/mobile/app/(onboarding)/_layout.tsx`, `01-household.tsx`, `02-eaters.tsx`, `03-diets-allergies.tsx`, `04-dislikes-cuisines.tsx`, `05-time-skill.tsx`, `06-budget-leftovers.tsx`, `07-stores.tsx`, `08-calibrate.tsx`.
- `apps/mobile/features/onboarding/` hooks and store (`useOnboarding`, `usePreferencesDraft`).
- `supabase/functions/suggest/index.ts`, `candidates.ts`, `filters.ts`, `compose.ts`, `profile-embedding.ts`.
- `packages/llm/prompts/suggest/compose.v1.md`, `packages/llm/prompts/suggest/taste-summary.v1.md`.
- `packages/llm/evals/suggest/fixtures/*.json` and `packages/llm/evals/suggest/run.ts`.
- Tests: `packages/core/src/preferences.test.ts`, `supabase/functions/suggest/filters.test.ts`, `supabase/functions/suggest/compose.test.ts`.
- Docs update: a short "Onboarding fields" table appended to `docs/03-ai-design.md` §4.2.

## Interfaces
**Implements**
- `Preferences` (zod, `packages/core`):
  - `householdSize: { adults: number; kids: number }`
  - `dinnersPerWeek: number` (1–7)
  - `diets: Diet[]` from `DIETS = ['omnivore','vegetarian','vegan','pescatarian','halal','kosher','gluten_free','dairy_free','low_carb','keto','paleo']`
  - `allergies: Allergen[]` from `ALLERGENS = ['peanut','tree_nut','milk','egg','wheat','soy','fish','shellfish','sesame']` (hard filters)
  - `neverFoods: string[]` (free text, canonicalized to `ingredients.id` where possible, stored as `{ text, ingredientId? }[]`)
  - `cuisines: string[]`
  - `weeknightMinutes: number`
  - `skill: 'beginner' | 'comfortable' | 'confident'`
  - `equipment: string[]`
  - `budgetPerWeekUsd: number | null`
  - `leftovers: 'avoid' | 'some' | 'love'`
  - `primaryStoreId: string | null`
  - `freeText: string | null`
- `profiles.preferences`, `profiles.onboarding_step`, `profiles.taste_embedding`, `profiles.costco_member`.
- Edge Function `POST /functions/v1/suggest` with body `{ householdId: string; weekStart: string (ISO date); dinners?: number; mode: 'draft' | 'replace' | 'calibration' }` returning `{ planId: string; entries: { date: string; slot: 'dinner'; recipeId: string; servings: number; why: string }[] }`. `mode: 'calibration'` returns twelve recipe IDs without writing a plan.
- Structured output schema for composition (`ComposedWeek`): `{ entries: { recipeIndex: number; date: string; servings: number; why: string }[]; notes: string }`. The model picks indices into the candidate list. It never emits recipe IDs or ingredient names as identifiers.

**Consumes**
- `recipes`, `recipe_ingredients`, `recipe_feedback`, `ingredients`, `meal_plans`, `meal_plan_entries` (shapes in `docs/02-data-model.md`).
- `packages/llm`: `createClient()`, `parseStructured(model, schema, prompt, vars)`, `embed(text) -> number[1024]`, `logAiRun()`.
- `packages/retailers`: `getAdapter('kroger')?.connect` behind `isAdapterAvailable('kroger')`.

**Contract notes**
- Hard filters are SQL, not prompts. `filters.ts` builds a `where` clause that excludes any recipe whose `recipe_ingredients.ingredient_id` maps to an `ingredients.allergen_tags` entry in `preferences.allergies`, excludes diet conflicts via `recipes.tags`, and excludes `neverFoods` ingredient IDs.
- The composer receives at most 60 candidates and returns 1 to 7 entries.

## Acceptance criteria
1. `pnpm test --filter core` passes `preferences.test.ts`: invalid `dinnersPerWeek: 9` is rejected, unknown allergen string is rejected, defaults produce a valid object.
2. A new user who completes all eight screens has `profiles.preferences` that parses with the `Preferences` schema and `profiles.onboarding_step = 8`. Verified by the Maestro flow `apps/mobile/e2e/onboarding.yaml` or, until Maestro exists, by the manual script in Verification commands.
3. Quitting the app on screen 5 and reopening resumes on screen 5 (`onboarding_step = 4` persisted).
4. The allergies step cannot be skipped. "None" is an explicit choice.
5. The stores step lists at least three stores for ZIP 98019 from the seed, lets the user choose one, and records `costco_member`.
6. The calibration screen shows twelve recipes that all pass the hard filters for a fixture household with `allergies: ['shellfish']`; `filters.test.ts` asserts zero shellfish recipes in the candidate set for that fixture.
7. `POST /suggest` with `mode: 'draft'` for a fixture household returns 5 entries when `dinnersPerWeek = 5`, with distinct `recipeId` values, every entry on a distinct date within the week, and every `why` under 140 characters.
8. The composer output is validated against `ComposedWeek`; an out-of-range `recipeIndex` is rejected and the call retried once, then fails with a typed error. `compose.test.ts` covers this with a mocked model.
9. Every `suggest` invocation writes one or more `ai_runs` rows with `kind = 'suggest.compose'` or `'suggest.embed'`, model name, token counts, and `cost_usd`.
10. `pnpm eval suggest` runs the ten fixtures and reports hard-filter violations; the threshold is zero violations.
11. `pnpm typecheck && pnpm lint` pass at the repo root.
12. A household member who is not the owner can complete onboarding and sees the same household's draft plan; RLS test `supabase/tests/ws06_preferences.sql` asserts a user in another household cannot read `profiles.preferences`.

## Verification commands
```bash
pnpm typecheck && pnpm lint                      # expected: exit 0
pnpm test --filter core --filter supabase-functions   # expected: all green, includes preferences, filters, compose tests
supabase start && supabase db reset             # expected: migrations apply, stores_wa.csv seeds ≥60 rows
supabase test db                                # expected: ws06_preferences.sql passes
supabase functions serve suggest --env-file .env.local &
curl -s -X POST http://localhost:54321/functions/v1/suggest \
  -H "Authorization: Bearer $TEST_USER_JWT" -H "Content-Type: application/json" \
  -d '{"householdId":"<fixture>","weekStart":"2026-11-02","mode":"draft"}' | jq '.entries | length'   # expected: 5
pnpm eval suggest                               # expected: "hard-filter violations: 0"
pnpm --filter mobile start                      # manual: run the 8 screens on iOS Simulator and web; confirm resume on screen 5
```

## Risks and notes
- From the WS01 review (2026-10-30): `profiles` still has table-level `grant select, insert, update` for `authenticated` (own row only through RLS). When you add `taste_embedding`, `onboarding_step` and `costco_member`, narrow the grant to column level so a user cannot overwrite the server-built embedding: grant update on `display_name`, `avatar_url`, `preferences`, `onboarding_step`, `costco_member` only. Add a `column_privs_are(...)` pgTAP assertion for `profiles`, and one for `households` (`name`, `zip`) so a later migration cannot widen either silently. Also reconcile `ProfilePreferences` (docs/02 shape, implemented by WS01) with the camelCase `Preferences` this brief plans; the orchestrator decides before dispatch.
- R4 (allergen exposure): allergies are hard SQL filters; the model only sees pre-filtered candidates. Add a final assertion in `compose.ts` that every returned recipe is in the candidate set, as defense in depth.
- R3 (LLM cost): one composition call per week per household with `claude-sonnet-5-5`; taste summary with `claude-haiku-5-5`. Cache the ontology excerpt and the preference block with prompt caching. Log everything to `ai_runs`.
- R8 (scope creep): do not build a conversational onboarding. The single `freeText` field is folded into the taste summary and that is all.
- Candidate retrieval uses `recipes.embedding <=> profiles.taste_embedding` with HNSW (`vector_cosine_ops`). On a cold profile with no likes, fall back to catalog popularity plus cuisine match.
- `stores_wa.csv` is a stopgap. WS07 replaces Kroger entries with live Locations API results; keep the CSV columns so both sources map to one `Store` shape.
- Costco membership matters because costco.com is members-only and there is no non-member route. Record it now so WS10's Costco adapter can refuse early with a clear message, and so suggestions never assign items to Costco for a non-member household.
- Prompt files are versioned (`compose.v1.md`). Changing a prompt means a new version file and a registry entry, not an edit in place.

## Completion report
End with the report format from `docs/implementation-guide.md` §6.2 (Message templates) (Built, Files changed, Verification output, Deviations from brief, Contract change requests, Open issues, Follow-ups). Nothing else is read by the orchestrator.
