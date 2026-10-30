# 06 · Risk register

Each risk names the workstream that owns its mitigation. The orchestrator checks the relevant rows during review of that workstream. Likelihood and impact are judgments as of 2026-10-29.

## Product and engineering

| # | Risk | Likelihood | Impact | Mitigation | Owner WS |
|---|---|---|---|---|---|
| R1 | Ingredient→product matching buys the wrong thing | High | Med | Review gate before any cart write; pinned `product_matches`; confidence thresholds; alternatives shown; eval set of 100 cases per retailer | WS09, WS15 |
| R2 | Unit conversion errors inflate or starve quantities | Med | Med | Density and unit-weight table with tests; "why this amount" in the UI; round up; user edits persist as overrides | WS03, WS05 |
| R3 | LLM cost creep | Med | Med | Haiku for bulk work; prompt caching; per-household daily cap in `packages/llm`; `ai_runs` dashboard | WS15 |
| R4 | Allergen exposure from a model mistake | Low | High | Allergies enforced in SQL and in a deterministic cart check; never model-only; missing allergen data flags review | WS06, WS09 |
| R5 | Recipe copyright complaints | Low | Med | Private-by-default storage, attribution, no public republishing of scraped content; catalog holds only owned or licensed recipes | WS02 |
| R6 | Offline grocery list fails in the store | Med | Med | Persisted TanStack Query cache, optimistic writes, last-write-wins check-offs, reconnect reconciliation | WS05 |
| R7 | Expo web gaps for some native modules | Med | Low | Web-compatible libraries by default; platform-specific files; web export built in CI | WS00, WS13 |
| R8 | Solo-founder scope creep | High | High | Workstream briefs with testable acceptance criteria; v1 cut list in `00-overview.md`; the orchestrator rejects out-of-scope work in reports | Orchestrator |
| R9 | Household sharing bugs leak data across households | Low | High | pgTAP RLS tests for every table in CI; no client-side filtering as a security boundary; service-role helper refuses unscoped queries | WS01 |
| R10 | Background jobs stall silently | Med | Med | Run heartbeats, dead-letter queue, Sentry alert when a run exceeds 10 minutes, visible run status in the app | WS09, WS15 |
| R11 | Video import violates platform terms (media download, transcript scraping) | High if done naively | Med | Caption-only import via share sheet; never fetch media; explicit "not in caption" fallback | WS02 |
| R12 | Retailers' own assistants (Kroger, Instacart Clementine, Safeway in ChatGPT) make single-store recipe-to-cart a commodity | High | High | Position on cross-store household planning, persistent preferences, scheduled runs, and opt-in hands-off checkout; never market "recipe to cart" alone | WS14 |
| R13 | Hallucinated SKUs or UPCs from the model | Med | Med | The model chooses among candidate indices returned by catalog search; it never emits ids; code validates every id against the candidate set | WS09 |

## Integrations and terms

| # | Risk | Likelihood | Impact | Mitigation | Owner WS |
|---|---|---|---|---|---|
| R14 | Instacart Developer Platform not accepting applicants, or production key denied | Med | High for Costco and Safeway Tier 2 | Apply in Phase 0; build on the dev key; fall back to Tier 3 Mode A for Costco and Safeway; pursue the partner MCP tier | WS08, human |
| R15 | Kroger API quota (Products 10k/day, Cart 5k/day, shared by all our users) exhausted, or access revoked | Med once public | High | Budget calls per household per run; batch pinned items via `filter.productId` (50 per call); search only unpinned items; respect cache headers (longer caching is itself a breach); Partner tier removes limits; Instacart link as fallback for QFC | WS07, WS09 |
| R16 | Tier 3 triggers bot detection (Kasada at Costco, Imperva at Safeway) or account lockout | High for cloud headless; Low for on-device | High | Mode A on-device first; Mode C forbidden; stop on CAPTCHA or MFA and hand to the user; consent copy names the exposure | WS10 |
| R17 | Tier 3 violates retailer terms (Costco: no unapproved software; Albertsons: UI-only access, no commercial use) | Certain | Med–High | Opt-in with explicit consent; user-authorized agent posture (Amazon v. Perplexity, Aug 2026); no passwords stored; per-retailer kill switch; personal use only until approvals exist | WS10, human |
| R18 | Instacart terms breached by UI (multi-retailer price view, moving items between baskets, missing CTA, "partner" wording) | Med | Med | Compliance checklist in `04-integrations.md` reviewed before WS08 and WS14 merge; prices shown only from Kroger; one link per store | WS08, WS14 |
| R19 | No API can schedule a slot or pay; users see "the agent shops for you" as incomplete | High | Med | Honest Tier 1 framing ("cart ready, one tap to pay"); one-tap deep link; Tier 3 for opted-in households; quarterly re-check of UCP and ACP | WS09, WS14 |
| R20 | Costco requires membership; non-members pay more on Instacart | Certain | Low | Capture membership in onboarding; route members to sameday.costco.com | WS06, WS08 |
| R21 | Kroger terms versus our memory features: no storing data derived from searches or cart adds; cart display ends with the session; no cached catalog | Med | High (API revocation) | `product_matches` holds only the user's confirmed product (ids, name, size); live data every run; `cart_snapshot` cleared after 24h; history recorded as the household's own purchase record from the ledger with user confirmation; written clarification from Kroger before any public launch; price trends deferred | WS07, WS09, WS12, human |
| R22 | Monetization conflicts: Kroger banner logos only for non-monetized apps; Albertsons bars commercial use without approval | Certain at v2 | Med | v1 is non-commercial; before billing, file a Kroger Partnership Request and keep Safeway Tier 3 personal-use-only; the name never contains "Kroger"; no retailer logos on marketing | WS14, human |

## Orchestration

| # | Risk | Likelihood | Impact | Mitigation | Owner |
|---|---|---|---|---|---|
| R23 | Two builders edit the same shared contract and diverge | Med | Med | Contracts owned by the orchestrator; builders file change requests; one writer per shared file | Orchestrator |
| R24 | A builder reports done without evidence | Med | Med | Completion report requires pasted verification output; reviewer reruns commands; reports without evidence are rejected | Orchestrator |
| R25 | Orchestrator context loss mid-project | Med | Med | `docs/status.md` is authoritative and updated after every event; wave summaries; a fresh session bootstraps from `CLAUDE.md` | Orchestrator |
| R26 | Human checkpoints become bottlenecks | Med | Low | Only seven checkpoints, all listed in advance in `implementation-guide.md`; external tasks (Kroger app, Instacart application) start in week one | Human |
