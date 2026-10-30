# 02 · Data model

Postgres on Supabase. Every household-scoped table carries `household_id` and is protected by Row Level Security. SQL migrations in `supabase/migrations/` are the source of truth; `packages/db` holds generated types. Each workstream adds its own migration for the tables it owns (listed at the end).

## Conventions

- Primary keys: `id uuid default gen_random_uuid()`.
- Timestamps: `created_at timestamptz default now()`, `updated_at timestamptz` maintained by a trigger. User-content tables also have `deleted_at timestamptz` for soft delete.
- Enums are Postgres enums, named `<table>_<column>`; zod mirrors them in `packages/core`.
- JSON columns are `jsonb` and have a zod schema in `packages/core` that is the only writer.
- Foreign keys cascade on household delete.

## RLS pattern

One helper, created by WS01 and used by every policy:

```sql
create or replace function public.current_household_ids()
returns setof uuid language sql stable security definer as $$
  select household_id from public.household_members where user_id = auth.uid();
$$;
```

Every household-scoped table:

```sql
alter table public.<table> enable row level security;
create policy "<table>: members read"   on public.<table> for select using (household_id in (select current_household_ids()));
create policy "<table>: members write"  on public.<table> for insert with check (household_id in (select current_household_ids()));
create policy "<table>: members update" on public.<table> for update using (household_id in (select current_household_ids()));
create policy "<table>: members delete" on public.<table> for delete using (household_id in (select current_household_ids()));
```

`households` itself uses `id in (select current_household_ids())`. WS01 also ships `create_household(name)`, `create_invite(household_id)`, and `redeem_invite(token)` as security-definer functions.

Owner-only operations (delete household, remove member, change retailer connections) check `role = 'owner'`. The worker and Edge Functions use the service role and must filter by `household_id` explicitly; pgTAP tests in `supabase/tests/` assert that a member of household A cannot read any row of household B in every table.

## Tables

### Identity

**households**: one per group of people who eat together.
| column | type | notes |
|---|---|---|
| id | uuid pk | |
| name | text | |
| zip | text | For store lookup |
| default_connection_id | uuid → retailer_connections | Nullable |
| created_by | uuid → auth.users | |
| quiet_hours | jsonb | {start, end} in the household's zone; WS11 |
| tier3_consent | jsonb | {accepted_at, by_user_id, retailers[], copy_version}; WS10 |
| ai_daily_cap_usd | numeric default 2.00 | Daily model spend cap; WS15 |

**household_members**
| column | type | notes |
|---|---|---|
| household_id | uuid → households | |
| user_id | uuid → auth.users | |
| role | enum household_members_role: owner, member | |
| invited_by | uuid → auth.users | Nullable |
| pk (household_id, user_id) | | |

**household_invites**: short-lived invite links.
| column | type | notes |
|---|---|---|
| id | uuid pk | |
| household_id | uuid → households | |
| token | text unique | Random, 32 bytes |
| expires_at | timestamptz | 7 days |
| used_by | uuid → auth.users | Nullable |

**audit_events**: who changed what. Written by WS01 (membership), WS07 (connections), WS09 (policy changes).
| column | type | notes |
|---|---|---|
| id | uuid pk | |
| household_id | uuid → households | |
| actor_user_id | uuid → auth.users | Nullable for system actions |
| kind | text | member_added, member_removed, connection_added, connection_revoked, policy_changed, consent_given |
| payload | jsonb | |

**profiles**: per user, not per household.
| column | type | notes |
|---|---|---|
| user_id | uuid pk → auth.users | |
| display_name | text | |
| avatar_url | text | |
| preferences | jsonb | Validated by `core.ProfilePreferences`: diets[], allergies[] (hard), dislikes[], cuisines[], skill (beginner/comfortable/confident), weeknight_minutes, budget_per_week_usd, equipment[], portions, leftovers (avoid/ok/prefer), primaryStoreId, notes. The zod schema and the DIETS and ALLERGENS enums defined in WS06 are canonical |
| onboarding_step | smallint default 0 | WS06 |
| taste_embedding | vector(1024) | Rebuilt weekly from feedback; WS06 |
| costco_member | boolean | Asked in onboarding step 7; WS06 |

