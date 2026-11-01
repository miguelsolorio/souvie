-- Retire instacart (orchestrator, CCR9, 2026-10-31). Instacart's developer platform is closed to
-- new applicants, so Tier 2 cannot ship (docs/status.md decisions log, 2026-10-30). Postgres cannot
-- drop a value from an enum, so the `retailer` type keeps 'instacart' and these constraints keep
-- every row off it. The TypeScript vocabulary (`RetailerId` in @mp/core) no longer names it.

alter table public.retailer_connections
  add constraint retailer_connections_no_instacart check (retailer <> 'instacart');
alter table public.product_matches
  add constraint product_matches_no_instacart check (retailer <> 'instacart');
alter table public.retailer_quota_usage
  add constraint retailer_quota_usage_no_instacart check (retailer <> 'instacart');

comment on type public.retailer is
  'kroger, safeway, costco. instacart is retired (2026-10-30) and constrained out of every table that uses the type; Postgres cannot drop an enum value.';
