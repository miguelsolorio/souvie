# Workstream briefs

Each `WSxx-*.md` file is a self-contained hand-off for one **builder agent**. A builder should be able to implement its workstream from the brief plus the docs the brief tells it to read, without reading this conversation or any other brief. The **orchestrator** (see `../implementation-guide.md`) dispatches briefs in dependency waves and judges results against the acceptance criteria below.

## Index

| WS | File | Wave | Suggested builder model |
|---|---|---|---|
| 00 | `WS00-scaffold.md` | 0 | Opus |
| 01 | `WS01-auth-households.md` | 1 | Sonnet |
| 02 | `WS02-recipes-import.md` | 2 | Sonnet |
| 03 | `WS03-ingredient-ontology-parser.md` | 1 | Sonnet |
| 04 | `WS04-planner-ui.md` | 3 | Sonnet |
| 05 | `WS05-grocery-list.md` | 4 | Sonnet |
| 06 | `WS06-onboarding-suggestions.md` | 3 | Sonnet |
| 07 | `WS07-retailer-framework-kroger.md` | 2 | Opus |
| 08 | `WS08-assisted-checkout-host.md` | 3 | Opus |
| 09 | `WS09-shopping-agent-worker.md` | 5 | Opus |
| 10 | `WS10-browser-adapters.md` | 6 | Opus |
| 11 | `WS11-scheduling-notifications.md` | 6 | Sonnet |
| 12 | `WS12-history-spend.md` | 6 | Sonnet |
| 13 | `WS13-web-desktop.md` | 6 | Sonnet |
| 14 | `WS14-brand-marketing-site.md` | 1 | Sonnet |
| 15 | `WS15-observability-evals.md` | 6 | Sonnet |
| 16 | `WS16-starter-catalog.md` | 3 | Sonnet |

## Template

Every brief has exactly these sections, in this order. Empty sections are not allowed; write "None" when that is the truth.

```markdown
# WSxx: <Name>

**Wave:** <n> · **Suggested model:** <Opus|Sonnet> · **Branch:** `ws/xx-<slug>`

## Goal
One paragraph: what exists when this is done and why it matters to the product loop.

## Depends on
Workstreams that must be merged first, and the specific things this WS consumes from them.

## Read first
Ordered list of docs (paths and section numbers) the builder must read before writing code. Keep it short; name sections, not whole files, where possible.

## In scope
Bullet list of what this WS builds.

## Out of scope
Bullet list of things a builder might be tempted to do but must not. Name the WS that owns each.

## Deliverables
Concrete paths that must exist when done (packages, files, migrations, screens, functions, tests, docs updates).

## Interfaces
Types, tables, functions, routes, or events this WS **implements** and those it **consumes**. Shared contracts (`packages/core` types, the `RetailerAdapter` interface, table shapes) are owned by the orchestrator: a builder who needs a change stops and files a contract change request in its completion report instead of editing them.

## Acceptance criteria
Numbered, testable statements. Each names a command, a test, or an observable behavior a reviewer can reproduce. No adjectives.

## Verification commands
The exact commands a builder runs before reporting and a reviewer reruns. Expected outcome for each.

## Risks and notes
Known traps, ToS constraints, research facts that matter here, and anything from `docs/06-risks.md` this WS mitigates.

## Completion report
The builder ends with the report format from `docs/implementation-guide.md` §6.2 (Message templates). Nothing else is read by the orchestrator.
```

## Rules for builders

- Work only on your branch in your worktree. Touch only paths listed under Deliverables plus tests for them.
- Do not change shared contracts; request the change.
- Run every verification command and paste the real output into the completion report. A report without evidence is rejected.
- If the brief and the docs disagree, the docs in `docs/01`–`04` win; say so in the report.
- Secrets never enter the repo. Use `.env.local` and `.env.example`.