### Recipes

**recipes**
| column | type | notes |
|---|---|---|
| id | uuid pk | |
| household_id | uuid → households | Nullable when visibility = catalog |
| title | text | |
| description | text | |
| image_url | text | Storage path or external URL |
| source_type | enum recipes_source_type: url, text, photo, video, manual, ai | |
| source_url | text | Always set for url and video imports; shown as attribution |
| servings | numeric | |
| prep_min, cook_min | int | |
| instructions | jsonb | Array of {step, text, group?} |
| nutrition | jsonb | Per serving, as imported; display only |
| tags | text[] | |
| cuisine | text | |
| embedding | vector(1024) | HNSW index; built from title + tags + ingredient names |
| visibility | enum recipes_visibility: household, catalog | Catalog holds only our own or licensed recipes |

**recipe_ingredients**
| column | type | notes |
|---|---|---|
| id | uuid pk | |
| recipe_id | uuid → recipes | |
| position | int | |
| group_name | text | "For the sauce" |
| raw_text | text | As imported |
| qty | numeric | Nullable ("to taste"). Lower bound when the source line gives a range |
| qty_max | numeric | Nullable. Upper bound of a range ("1 to 2 cups"). List aggregation uses it when present so a list never comes up short. Added 2026-10-30 from the WS03 report |
| unit | text | Canonical unit code from `core/units` |
| ingredient_id | uuid → ingredients | Nullable until parsed |
| prep_note | text | "diced" |
| optional | boolean | |
| parse_confidence | numeric | 0–1 |

**ingredients**: the canonical ontology, global (no household_id, readable by all, writable by service role).
| column | type | notes |
|---|---|---|
| id | uuid pk | |
| name | text unique | Singular, lowercase |
| plural | text | |
| category | text | Store section, one of 16: produce, meat, seafood, dairy, eggs, bakery, pantry, spices, canned, frozen, beverages, snacks, baking, international, household, other |
| default_unit | text | |
| density_g_per_ml | numeric | For volume ↔ weight |
| typical_unit_weight_g | numeric | "1 medium onion" ≈ 110 g |
| usda_fdc_id | int | Optional |
| is_staple_default | boolean | Salt, oil, pepper default to pantry |

**ingredient_aliases**
| column | type | notes |
|---|---|---|
| ingredient_id | uuid → ingredients | |
| alias | text | Lowercase; trigram index |
| source | enum ingredient_aliases_source: seed, llm, user | |

**ingredient_parse_cache**: parser results keyed by normalized raw text (WS03). Global; service-role writes.
| column | type |
|---|---|
| normalized_text | text pk |
| result | jsonb (`core.ParsedIngredient`) |
| source | enum ingredient_parse_cache_source: grammar, llm |
| model, prompt_version | text |

**ingredient_alias_proposals**: unknown ingredients awaiting review (WS03).
| column | type |
|---|---|
| id | uuid pk |
| raw_text | text |
| proposed_name | text |
| proposed_category | text |
| household_id | uuid → households (nullable) |
| status | enum ingredient_alias_proposals_status: pending, accepted, rejected |

### Planning

**meal_plans**: one per household per week. Unique (household_id, week_start).
| column | type |
|---|---|
| id | uuid pk |
| household_id | uuid → households |
| week_start | date |

**meal_plan_entries**
| column | type | notes |
|---|---|---|
| id | uuid pk | |
| plan_id | uuid → meal_plans | |
| household_id | uuid → households | Denormalized for RLS |
| date | date | |
| slot | enum meal_plan_entries_slot: breakfast, lunch, dinner, snack | |
| recipe_id | uuid → recipes | |
| servings | numeric | |
| status | enum meal_plan_entries_status: planned, cooked, skipped | |
| notes | text | |
| position | int | Order within a slot |

**recipe_feedback**
| column | type | notes |
|---|---|---|
| id | uuid pk | |
| household_id | uuid → households | |
| user_id | uuid → auth.users | |
| recipe_id | uuid → recipes | |
| signal | enum recipe_feedback_signal: like, dislike, cooked, skipped, saved | |
| rating | smallint | 1–5, nullable |

