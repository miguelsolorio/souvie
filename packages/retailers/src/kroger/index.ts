// @mp/retailers/kroger: the Kroger adapter and its parts. Server-side code (the worker, the
// retailer-oauth Edge Function) imports this. The app imports only ./terms.ts from here.
export {
  type AccessToken,
  bannerForChain,
  buildAuthorizeUrl,
  CATALOG_SCOPE,
  type CompleteAuthorizationInput,
  type CompletedAuthorization,
  CUSTOMER_SCOPES,
  CustomerTokenCache,
  type CustomerTokens,
  completeAuthorization,
  createPkcePair,
  createRpcVault,
  KROGER_API_BASE,
  KROGER_CERT_API_BASE,
  KrogerAuth,
  type KrogerAuthConfig,
  type OAuthState,
  openState,
  type RefreshTokenVault,
  type SaveConnectionInput,
  sealState,
} from "./auth.ts";
export { cacheDecision, ResponseCache } from "./cache.ts";
export { MAX_CART_ITEMS_PER_REQUEST, normalizeUpc, prepareCartItems } from "./cart.ts";
export { KrogerClient } from "./client.ts";
export {
  type CompleteConnectInput,
  KROGER_CHECKOUT_URL,
  KrogerAdapter,
  type KrogerAdapterConfig,
} from "./KrogerAdapter.ts";
export { findStores, getStore, isZip, listChains, SUPPORTED_CHAINS } from "./locations.ts";
export {
  type AllergenLevel,
  allergenLevel,
  type KrogerLocation,
  type KrogerProduct,
  type MappedAllergens,
  mapAllergens,
  mapProduct,
  mapStore,
  pickImageUrl,
} from "./mappers.ts";
export {
  getProducts,
  MAX_IDS_PER_REQUEST,
  MAX_SEARCH_LIMIT,
  normalizeTerm,
  searchProducts,
} from "./products.ts";
export {
  createRpcQuotaStore,
  InMemoryQuotaStore,
  KROGER_DAILY_QUOTAS,
  KROGER_ENDPOINTS,
  type KrogerEndpoint,
  nextUtcMidnight,
  QUOTA_THRESHOLD,
  QuotaGuard,
  type QuotaStore,
  type Rpc,
  utcDay,
} from "./quota.ts";
export {
  assertDisplayUnchanged,
  DISPLAY_FIELDS,
  formatPrice,
  isDisplayUnchanged,
  type RenderedDisplay,
  type ReturnedSet,
  rememberReturned,
} from "./terms.ts";
