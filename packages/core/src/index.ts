// @mp/core: domain types (zod), unit conversion, list aggregation, pure logic. No I/O.
//
// This module is a shared contract. Only the orchestrator edits its exports; a builder
// that needs a change files a contract change request (docs/implementation-guide.md §3.5).
// The shapes it will hold are defined in docs/02-data-model.md. Each workstream brief
// names the module it adds here (for example identity.ts in WS01, units.ts in WS03).
//
// WS00 leaves it empty on purpose.
export {};
