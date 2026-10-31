// @mp/core: domain types (zod), unit conversion, list aggregation, pure logic. No I/O.
//
// This module is a shared contract. Only the orchestrator edits its exports; a builder
// that needs a change files a contract change request (docs/implementation-guide.md §3.5).
// The shapes it will hold are defined in docs/02-data-model.md. Each workstream brief
// names the module it adds here (for example identity.ts in WS01, units.ts in WS03).
//
// Relative imports carry the .ts extension so Deno (Supabase Edge Functions) can load this
// barrel through an import map.
export * from "./identity.ts";
export * from "./ingredient.ts";
export * from "./list/index.ts";
export * from "./planning.ts";
export * from "./preferences.ts";
export * from "./recipe.ts";
export * from "./retail.ts";
export * from "./units.ts";
