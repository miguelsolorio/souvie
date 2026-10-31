# @mp/agent

The shopping agent: tool schemas, policies, the run state machine, and review gates. It is host-agnostic. No Node-only imports (`fs`, `node:*`, `playwright`), so the same loop runs in the worker and in the app's WebView host (Tier 3 Mode A). Hosts inject the adapter and a persistence callback.

## Status

Scaffold from WS00. `src/index.ts` exports only `packageName`.

## Ownership

WS09. WS08 adds the WebView host; WS10 runs the loop inside it.

## Scripts

```bash
pnpm --filter @mp/agent typecheck
pnpm --filter @mp/agent lint
pnpm --filter @mp/agent test
```