### Lists and pantry

**grocery_lists**
| column | type | notes |
|---|---|---|
| id | uuid pk | |
| household_id | uuid → households | |
| plan_id | uuid → meal_plans | Nullable for ad-hoc lists |
| name | text | |
| status | enum grocery_lists_status: draft, active, shopped | |
| built_at | timestamptz | Last aggregation |
| plan_version | int | Detects a plan changed after the build |

**grocery_list_items**
| column | type | notes |
|---|---|---|
| id | uuid pk | |
| list_id | uuid → grocery_lists | |
| household_id | uuid → households | Denormalized for RLS and Realtime filters |
| ingredient_id | uuid → ingredients | Nullable for free-text items |
| display_name | text | "Yellow onions" |
| qty | numeric | Normalized total |
| unit | text | |
| source_entry_ids | uuid[] | meal_plan_entries that contributed; enables re-aggregation after a swap |
| section | text | Aisle group |
| checked | boolean | |
| checked_by | uuid → auth.users | Nullable |
| checked_at | timestamptz | Nullable |
| needs_attention | boolean | Unparsed or ambiguous quantity |
| is_manual | boolean | Added by hand, not from a recipe |
| excluded_reason | enum grocery_list_items_excluded_reason: pantry, manual | Nullable |
| position | int | |

**pantry_items**
| column | type | notes |
|---|---|---|
| household_id | uuid → households | |
| ingredient_id | uuid → ingredients | |
| status | enum pantry_items_status: have, low, out | |
| updated_at | timestamptz | |
| pk (household_id, ingredient_id) | | |

### Retail

**retailer_connections**
| column | type | notes |
|---|---|---|
| id | uuid pk | |
| household_id | uuid → households | |
| user_id | uuid → auth.users | The member whose retailer account this is |
| retailer | enum retailer: kroger, instacart, safeway, costco | |
| auth_type | enum retailer_connections_auth_type: oauth, browser_session, none | |
| vault_secret_id | uuid | Supabase Vault secret holding tokens or session state. Never a password |
| store_id | text | Kroger locationId, Instacart retailer_key, or site-specific store id |
| store_name | text | |
| modality | enum retailer_connections_modality: pickup, delivery | |
| status | enum retailer_connections_status: active, needs_reauth, revoked | |
| last_verified_at | timestamptz | |

**retailer_quota_usage**: daily call counts per retailer endpoint so the worker can budget against Kroger's quotas (WS07). Global.
| column | type |
|---|---|
| retailer | enum retailer |
| endpoint | text |
| day | date |
| count | int |
| pk (retailer, endpoint, day) | |

**product_matches**: learned "always buy X." Stores the user's confirmed choice only. **No price, stock, or search results are stored** (Kroger terms; see `04-integrations.md`).
| column | type | notes |
|---|---|---|
| id | uuid pk | |
| household_id | uuid → households | |
| retailer | enum retailer | |
| store_id | text | |
| ingredient_id | uuid → ingredients | |
| product_id | text | Retailer product id |
| upc | text | |
| product_name | text | As displayed when chosen |
| size | text | |
| confidence | numeric | |
| chosen_by | enum product_matches_chosen_by: agent, user | |
| pinned | boolean | User said "always this" |
| last_chosen_at | timestamptz | |
| unique (household_id, retailer, store_id, ingredient_id, product_id) | | |

**shopping_runs**
| column | type | notes |
|---|---|---|
| id | uuid pk | |
| household_id | uuid → households | |
| list_id | uuid → grocery_lists | |
| connection_id | uuid → retailer_connections | |
| trigger | enum shopping_runs_trigger: manual, scheduled | |
| status | enum shopping_runs_status: queued, running, needs_review, cart_ready, checking_out, checked_out, failed, cancelled | |
| policy | jsonb | `core.RunPolicy`: budget_cap_usd, item_ceiling_usd, substitution (none/same_brand/any), auto_checkout boolean, auto_checkout_cap_usd |
| cart_snapshot | jsonb | The proposed cart shown at review. Expires: cleared by a job 24h after the run closes (Kroger terms) |
| subtotal_usd | numeric | At review time |
| transcript | jsonb | Array of {ts, tool, input, output_summary, screenshot_path?} |
| error | text | |
| started_at, finished_at | timestamptz | |
| heartbeat_at | timestamptz | Worker writes every 30 s while running; WS15 alerts past 10 min |

