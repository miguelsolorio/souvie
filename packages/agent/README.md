# @mp/agent

The shopping agent (WS09): it turns a grocery list into a proposed cart at one store, waits for the household's review, and fills the store cart through a write ledger. Host-agnostic: no Node, Deno or browser API in `src/`, so the same code runs in the worker (`services/shopper-worker`) and, later, in the app's WebView host (WS08, WS10). A host passes the adapter, the persistence callbacks and a model caller.

## The phases

| Function | What it does | Cart writes |
|---|---|---|
| `planRun(ctx, deps)` | One `getProducts` batch per 50 pinned products, one search per other line; narrows and ranks candidates; asks the model only about close calls; applies the policies and the allergen check; returns the proposal, the snapshot and the `needs_review` push | None |
| `pushRun(ctx, rows, deps)` | Refuses an approved cart over the budget cap; looks the products up again and re-runs the allergen check; pushes each line through the ledger; returns `cart_ready` with the hand-off link, or `needs_review` on quota | Ledger first, every call |
| `continueCheckout(ctx, deps)` | Tier 3 only (checkout = browser): slots, then pay, after review and only on the person's tap or under `auto_checkout_cap_usd` | Retailer checkout |

## Modules

| File | Holds |
|---|---|
| `state.ts` | The run state machine. The SQL status guard enforces the same table |
| `policies.ts` | Substitution (none, same_brand, any), per-item ceiling, budget cap, auto_checkout, tool and clock limits, applied to `core.RunPolicy` |
| `allergens.ts` | The deterministic check on `Product.allergens`: contains blocks, may contain flags, missing data flags |
| `planner.ts`, `sizes.ts` | Relevance and qualifier narrowing, the scorer (pinned > past pick > unit-price fit > preference > stock), units to buy, the proposed row |
| `tools.ts` | The strict tool schemas, capability and state checks, and the planning session the tools act on |
| `loop.ts` | The manual tool-use loop over `messages.create` (through `@mp/llm` `callWithTools` in the worker) |
| `ledger.ts` | The add-only cart ledger: resume after a crash, signed corrections, the live-cart diff |
| `review.ts` | Keep, swap, remove, quantity. The run-approve Edge Function imports this file by path |
| `transcript.ts` | One entry per tool call, with no product data |
| `replay.ts`, `index.ts` | `replayRun` and `matchLineItems` for evals and WS15 |

## Evals

`evals/runs/*.json` are five runs recorded live against `MockRetailer` with `claude-sonnet-5-5`. `evals/replay.test.ts` (in `pnpm test`) replays each to its recorded proposal, tool calls, final state, ledger and cart. `evals/agent.eval.ts` (in `pnpm eval`) prints the pass rate and each run's model cost.

Re-recording calls the real model (a few cents a scenario) and never runs in CI:

```bash
ANTHROPIC_API_KEY=... pnpm --filter @mp/agent record [scenario ...]
```

## Scripts

```bash
pnpm --filter @mp/agent typecheck
pnpm --filter @mp/agent lint
pnpm --filter @mp/agent test
```

## Ownership

WS09. WS08 adds the WebView host; WS10 runs the loop inside it.
