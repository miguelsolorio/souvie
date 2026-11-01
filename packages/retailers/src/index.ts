// @mp/retailers: the RetailerAdapter contract (docs/04-integrations.md §Adapter contract), the
// adapter registry, typed errors, and the capability table. Safe to import from the app: nothing
// here talks to a network or holds a secret.
//
// Adapters live behind subpath exports so the app bundle never carries them:
//   @mp/retailers/kroger        KrogerAdapter (server side: worker, retailer-oauth function)
//   @mp/retailers/kroger/terms  assertDisplayUnchanged, formatPrice (the app renders with these)
//   @mp/retailers/mock          MockRetailer and its fixtures (tests, evals, replays)
//
// This module is a shared contract. After WS07 merges only the orchestrator edits it.
export const packageName = "@mp/retailers";

export { BANNER_CHAIN_NAMES, bannerForChain } from "./banners.ts";
// WS08: BrowserHost, snapshots, the bridge protocol, page skills, and the Tier 3 gate.
export * from "./browser/index.ts";
export {
  automates,
  CAPABILITY_NAMES,
  INSTACART_CAPABILITIES,
  KROGER_CAPABILITIES,
  MOCK_CAPABILITIES,
  RETAILER_CAPABILITIES,
  supports,
} from "./capabilities.ts";
export {
  isRetailerError,
  RetailerAuthError,
  type RetailerAuthReason,
  RetailerError,
  RetailerNotSupportedError,
  RetailerQuotaError,
  RetailerRequestError,
  RetailerTermsError,
} from "./errors.ts";
export {
  assertRefInCandidates,
  type ProductRef,
  pickCandidate,
  productRef,
  toCartItemDelta,
} from "./refs.ts";
export {
  type AdapterGate,
  type AdapterListing,
  AdapterRegistry,
  defaultRegistry,
  getAdapter,
  isAdapterAvailable,
  listAdapters,
  registerAdapter,
} from "./registry.ts";
export {
  BANNERS,
  type Banner,
  type Capabilities,
  type Capability,
  type CapabilityName,
  type Cart,
  type CartItemDelta,
  type CartResult,
  type ConnectContext,
  type ConnectionHandle,
  type ConnectResult,
  type FindStoresOptions,
  MODALITIES,
  type Modality,
  type Order,
  type Product,
  RETAILER_IDS,
  type RetailerAdapter,
  type RetailerId,
  type SearchOptions,
  type Slot,
  STOCK_LEVELS,
  type StockLevel,
  type Store,
} from "./types.ts";