**shopping_run_items**: one per list item per run. Also the write ledger for add-only carts.
| column | type | notes |
|---|---|---|
| id | uuid pk | |
| run_id | uuid → shopping_runs | |
| household_id | uuid → households | |
| list_item_id | uuid → grocery_list_items | |
| product_id, upc, product_name, size | text | Chosen product |
| qty | numeric | Units to buy |
| unit_price_usd, line_total_usd | numeric | At review time |
| status | enum shopping_run_items_status: proposed, matched, substituted, unmatched, removed | |
| alternatives | jsonb | Up to 3 {product_id, upc, name, size, price} shown at review |
| user_decision | enum shopping_run_items_user_decision: accepted, swapped, removed | Nullable until review |
| delta_sent | numeric | Quantity actually sent to the retailer cart (sum of adds and negative corrections) |
| sent_at | timestamptz | |
| delta_result | text | "204", or the error |

**orders**: recorded from the ledger plus the user's confirmation; no retailer exposes order history via public API. Owned by WS12; WS09 does not create it.
| column | type | notes |
|---|---|---|
| id | uuid pk | |
| household_id | uuid → households | |
| run_id | uuid → shopping_runs | |
| retailer | enum retailer | |
| retailer_order_id | text | Nullable; user may paste it |
| modality | enum retailer_connections_modality | |
| slot_start, slot_end | timestamptz | Nullable |
| total_usd | numeric | User-entered or from Tier 3 confirmation page |
| confirmed_by | uuid → auth.users | |
| confirmed_at | timestamptz | |
| notes | text | |
| unique (run_id) | | One order per run |
| status | enum orders_status: confirmed, picked_up, delivered, cancelled | |
| raw | jsonb | Tier 3 confirmation details |

**scheduled_runs**
| column | type | notes |
|---|---|---|
| id | uuid pk | |
| household_id | uuid → households | |
| cron | text | Standard 5-field cron in the household's time zone |
| tz | text | IANA zone |
| connection_id | uuid → retailer_connections | |
| policy | jsonb | `core.RunPolicy` |
| next_run_at | timestamptz | |
| last_enqueued_for | timestamptz | The `next_run_at` value already enqueued; idempotency guard |
| enabled | boolean | |

**push_tokens** (WS11)
| column | type |
|---|---|
| user_id | uuid → auth.users |
| token | text |
| platform | enum push_tokens_platform: ios, android, web |
| updated_at | timestamptz |
| pk (user_id, token) | |

**notification_preferences** (WS11): per user, per type.
| column | type |
|---|---|
| user_id | uuid → auth.users |
| type | enum notification_type: cart_ready, items_need_review, pickup_reminder, weekly_nudge, import_finished |
| enabled | boolean default true |
| pk (user_id, type) | |

**notification_outbox** (WS11): rows written by triggers or jobs; a one-minute pg_cron job drains it through the `send-push` Edge Function.
| column | type |
|---|---|
| id | uuid pk |
| household_id | uuid → households |
| type | enum notification_type |
| payload | jsonb |
| deliver_after | timestamptz |
| sent_at | timestamptz |
| attempts | int |

### Ops

**ai_runs**: one row per model call.
| column | type |
|---|---|
| id | uuid pk |
| household_id | uuid → households (nullable for system jobs) |
| kind | text (parse_ingredients, extract_recipe, suggest, agent_step, embed, …) |
| model | text |
| prompt_version | text |
| input_tokens, output_tokens, cache_read_tokens | int |
| cost_usd | numeric |
| latency_ms | int |
| ok | boolean |
| error | text |

**import_jobs**
| column | type |
|---|---|
| id | uuid pk |
| household_id | uuid → households |
| kind | enum import_jobs_kind: url, text, photo, caption |
| input | jsonb |
| status | enum import_jobs_status: queued, running, done, failed |
| result_recipe_id | uuid → recipes |
| error | text |

