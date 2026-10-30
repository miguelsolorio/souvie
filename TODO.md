# TODO: next steps

The working checklist for the build. The orchestrator reads this file first, checks items off as they complete (edit this file), and keeps `docs/status.md` as the detailed ledger. Items marked **(human)** are Miguel's. Everything else is the orchestrator's.

How this file relates to the others: `docs/implementation-guide.md` says *how* to do each step (templates, rules). `docs/status.md` records *what happened*. This file says *what's next*.

## 0. Before the first orchestrator session (human)

- [x] Git identity pinned to the Gmail account for this clone (`scripts/setup-git-identity.sh`). Run it again on any fresh clone before the first commit.
- [x] Create the Supabase project. Put `EXPO_PUBLIC_SUPABASE_URL`, `EXPO_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, and `WORKER_DATABASE_URL` in a local `.env.local`. Never commit it.
- [x] Register the Kroger developer app at developer.kroger.com with redirect URI `mealplanner://oauth/kroger`. Put `KROGER_CLIENT_ID` and `KROGER_CLIENT_SECRET` in `.env.local`. (Gates wave 2.)
- [ ] Submit the Instacart Developer Platform application at company.instacart.com/business/developers. Record the response in `docs/status.md` under External tasks. (Gates WS08 production; a dev key works without approval.)
- [ ] Create accounts: Expo/EAS, Fly.io or Railway (worker), Cloudflare Pages (web and marketing), Sentry, PostHog. Put `ANTHROPIC_API_KEY`, `SENTRY_DSN`, `EXPO_PUBLIC_POSTHOG_KEY` in `.env.local`.
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
- [ ] **Human checkpoint 2** before WS01 merges: approve the identity migration and RLS policies.
- [ ] **Human checkpoint 6** before WS14 finishes: the name. If the human isn't ready, let WS14 land everything except the name and leave the row `in review` with a note.
- [ ] Wave 1 summary in `docs/status.md`.

## 3. Wave 2: recipes and Kroger

- [ ] Dispatch WS02 (sonnet) right away.
- [ ] **Human checkpoint 3** gates WS07 only: Kroger app registered, credentials in `.env.local`. Then dispatch WS07 (opus).
- [ ] WS07 reviewer must run the Kroger compliance checklist in `docs/04-integrations.md`.
- [ ] Review, merge, wave 2 summary.

## 4. Wave 3: planner, onboarding, Instacart

- [ ] Dispatch WS04 and WS06 (sonnet) right away.
- [ ] **Human checkpoint 4** gates WS08 only: Instacart application status known; `INSTACART_API_KEY` (dev) in `.env.local`. Then dispatch WS08 (sonnet).
- [ ] WS08 reviewer must run the Instacart compliance checklist.
- [ ] Review, merge, wave 3 summary.

## 5. Wave 4: grocery list

- [ ] Dispatch WS05 (sonnet). Review, merge, summary.

## 6. Wave 5: the shopping agent

- [ ] Dispatch WS09 (opus). Expect contract change requests here; apply them on `main` yourself.
- [ ] Review with extra attention to policies-in-code, the write ledger, and the allergen check.
- [ ] Merge, summary. This is the Phase 2 moment: a scheduled run should fill a real QFC cart.

## 7. Wave 6: everything that consumes the agent

- [ ] **Human checkpoint 5** before dispatch: Tier 3 consent copy approved; which retailers get browser adapters.
- [ ] Dispatch WS10 (opus), WS11, WS12, WS13, WS15 (sonnet) in one message. Five builders at once is the maximum.
- [ ] Review each as it finishes. WS10 reviewer runs the Tier 3 checklist.
- [ ] Merge all, wave 6 summary.

## 8. Done

- [ ] All sixteen rows in `docs/status.md` read `merged`.
- [ ] `pnpm typecheck && pnpm lint && pnpm test && pnpm eval` and `supabase test db` pass on `main`.
- [ ] The household runs the loop end to end: onboard → plan → list → QFC cart filled by a scheduled run → notification → pay in the QFC app.
- [ ] Docs updated to match what was built. Public-beta decision and name recorded, or recorded as deferred.

## Standing rules while working

These are the "stay on task" rules. They repeat the guide on purpose.

1. One wave in flight. Do not pre-dispatch the next wave's builders.
2. Read completion reports, never agent transcripts or output files.
3. Update `docs/status.md` and tick this file in the same turn as the event, not at the end of the wave.
4. Builders never edit `packages/core`, the `RetailerAdapter` interface, or tables they don't own. You apply contract changes on `main` in your own small commits.
5. Stop at the seven human checkpoints and nowhere else, unless something is `blocked`.
6. No feature code by the orchestrator. The only code you write is shared-contract changes (`packages/core`, `RetailerAdapter`, cross-cutting migrations) in small commits on `main`. If you catch yourself writing anything else, stop and dispatch a builder.
7. When your context feels long, write the wave summary, tick this file, and tell the human to start a fresh session with the resume prompt below.

## Kickoff prompt (new session, model: Fable)

```
Read CLAUDE.md, TODO.md, docs/implementation-guide.md, and docs/status.md, in that order. You are the orchestrator for this repo: you dispatch builder and reviewer agents per the guide and write no feature code yourself (shared contracts are the one exception). First, confirm which items in TODO.md section 0 are done and ask me for anything missing. Then start wave 0 by dispatching the WS00 builder exactly as the guide's section 6.1 template specifies. Keep TODO.md and docs/status.md current as you go. Stop only at the human checkpoints listed in the guide's section 5.
```

## Resume prompt (any later session)

```
Read CLAUDE.md, TODO.md, docs/implementation-guide.md, and docs/status.md. You are resuming as the orchestrator. Before dispatching anything, check every ws/* branch and open PR against the ledger, since a builder may have finished while no session was watching. Tell me in two lines where things stand, then continue the current wave.
```
