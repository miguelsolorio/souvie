# TODO: next steps

The working checklist for the build. The orchestrator reads this file first, checks items off as they complete (edit this file), and keeps `docs/status.md` as the detailed ledger. Items marked **(human)** are Miguel's. Everything else is the orchestrator's.

How this file relates to the others: `docs/implementation-guide.md` says *how* to do each step (templates, rules). `docs/status.md` records *what happened*. This file says *what's next*.

## 0. Before the first orchestrator session (human)

- [x] Git identity pinned to the Gmail account for this clone (`scripts/setup-git-identity.sh`). Run it again on any fresh clone before the first commit.
- [x] Create the Supabase project. Put `EXPO_PUBLIC_SUPABASE_URL`, `EXPO_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, and `WORKER_DATABASE_URL` in a local `.env.local`. Never commit it.
- [x] Register the Kroger developer app at developer.kroger.com with redirect URI `souvie://oauth/kroger`. Put `KROGER_CLIENT_ID` and `KROGER_CLIENT_SECRET` in `.env.local`. (Gates wave 2.)
- [ ] Create accounts: Expo/EAS (dev builds for WS08's WebView host and WS09's review UI), Fly.io or Railway (WS09 worker deploy), Cloudflare Pages (marketing site, WS13 web, the Tier 3 test page), Sentry, PostHog (WS08's `tier3_browser_checkout` kill switch; the flag stays on without it). Put `SENTRY_DSN` and `EXPO_PUBLIC_POSTHOG_KEY` in `.env.local` when they exist.
- [x] Optional now, required before WS14 finishes: run the name checks in `docs/08-brand.md` §1.3 for Sous and Larder.
- [x] Decide where `main` lives. Either create a GitHub repository and push `main` (enables PRs and GitHub Actions as the docs assume), or tell the orchestrator you're staying local (then CI is the same commands run locally and merges are local squash merges; no PRs).
- [x] Open a Claude Code session in this folder with Fable as the model and paste the kickoff prompt at the bottom of this file.

## 1. Wave 0: scaffold

- [x] Bootstrap per `docs/implementation-guide.md` §1: read `CLAUDE.md`, this file, the guide, `docs/status.md`, `docs/07-roadmap.md` §Waves.
- [x] Confirm the Supabase credentials exist locally (ask the human; do not look for secrets in the repo).
- [x] Dispatch the WS00 builder: Agent tool, `isolation: "worktree"`, `model: "opus"`, prompt from guide §6.1 pointing at `docs/workstreams/WS00-scaffold.md`. Set WS00 to `in progress` in `docs/status.md`.
- [x] Receive the completion report. Reject it if the Verification output section is missing real command output.
- [x] Dispatch the WS00 reviewer: `model: "sonnet"`, `isolation: "worktree"`, prompt from guide §6.3. Do not hand it the builder's report.
- [x] Act on the verdict: merge (squash into `main`, delete branch), or one fix round with the same builder, or escalate.
- [x] Update `docs/status.md`: row to `merged`, wave 0 summary written.
- [x] **Stop. Human checkpoint 1:** approve scaffold choices (package names, lint rules, CI shape, Node and pnpm versions). Approved 2026-10-30.

## 2. Wave 1: identity, ontology, brand

- [x] Dispatch WS01 (sonnet), WS03 (sonnet), WS14 (sonnet) in one message, each in its own worktree.
- [x] Review each as it finishes. WS03 and WS14 can merge on a pass.
- [x] **Human checkpoint 2** before WS01 merges: approve the identity migration and RLS policies. Approved 2026-10-30.
- [x] **Human checkpoint 6** before WS14 finishes: the name. Souvie, chosen 2026-10-30; the name-swap round is dispatched.
- [x] Wave 1 summary in `docs/status.md`.

## 3. Wave 2: recipes and Kroger

- [x] Dispatch WS02 (sonnet) right away.
- [x] **Human checkpoint 3** gates WS07 only: Kroger app registered, credentials in `.env.local`. Then dispatch WS07 (opus). Met 2026-10-30 (redirect `souvie://oauth/kroger`); WS07 dispatched.
- [x] WS07 reviewer must run the Kroger compliance checklist in `docs/04-integrations.md`. Done 2026-10-30 (terms retention and quota findings came out of it).
- [x] Review, merge, wave 2 summary. Closed 2026-10-30.

## 4. Wave 3: planner, onboarding, assisted-checkout host

- [x] Dispatch WS04 and WS06 (sonnet) right away. Dispatched 2026-10-30.
- [x] Draft the Tier 3 consent copy (names each retailer, the terms risk, the account exposure, "stops at pay") and put it in front of Miguel. Drafted 2026-10-31 in `docs/08-brand.md` §11; approved as drafted 2026-10-31.
- [x] **Human checkpoint 4** gates WS08 only: consent copy approved; Tier 3 retailer list confirmed (WS08's `TIER3_RETAILERS` default is Safeway, Albertsons, Haggen, Costco; the Kroger pay adapter is a WS10 adapter, not a consent retailer). Then dispatch WS08 (opus). Approved 2026-10-31 (copy as drafted, four stores); WS08 dispatched (opus).
- [ ] WS08 reviewer must run the Tier 3 checklist in `docs/04-integrations.md` and confirm no playwright or puppeteer dependency.
- [ ] WS05 follow-up round (jsonb parameters double-encoded on real Postgres; blocks "Build grocery list" on the hosted project; brief section at the end of WS05's file): review, merge, redeploy `list-build`, Miguel retries.
- [ ] WS04 follow-up round (picker entry points, from Miguel's test 2026-10-31): review, merge.
- [ ] WS02 follow-up round (validation on add, no duplicate recipes or ingredient lines; brief section at the end of WS02's file, requested by Miguel 2026-10-31): dispatch after the WS04 round merges, review, merge.
- [ ] WS04 simple-mode round (one meal a day, household setting `plan_mode` default simple, asked in onboarding step 1; brief section at the end of WS04's file, requested by Miguel 2026-10-31): orchestrator lands `PlanMode`, `slotsForMode` and the `households.plan_mode` migration first, then dispatch after the picker round merges, review, merge.
- [ ] WS08: review, merge, append to the wave 3 summary. Then `pnpm install` in the orchestrator worktree (native modules change the lockfile) and a `git pull` in the primary checkout.
- [x] **Human decision:** recipe catalog cold start. Miguel chose a starter catalog 2026-10-30; WS16 brief written and dispatched.
- [x] WS16 (starter catalog, sonnet): reviewed and merged as 4fb32da (PR #13), 2026-10-30.
- [ ] **Human:** Miguel skims `supabase/seed/catalog/README.md` before the catalog loads into the hosted project (with the hosted release).
- [x] Orchestrator migration `20261030140000_recipes_catalog_read.sql` (catalog read policies) merged as c152769 (PR #11).
- [x] Review, merge, wave 3 summary (WS04, WS06, WS16 merged 2026-10-30; WS08 appended when it lands).

## 5. Wave 4: grocery list

- [x] CCR5: `containerCount` and `container` in `packages/core` (orchestrator) before dispatch. Merged 2026-10-30 as 6fde545 (PR #14); row-schema addendum merged as a1f37c4 (PR #15).
- [x] Dispatch WS05 (sonnet). Dispatched 2026-10-30.
- [x] WS05: review, merge, wave 4 summary. Merged 2026-10-31 as b9522ce (PR #16); summary in `docs/status.md`.
- [ ] **Human (with the hosted release):** `supabase functions deploy list-build --use-api` once the token scopes allow, then one hosted build as the smoke test.

## 6. Wave 5: the shopping agent

- [x] CCR6: `RunPolicy` in `packages/core` and `RetailerAdapter.checkout` typed to it (orchestrator). Merged 2026-10-31 as e0053e7 (PR #17).
- [x] WS09 brief corrections written (2026-10-31): service-role decision, `push_tokens`, docs/03 numbers, as-built facts.
- [x] Dispatch WS09 (opus). Dispatched 2026-10-31. Expect contract change requests here; apply them on `main` yourself.
- [ ] Review with extra attention to policies-in-code, the write ledger, the allergen check, and the service-role authorization in `run-approve` and the worker (a caller must never act for a household they are not in).
- [ ] Merge, summary. This is the Phase 2 moment: a scheduled run should fill a real QFC cart (criterion 13 needs Miguel's Kroger sign-in; it stays open until then).
- [ ] Orchestrator contract change after WS09 merges: remove `instacart` from `RetailerId`, `INSTACART_CAPABILITIES`, the registry tests and the `retailer` enum (new migration that recreates the enum), with docs/02 and docs/04 updated. Deferred so no in-flight builder sees the enum move.
- [ ] **Human (with the hosted release):** deploy `run-approve` and `llm-proxy`, set the worker secrets, and deploy the worker to Fly.io or Railway once the account exists.

## 7. Wave 6: everything that consumes the agent

- [ ] **Human checkpoint 5** gates WS10 only: the WS08 host demo is accepted (agent drives a test page in the Simulator; consent and disconnect work). The other four may start without it.
- [ ] Dispatch WS10 (opus), WS11, WS12, WS13, WS15 (sonnet) in one message. Five builders at once is the maximum. WS10 needs WS08 and WS09 merged; the other four need WS09 merged. Write each brief's orchestrator corrections first (as-built shapes from WS05, WS08 and WS09).
- [ ] Review each as it finishes. WS10 reviewer runs the Tier 3 checklist and a manual Safeway run on a real account.
- [ ] Merge all, wave 6 summary.

## 8. Done

- [ ] All sixteen rows in `docs/status.md` read `merged`.
- [ ] `pnpm typecheck && pnpm lint && pnpm test && pnpm eval` and `supabase test db` pass on `main`.
- [ ] The household runs the loop end to end: onboard → plan → list → QFC cart filled by a scheduled run → notification → pay in the QFC app. And at Safeway: the agent fills the cart in the app and stops at pay.
- [ ] Docs updated to match what was built. Public-beta decision and name recorded, or recorded as deferred.

## Human items open now (2026-10-31)

Collected from the ledger so one list is enough. Each unblocks something named.

- [x] Hosted database: the 15 migrations and the ontology seed (751 ingredients, 4103 aliases) were applied on 2026-10-31 with `pnpm supabase db push --db-url` over `WORKER_DATABASE_URL`, which needs no access token. 24 public tables, pgmq, vector, pg_cron, pg_trgm present; buckets `avatars` and `recipe-images`.
- [x] Hosted functions and secrets, 2026-10-31: all seven Edge Functions (`health`, `export-data`, `parse-ingredients`, `recipe-import`, `retailer-oauth`, `suggest`, `list-build`) deployed with `functions deploy <name> --use-api --project-ref <ref>`, and the secrets `ANTHROPIC_API_KEY`, `AI_DAILY_CAP_USD=2`, `KROGER_CLIENT_ID`, `KROGER_CLIENT_SECRET`, `KROGER_REDIRECT_URI` set. `health` answers 200 over HTTPS. The token is a scoped one: it lacks `projects_read` and `organizations_read` (so `supabase link` fails) but has the function and secret permissions, so `--project-ref` is enough.
- [ ] Optional: a token with `projects_read` if `supabase link` is ever wanted; nothing in the release needs it now.
- [ ] `VOYAGE_API_KEY` as a function secret once Miguel has one (`pnpm supabase secrets set --project-ref <ref> VOYAGE_API_KEY=...`). Suggestions already run without it (no profile embeddings); `EXPO_PUBLIC_SUGGEST_ENABLED=1` was added to `.env.local` on 2026-10-31.
- [ ] Supabase dashboard, Authentication, URL Configuration: Site URL `http://localhost:8081`; redirect URLs `http://localhost:8081/**`, `souvie://**`, `exp://**`. Needed before magic-link sign-in works from the dev server.
- [ ] Skim `supabase/seed/catalog/README.md`, then say so: the orchestrator loads `supabase/seed/20_catalog.sql` into the hosted project the same way (the schema is ready; `catalog recipes: 0` today).
- [ ] Kroger sign-in: after `git pull` in the primary checkout, `pnpm --filter @mp/retailers kroger:login`. Unblocks WS07 criterion 12 (live cart add) and WS09 criterion 13 (real QFC run).
- [ ] `VOYAGE_API_KEY` in `.env.local`. Unblocks live embeddings for `suggest`.
- [x] `git pull` in `/Users/miguelsolorio/dev/meal-planner`. Current at b946a60 on 2026-10-31.
- [x] The `sous-brand-naming-493e8f` worktree (session archived, PR #18 merged) was removed on 2026-10-31 along with its merged branch `docs/ledger-souvie-rows` and the superseded `claude/sous-brand-naming-493e8f` (a27faa1), at Miguel's request.
- [ ] Apple and Google sign-in providers in Supabase Auth (WS01 criterion 3).
- [ ] Cloudflare Pages project for `apps/marketing` (WS14 deploy) and later the Tier 3 test page.
- [ ] Privacy contact address and route for the marketing footer (WS14 deploy-gates round).
- [ ] Optional: re-pin the repo's git origin in the desktop app (Help → Troubleshooting → Review Pinned Git Origins) so Auto-fix can merge main into PR branches.

- [x] `pnpm` on this Mac: `corepack enable --install-directory /opt/homebrew/bin pnpm` and `corepack prepare pnpm@9.15.9 --activate` run 2026-10-31, so `pnpm dev` works in a plain shell (README "Getting started" says why).

## Standing rules while working

These are the "stay on task" rules. They repeat the guide on purpose.

1. One wave in flight. Do not pre-dispatch the next wave's builders. A workstream held at a human checkpoint from an earlier wave starts as soon as the checkpoint clears, even beside the current wave (WS08 beside WS09 on 2026-10-31).
2. Read completion reports, never agent transcripts or output files.
3. Update `docs/status.md` and tick this file in the same turn as the event, not at the end of the wave.
4. Builders never edit `packages/core`, the `RetailerAdapter` interface, or tables they don't own. You apply contract changes on `main` in your own small commits.
5. Stop at the seven human checkpoints and nowhere else, unless something is `blocked`.
6. No feature code by the orchestrator. The only code you write is shared-contract changes (`packages/core`, `RetailerAdapter`, cross-cutting migrations) in small commits on `main`. If you catch yourself writing anything else, stop and dispatch a builder.
7. When your context feels long, write the wave summary, tick this file, and tell the human to start a fresh session with the resume prompt below.
8. Usage pacing (Miguel, 2026-10-31): before dispatching or resuming any agent, read the plan usage (the desktop app's `get_usage` tool). At 98 percent of any window, dispatch and resume nothing, let running agents finish, and schedule a one-shot wake-up for two minutes after that window resets to resume whatever stopped. An agent stopped by a rate limit is resumed with a message, never redispatched. A fresh session recreates the 20-minute usage check, which expires after seven days.

## Kickoff prompt (new session, model: Fable)

```
Read CLAUDE.md, TODO.md, docs/implementation-guide.md, and docs/status.md, in that order. You are the orchestrator for this repo: you dispatch builder and reviewer agents per the guide and write no feature code yourself (shared contracts are the one exception). First, confirm which items in TODO.md section 0 are done and ask me for anything missing. Then start wave 0 by dispatching the WS00 builder exactly as the guide's section 6.1 template specifies. Keep TODO.md and docs/status.md current as you go. Stop only at the human checkpoints listed in the guide's section 5.
```

## Resume prompt (any later session)

```
Read CLAUDE.md, TODO.md, docs/implementation-guide.md, and docs/status.md. You are resuming as the orchestrator. Before dispatching anything, check every ws/* branch and open PR against the ledger, since a builder may have finished while no session was watching. Tell me in two lines where things stand, then continue the current wave.
```