**waitlist**: marketing site sign-ups (WS14). No household_id; insert-only for anon, read for service role.
| column | type |
|---|---|
| id | uuid pk |
| email | text unique |
| zip | text |
| source | text |

### Views

| View | Purpose | WS |
|---|---|---|
| `v_meals_cooked_weekly` | Cooked entries per household per week | WS12 |
| `v_spend_weekly_by_store` | Sum of order totals per household, week, retailer | WS12 |
| `v_most_bought_products` | Product counts from accepted run items | WS12 |
| `v_ai_cost_daily` | `ai_runs` cost per household per day | WS15 |
| `v_ai_cost_by_prompt` | Cost and latency per prompt version | WS15 |

## Retention and retailer-terms constraints

Kroger's developer terms prohibit caching catalog data beyond response cache headers, building a product database, storing data derived from customer searches or cart adds, and keeping cart display data after the session. The data model respects this as follows:

- `product_matches` stores only the user's confirmed choice (ids, name, size). Price and stock are fetched live every run.
- `shopping_run_items` prices are "the price at review time for this household's own run," kept as the household's purchase record, and `cart_snapshot` is cleared 24 hours after the run closes.
- No table stores raw search results. Catalog responses live only in memory during a run, bounded by their cache headers.
- Price trends for pinned items are deferred until Kroger clarifies R21 (see `06-risks.md`).

Instacart's terms require deleting Instacart-sourced data within five business days on request. The Instacart adapter never writes retailer data to the database (it only generates links), so there is nothing to delete beyond `retailer_connections.store_id`.

## Indexes worth creating up front

- `recipes (household_id)`, `recipes using hnsw (embedding vector_cosine_ops)`
- `recipe_ingredients (recipe_id, position)`, `recipe_ingredients (ingredient_id)`
- `ingredient_aliases using gin (alias gin_trgm_ops)`
- `meal_plan_entries (plan_id, date)`, `grocery_list_items (list_id, position)`
- `shopping_runs (household_id, created_at desc)`, `shopping_run_items (run_id)`
- `ai_runs (household_id, created_at)`

## Migration ownership

Files are created with `supabase migration new <name>` and carry a timestamp prefix. The logical order and owners:

| Order | Name | Tables and objects | WS |
|---|---|---|---|
| 1 | extensions | pgcrypto, pg_trgm, vector, pgmq, pg_cron | WS00 |
| 2 | identity | households, household_members, household_invites, profiles (base columns), audit_events, Storage bucket `avatars` | WS01 |
| 3 | identity_functions | `current_household_ids()`, `create_household()`, `create_invite()`, `redeem_invite()` | WS01 |
| 4 | recipes | recipes, recipe_ingredients, import_jobs, Storage bucket `recipe-images` | WS02 |
| 5 | ai_runs | ai_runs | WS02 (first LLM caller) |
| 6 | ingredients | ingredients, ingredient_aliases, ingredient_parse_cache, ingredient_alias_proposals | WS03 |
| 7 | planning | meal_plans, meal_plan_entries, recipe_feedback | WS04 |
| 8 | lists | grocery_lists, grocery_list_items, pantry_items, Realtime publication | WS05 |
| 9 | retail | retailer_connections, product_matches, retailer_quota_usage, FK `households.default_connection_id` → `retailer_connections` | WS07 |
| 10 | ws06_preferences | profiles.preferences, onboarding_step, taste_embedding, costco_member | WS06 |
| 11 | runs | shopping_runs, shopping_run_items, pgmq queue `shopping_run` | WS09 |
| 12 | tier3 | households.tier3_consent, Storage bucket `run-screenshots` | WS10 |
| 13 | schedules_notifications | scheduled_runs, push_tokens, notification_preferences, notification_outbox, households.quiet_hours, pg_cron jobs | WS11 |
| 14 | orders_and_history | orders, the three history views | WS12 |
| 15 | waitlist | waitlist | WS14 |
| 16 | observability | households.ai_daily_cap_usd, shopping_runs.heartbeat_at, `shopping_run_dlq` queue, cost views | WS15 |

A builder who needs a column on a table it does not own files a contract change request in its completion report. The orchestrator applies the migration on `main`.
