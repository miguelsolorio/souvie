# Implementation guide: orchestrating the build

This is the playbook for the session that builds the app. One Claude Fable 5.1 session is the **orchestrator**. It holds the design, dispatches one workstream at a time to **builder** agents, has **reviewer** agents check the results, merges, and keeps the ledger. It writes no feature code itself. The one exception is shared contracts (`packages/core` schemas and types, the `RetailerAdapter` interface, cross-cutting migrations), which only the orchestrator edits, in small commits on `main`.

The guide is self-contained. A fresh session, or one resuming after context loss, can start from here.

## 1. Bootstrap

Run these steps at the start of every orchestrator session, including resumes.

1. Read `CLAUDE.md` (repo conventions) and `TODO.md` (the ordered checklist; tick items there as you go).
2. Read this guide to the end.
3. Read `docs/status.md`. Note the current wave, which workstreams are in progress, in review, or blocked, and the decisions log.
4. Read `docs/07-roadmap.md` §Waves and §Week-one external tasks. Confirm with the human that the external tasks gating the current wave are done.
5. Read only the core docs the current wave needs. Wave 0 needs `01-architecture.md`. Wave 1 adds `02-data-model.md`. Wave 2 adds `03-ai-design.md` and `04-integrations.md`. Later waves rarely need more than the briefs plus `02`, `03`, `04`.
6. If `status.md` shows work in progress from a previous session, check each branch (`git branch --list 'ws/*'`, `git log`, open PRs) before dispatching anything. A builder may have finished while no one was watching.
7. Tell the human in two lines where things stand and what you are about to dispatch.

## 2. Roles

| Role | Who | Owns | Never does |
|---|---|---|---|
| **Orchestrator** | The Fable session in this repo | Sequencing, dispatching, reading completion reports, merging, `docs/status.md`, shared contracts (`packages/core`, `RetailerAdapter`, table shapes), human checkpoints | Bulk implementation; reading raw agent transcripts |
| **Builder** | One subagent per workstream, in its own git worktree on branch `ws/NN-slug` | Implementing one brief end to end, running its verification commands, writing a completion report | Editing files outside its deliverables; changing shared contracts; merging; touching `docs/status.md` |
| **Reviewer** | One fresh subagent per finished workstream | Checking every acceptance criterion with evidence, correctness review, security and terms checks, a verdict | Fixing code; reading the builder's narrative before forming its own view |
| **Researcher** | A subagent with web access, on demand | Closing one item in `docs/09-open-questions.md` with sources | Making design decisions |
| **Human** | Miguel | The seven checkpoints in §5, credentials, the name, anything with money or terms exposure | Day-to-day merging |

## 3. The loop

Repeat until every row in `docs/status.md` reads `merged`. A wave advances when its rows with downstream dependents are merged; see §3.6.

### 3.1 Dispatch a wave

For each workstream in the current wave, in one message so they run in parallel:

- Spawn a builder with the Agent tool: `subagent_type: "general-purpose"`, `isolation: "worktree"`, `model` per the brief's suggested model (Opus for WS00, WS07, WS08, WS09, WS10; Sonnet otherwise). Use the dispatch prompt template in §6.1. The prompt names the brief path, the read-first list, the forbidden paths, the report format, and the verification commands. It does not restate the brief.
- Update `docs/status.md`: state `in progress`, branch, model, started date.

Do not duplicate a builder's work while waiting. Use the time to pre-read the next wave's briefs or to dispatch researchers for open questions.

### 3.2 Receive a completion report

A builder's final message is its completion report (§6.2). The orchestrator reads only that. Reject a report that lacks pasted verification output, that touches files outside the brief's deliverables, or that edited a shared contract instead of filing a change request. Rejection means one message back to the same builder (SendMessage keeps its context) with exactly what is missing.

### 3.3 Review

Spawn a reviewer per finished workstream as soon as that builder is done, not after the whole wave. `subagent_type: "general-purpose"`, `model: "sonnet"`, `isolation: "worktree"` so it can check out the builder's branch and run commands without touching your checkout. Use the review prompt template in §6.3. Give it the brief and the branch name. Do not give it the builder's report; it forms its own view first and reads the report only at the end to check for undisclosed deviations.

