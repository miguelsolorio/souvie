# 07 · Roadmap

Five phases, run as seven dependency waves. The orchestrator dispatches one wave at a time; everything inside a wave runs in parallel. Human checkpoints are listed in `implementation-guide.md`.

## Phases

| Phase | Goal | Workstreams | You can… |
|---|---|---|---|
| 0 · Foundation | Repo, app shell, backend, auth, CI | WS00, WS01 | Sign in on iOS and web, create a household, invite a member |
| 1 · Plan → list | Recipes, import, parser, planner, grocery list | WS02, WS03, WS04, WS05 | Import recipes, plan a week, shop from a shared list in the store, with no retailer integration |
| 2 · Shop | Onboarding, suggestions, adapters, Kroger, the assisted-checkout host, agent, scheduling | WS06, WS07, WS08, WS09, WS11 | Onboard, get a curated week, have the agent fill the QFC cart on Saturday morning, pay in the QFC app |
| 3 · Agent checkout and history | Browser adapters for Safeway, Costco, and Kroger pay; orders and spend | WS10, WS12 | Watch the agent fill a Safeway or Costco cart in the app and stop at pay; see spend per week |
| 4 · Platforms and brand | Web deploy, Tauri desktop, marketing site, store assets, observability | WS13, WS14, WS15 | Use it on the desktop; decide whether to open a public beta |

## Waves

| Wave | Workstreams | Why this grouping |
|---|---|---|
| 0 | WS00 | Everything depends on the scaffold, conventions, and CI |
| 1 | WS01, WS03, WS14 | Auth, the ingredient ontology, and brand share no files |
| 2 | WS02, WS07 | Recipe import needs auth; the Kroger adapter needs auth and the scaffold's secrets pattern |
| 3 | WS04, WS06, WS08 | Planner needs recipes; onboarding needs recipes and the ontology; the assisted-checkout host needs the adapter contract and auth, not the agent |
| 4 | WS05 | The grocery list needs planner entries and the parser |
| 5 | WS09 | The agent needs the list, the adapter, and the review UI surfaces |
| 6 | WS10, WS11, WS12, WS13, WS15 | All consume the agent and run model; WS10 also builds on the WS08 host; none touch each other's files |

## Week-one external tasks (human)

These have lead times and gate later waves. Start them before wave 0 finishes.

1. Register the Kroger developer app at developer.kroger.com. Record the client id and secret in `.env.local` only. Needed before WS07.
2. Write the Tier 3 consent copy draft so checkpoint 4 can approve it before WS08. Instacart's application was dropped on 2026-10-30 (platform closed).
3. Run the name shortlist in `08-brand.md` through USPTO TESS, App Store, domain, npm, and GitHub checks. Needed before WS14 finishes.
4. Create the Supabase project (Pro tier once in daily use), the Fly.io or Railway account for the worker, the Expo/EAS account, Sentry and PostHog projects. WS00 needs the Supabase project URL and anon key.

## Definition of done per phase

- **Phase 0:** CI green; sign in works on iOS simulator and web; RLS tests pass; human checkpoint 1 approved.
- **Phase 1:** 45 of 50 golden URLs import; parser thresholds met; a week can be planned and a list built; two household members see the same list update in realtime; list works with the device offline.
- **Phase 2:** Onboarding produces a valid profile and a first plan; a scheduled run fills a real QFC cart on a Saturday and the owner receives the "cart ready" notification; the deep link lands on Kroger checkout with the items present.
- **Phase 2** also: the WS08 host drives a test page in the iOS Simulator and a household can connect Safeway with consent recorded.
- **Phase 3:** A household completes a Safeway or Costco checkout in Mode A with the agent stopping at pay; orders and spend views populate from the ledger.
- **Phase 4:** Web deployed; Tauri app runs; landing page live with waitlist; evals gate CI; public-beta decision made with the name chosen.

## Beyond v1 (not planned here)

Billing and the Kroger Partnership Request; public recipe catalog; nutrition tracking; staging environment; ACP or UCP checkout adapter when a grocer accepts third-party agents; Tier 3 Mode B for unattended scheduled checkout.
