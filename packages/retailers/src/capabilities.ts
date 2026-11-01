// What each store can do, from docs/04-integrations.md §Per-retailer adapter plan. Adding a store
// is a new adapter plus a row here. The UI reads these rows to say what will happen ("Cart fills
// automatically, you pay in the QFC app") without loading any adapter.
import type { Capabilities, Capability, CapabilityName, RetailerId } from "./types.ts";

export const KROGER_CAPABILITIES: Readonly<Capabilities> = Object.freeze({
  search: "api",
  cartAdd: "api",
  cartRead: "none",
  slots: "handoff",
  checkout: "handoff",
  orders: "none",
});

const ALL_BROWSER: Readonly<Capabilities> = Object.freeze({
  search: "browser",
  cartAdd: "browser",
  cartRead: "browser",
  slots: "browser",
  checkout: "browser",
  orders: "browser",
});

/** The mock does everything over its fake API, so WS09 can test every path. */
export const MOCK_CAPABILITIES: Readonly<Capabilities> = Object.freeze({
  search: "api",
  cartAdd: "api",
  cartRead: "api",
  slots: "api",
  checkout: "api",
  orders: "api",
});

export const RETAILER_CAPABILITIES: Readonly<Record<RetailerId, Readonly<Capabilities>>> =
  Object.freeze({
    kroger: KROGER_CAPABILITIES,
    safeway: ALL_BROWSER,
    costco: ALL_BROWSER,
  });

export const CAPABILITY_NAMES: readonly CapabilityName[] = [
  "search",
  "cartAdd",
  "cartRead",
  "slots",
  "checkout",
  "orders",
];

/** True when the adapter can do this at all, by any means. */
export function supports(capabilities: Capabilities, name: CapabilityName): boolean {
  return capabilities[name] !== "none";
}

/** True when the adapter does this itself (API or browser), without handing off to the user. */
export function automates(capabilities: Capabilities, name: CapabilityName): boolean {
  const value: Capability = capabilities[name];
  return value === "api" || value === "browser";
}