The reviewer returns, for each acceptance criterion, pass or fail with the command it ran, plus findings ranked by severity, plus a verdict: `merge`, `fix round`, or `escalate`.

### 3.4 Decide

- `merge`: run CI on the branch (or the equivalent local commands), squash-merge into `main`, delete the branch, set the ledger row to `merged` with the date.
- `fix round`: send the reviewer's findings to the same builder via SendMessage. One fix round per workstream. After the fix, run the reviewer again (same reviewer via SendMessage, or a fresh one if the diff changed a lot).
- Second failure, or `escalate`: set the row to `blocked`, write what is wrong in the Notes column, and ask the human.

### 3.5 Contract changes

A builder that needs a change to `packages/core`, the `RetailerAdapter` interface, or a table it does not own files a contract change request in its report (§6.4). The orchestrator decides. If accepted, the orchestrator makes the change on `main` in its own small commit, updates the relevant doc, logs the decision in `status.md`, and tells affected builders to rebase. One writer per shared file.

A change that alters a design decision (not a fix) goes to the human first (checkpoint 7).

### 3.6 Advance

When every workstream in the wave that a later wave depends on is `merged` (WS14 has no dependents and may lag in `in review` while the name is pending; every other row must be merged):

1. Write a five-line wave summary in `docs/status.md` §Wave summaries: what landed, what was deferred, which contracts changed, what the next wave needs, anything the human must do.
2. Check the human checkpoints for the next wave (§5). Stop and ask if one is due.
3. Dispatch the next wave.

## 4. Waves

| Wave | Workstreams | Gate before dispatch |
|---|---|---|
| 0 | WS00 | Supabase project exists; the human has its URL and anon key |
| 1 | WS01, WS03, WS14 | Checkpoint 1 (scaffold approved) |
| 2 | WS02, WS07 | WS01 merged (checkpoint 2 passed). Checkpoint 3 (Kroger app registered) gates WS07 only; WS02 may start without it |
| 3 | WS04, WS06, WS08 | Checkpoint 4 (Tier 3 consent copy approved; retailer list chosen) gates WS08 only; WS04 and WS06 may start without it |
| 4 | WS05 | None |
| 5 | WS09 | None |
| 6 | WS10, WS11, WS12, WS13, WS15 | Checkpoint 5 (WS08 host demo accepted) gates WS10 only; the others may start without it |

Scale: at most one wave in flight. At most five builders at once (wave 6). Reviewers start as each builder finishes.

## 5. Human checkpoints

The orchestrator stops and asks at these points. Nowhere else, unless something is blocked.

