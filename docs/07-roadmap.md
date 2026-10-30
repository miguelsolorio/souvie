# 07 · Roadmap

Five phases, run as seven dependency waves. The orchestrator dispatches one wave at a time; everything inside a wave runs in parallel. Human checkpoints are listed in `implementation-guide.md`.

## Phases

| Phase | Goal | Workstreams | You can… |
|---|---|---|---|
| 0 · Foundation | Repo, app shell, backend, auth, CI | WS00, WS01 | Sign in on iOS and web, create a household, invite a member |
| 1 · Plan → list | Recipes, import, parser, planner, grocery list | WS02, WS03, WS04, WS05 | Import recipes, plan a week, shop from a shared list in the store, with no retailer integration |
| 2 · Shop | Onboarding, suggestions, adapters, Kroger, Instacart, agent, scheduling | WS06, WS07, WS08, WS09, WS11 | Onboard, get a curated week, have the agent fill the QFC cart on Saturday morning, pay in the QFC app |
| 3 · Hands-off and history | Browser adapters behind a flag; orders and spend | WS10, WS12 | Opt in to assisted checkout at Safeway or Costco; see spend per week |
| 4 · Platforms and brand | Web deploy, Tauri desktop, marketing site, store assets, observability | WS13, WS14, WS15 | Use it on the desktop; decide whether to open a public beta |

## Waves

| Wave | Workstreams | Why this grouping |
|---|---|---|
| 0 | WS00 | Everything depends on the scaffold, conventions, and CI |
| 1 | WS01, WS03, WS14 | Auth, the ingredient ontology, and brand share no files |
| 2 | WS02, WS07 | Recipe import needs auth; the Kroger adapter needs auth and the scaffold's secrets pattern |
| 3 | WS04, WS06, WS08 | Planner needs recipes; onboarding needs recipes and the ontology; Instacart needs the adapter contract |
| 4 | WS05 | The grocery list needs planner entries and the parser |
| 5 | WS09 | The agent needs the list, the adapter, and the review UI surfaces |
| 6 | WS10, WS11, WS12, WS13, WS15 | All consume the agent and run model; none touch each other's files |

## Week-one external tasks (human)

These have lead times and gate later waves. Start them before wave 0 finishes.

1. Register the Kroger developer app at developer.kroger.com. Record the client id and secret in `.env.local` only. Needed before WS07.
2. Submit the Instacart Developer Platform application. On 2026-10-29 the marketing page said "not accepting new applications" while the docs still said "Apply today"; submit anyway and record the response in `status.md`. A dev key works without approval; production approval takes about 30–40 days. Needed before WS08 production.
3. Run the name shortlist in `08-brand.md` through USPTO TESS, App Store, domain, npm, and GitHub checks. Needed before WS14 finishes.
4. Create the Supabase project (Pro tier once in daily use), the Fly.io or Railway account for the worker, the Expo/EAS account, Sentry and PostHog projects. WS00 needs the Supabase project URL and anon key.

## Definition of done per phase

- **Phase 0:** CI green; sign in works on iOS simulator and web; RLS tests pass; human checkpoint 1 approved.
- **Phase 1:** 45 of 50 golden URLs import; parser thresholds met; a week can be planned and a list built; two household members see the same list update in realtime; list works with the device offline.
- **Phase 2:** Onboarding produces a valid profile and a first plan; a scheduled run fills a real QFC cart on a Saturday and the owner receives the "cart ready" notification; the deep link lands on Kroger checkout with the items present.
- **Phase 3:** An opted-in household completes a Safeway or Costco assisted checkout in Mode A with the agent stopping at pay; orders and spend views populate from the ledger.
- **Phase 4:** Web deployed; Tauri app runs; landing page live with waitlist; evals gate CI; public-beta decision made with the name chosen.

## Beyond v1 (not planned here)

Billing and the Kroger Partnership Request; public recipe catalog; nutrition tracking; staging environment; ACP or UCP checkout adapter when a grocer accepts third-party agents; Tier 3 Mode B for unattended scheduled checkout.
