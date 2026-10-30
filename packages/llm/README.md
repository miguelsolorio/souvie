# @mp/llm

The Anthropic client wrapper, the versioned prompt registry, structured-output helpers, and `ai_runs` cost logging. Model tiers are in `docs/03-ai-design.md`.

## Status

Scaffold from WS00. `src/index.ts` exports only `packageName`.

## Ownership

WS02 creates the client, `extract<T>()`, and the registry. WS03, WS06, and WS09 add prompts.

## Scripts

```bash
pnpm --filter @mp/llm typecheck
pnpm --filter @mp/llm lint
pnpm --filter @mp/llm test
```