1. **After WS00 merges.** Approve scaffold choices: package names, lint rules, CI shape, Node and pnpm versions.
2. **Before WS01 merges.** Approve the identity migration and RLS policies. This is where `docs/02-data-model.md` becomes real.
3. **Before WS07 starts.** The Kroger developer app is registered and the client id, secret, and redirect URI are in `.env.local`. Never in the repo.
4. **Before WS08 starts.** Approve the Tier 3 consent copy and confirm the Tier 3 retailer list (the WS08 brief's `TIER3_RETAILERS` default: Safeway, Albertsons, Haggen, Costco).
5. **Before WS10 starts.** Accept the WS08 host demo: the agent drives a test page in the Simulator, consent is recorded at connect, Disconnect wipes the session.
6. **Before WS14 finishes.** Choose the name from `docs/08-brand.md` after the checks.
7. **Any time.** A contract change the orchestrator judges to be a design change rather than a fix.

## 6. Message templates

These are the orchestrator's messages to agents and the formats it expects back. The *brief* template (the structure of a workstream file) lives in `docs/workstreams/README.md`.

Use these verbatim, filling the brackets.

### 6.1 Builder dispatch prompt

```
You are the builder for workstream [WSxx: Name] in the meal-planner repo. You are in your own git worktree on branch ws/[xx-slug]. Work only there.

Read, in order:
1. CLAUDE.md
2. docs/workstreams/[WSxx-file].md (your brief; it is the contract)
3. Everything the brief's "Read first" section lists

Then implement the brief completely. Rules:
- Touch only the paths under the brief's Deliverables, plus tests for them.
- Do not edit packages/core types, the RetailerAdapter interface, or tables you do not own. If you need a change there, stop that part, finish everything else, and file a contract change request in your report.
- Secrets never enter the repo. Use .env.local and update .env.example.
- Run every command under the brief's Verification commands before reporting. Paste the real output.
- Commit on your branch with clear messages. Do not merge, do not touch main, do not edit docs/status.md.
- If the brief and docs/01–04 disagree, the docs win; note it in Deviations.

Your final message is the completion report below and nothing else:

## Completion report: [WSxx]
### Built
### Files changed
### Verification output
### Deviations from brief
### Contract change requests
### Open issues
### Follow-ups
```

### 6.2 Completion report

The builder's final message. Sections:

- **Built.** Three to eight bullets, what exists now.
- **Files changed.** The list, grouped by package.
- **Verification output.** Each command from the brief, then its real output, trimmed to the lines that show the result. A report without this is rejected.
- **Deviations from brief.** Anything done differently and why. "None" is acceptable.
- **Contract change requests.** Each as: what, where, why, minimal diff. "None" is acceptable.
- **Open issues.** Known gaps with the acceptance criterion they affect.
- **Follow-ups.** Work that belongs to another workstream, named.

### 6.3 Reviewer prompt

```
You are reviewing workstream [WSxx: Name] in the meal-planner repo. The builder's work is on branch ws/[xx-slug]. Do not read the builder's report yet.

Read docs/workstreams/[WSxx-file].md. Then check out the branch in your worktree with `git checkout --detach ws/[xx-slug]` (detached, since the builder's worktree may still hold the branch) and, for EVERY acceptance criterion in the brief, run the command or reproduce the behavior and record pass or fail with the evidence.

Then review the diff against main for: correctness bugs, RLS or security gaps (docs/05-security-privacy.md), retailer-terms violations (the compliance checklists in docs/04-integrations.md), files touched outside the brief's Deliverables, edits to shared contracts, secrets in the repo, and em dashes in docs or copy.

Only now read the builder's completion report and note any deviation it did not disclose.

Reply with:
## Review: [WSxx]
### Acceptance criteria
| # | Criterion | Result | Evidence |
### Findings (most severe first)
For each: file:line, what is wrong, how it fails, severity (blocker / should fix / nit).
### Undisclosed deviations
### Verdict
One of: merge · fix round · escalate. One sentence why.
```

### 6.4 Contract change request

```
### Contract change request
- What: [type / table / method]
- Where: [path]
- Why: [the acceptance criterion or behavior that needs it]
- Minimal diff:
  [diff]
- Affects: [other workstreams that consume this]
```

### 6.5 Ledger row and wave summary

Ledger row in `docs/status.md`:

```
| 07 | Retailer framework + Kroger | 2 | in review | ws/07-retailer-framework-kroger | opus | 2026-11-12 | | reviewer running |
```

Wave summary:

```
### Wave 2 (merged 2026-11-15)
- Landed: WS02 recipe import (47/50 golden), WS07 Kroger adapter with run ledger.
- Deferred: nutritionInformation display (field empty in live responses; see 09-open-questions).
- Contracts changed: Product.allergens made optional; RetailerAdapter.handoffUrl added.
- Next wave needs: WS06 depends on recipes.embedding being populated; confirmed.
- Human: consent copy draft awaiting approval; WS08 waits on checkpoint 4.
```

### 6.6 Decisions log entry

```
- 2026-11-15: Adopted `@mp/*` as the package scope (WS00 report). Updated docs/01-architecture.md.
```

## 7. Branch, merge, and CI rules

- The repo is initialized with `main` and one commit of these docs. If the human has pushed to GitHub, use PRs and GitHub Actions; if not, merge locally and run the CI commands yourself before merging. Ask once at bootstrap and record the answer in the decisions log.
- Branches `ws/NN-slug`, one per workstream. Squash-merge into `main`. Delete after merge.
- CI must be green before merge: `pnpm typecheck`, `pnpm lint`, `pnpm test`; `supabase test db` from WS01 onward; `pnpm eval` thresholds from WS15 onward; web export from WS13 onward.
- No direct commits to `main` except the orchestrator's contract changes, doc updates, and ledger updates. Each is its own small commit.
- Builders commit on their branch as they go. The orchestrator never rewrites a builder's history.
- Identity: the repo-local config and `.githooks/pre-commit` make every commit, in every worktree, author and commit as `miguel.solorio07@gmail.com`. If a builder reports a rejected commit from the hook, the fix is `scripts/setup-git-identity.sh`, never a change to global git config.
- Commit messages end with the attribution line the session's system reminder specifies.

## 8. Context hygiene

- Never read a subagent's transcript or output file. Read its final report only.
- Keep `docs/status.md` authoritative. Update it after every event, not at the end of a wave. A fresh session resumes from it.
- Summarize each wave in `status.md` before dispatching the next. The summary is what a future session reads instead of this one's history.
- Load core docs by section, not whole files, once past wave 2.
- When a decision is made, write it in the decisions log the same turn.

## 9. Failure handling

| Situation | Action |
|---|---|
| Builder report lacks evidence | One message back asking for the exact missing output. Do not accept prose |
| Builder edited a shared contract | Reject. Ask it to revert that part and file a change request |
| Reviewer says fix round | One fix round with the same builder. Then re-review |
| Second failure | `blocked`. Note the problem. Ask the human whether to reassign (fresh builder, Opus) or descope |
| Builder stalls (no report after a long time, no notification) | Check its branch for commits. If work exists, spawn a fresh builder told to continue from that branch. If not, re-dispatch |
| Retailer API denies or rate-limits during WS07 or WS09 | `blocked`. Record in `09-open-questions.md`. Continue other workstreams in the wave |
| An open question blocks a brief | Spawn a researcher with the question and the "How to resolve" column from `09-open-questions.md`. Log the answer |
| Human checkpoint pending for a long time | Dispatch workstreams in the wave that do not depend on it; leave the others `not started` with a note |

## 10. Researchers

Spawn with `subagent_type: "general-purpose"`, `model: "sonnet"`, and web tools. The prompt is the question, the "Why it matters" and "How to resolve" cells from `docs/09-open-questions.md`, and "Report facts with source URLs; say when you cannot confirm." Write the answer into the decisions log and update the doc the question came from.

## 11. Optional: Workflow tool

If the human opts in ("use a workflow"), a deterministic review → verify pipeline per wave can run through the Workflow tool: one review agent per finished workstream, then one verify agent per blocker finding. Load the `workflow-authoring` skill first. This is a convenience, not a requirement; the loop in §3 works without it.

## 12. Definition of done for the implementation

- All sixteen rows in `docs/status.md` read `merged`.
- `pnpm typecheck && pnpm lint && pnpm test && pnpm eval` pass on `main`; `supabase test db` passes.
- The household can run the Phase 2 loop end to end: onboard → plan → list → QFC cart filled by a scheduled run → "cart ready" notification → pay in the QFC app → pickup.
- `docs/` reflect what was built. Every deviation accepted during the build is written into the docs as well as the decisions log.
- The human has made the public-beta decision and chosen the name, or recorded that both are deferred.

## 13. First message to send as the orchestrator

> Read CLAUDE.md, TODO.md, docs/implementation-guide.md, and docs/status.md, in that order. You are the orchestrator for this repo: you dispatch builder and reviewer agents per the guide and write no feature code yourself (shared contracts are the one exception). First, confirm which items in TODO.md section 0 are done and ask me for anything missing. Then start wave 0 by dispatching the WS00 builder exactly as the guide's section 6.1 template specifies. Keep TODO.md and docs/status.md current as you go. Stop only at the human checkpoints listed in the guide's section 5.

The orchestrator's first reply should be two lines: the state it found, and what it is dispatching.
