// Tier 3, Mode A (WS08): the retailer's own website in a WebView on the person's phone, driven
// through an injected bridge, with the session kept encrypted on the device, consent at connect,
// and the kill switch. docs/04-integrations.md §Tier 3. WS10 builds the per-site adapters on top.
//
// Native modules (react-native-webview, the cookie manager, expo-secure-store, view-shot) are
// imported only by WebViewHost.tsx and nativeSession.ts, so the pure parts below test in Node.
export {
  connectBrowserSession,
  type RpcClient,
  recordTier3Consent,
  type Tier3Connection,
  tier3ErrorMessage,
  useDisconnectTier3,
  useTier3Connections,
  useTier3Consent,
} from "./api";
export {
  type BridgeHost,
  type BridgeHostOptions,
  type BridgeTransport,
  createBridgeHost,
  hostAllowed,
  type StorageDump,
} from "./bridgeHost";
export { buildBridgeScript, newBridgeToken } from "./bridgeScript";
export { ConsentScreen } from "./ConsentScreen";
export {
  CONSENT_COPY,
  CONSENT_VERSION,
  type ConsentCopy,
  type ConsentSection,
  needsConsent,
  parseConsent,
  renderConsentCopy,
  TIER3_RETAILERS,
} from "./consent";
export { createPostHogTier3Flags, evaluateTier3Flag, type Tier3Flags, tier3Flags } from "./flags";
export { appTier3GateDeps, configureAppTier3Gate } from "./gate";
export {
  applyReplacements,
  findPersonalData,
  type Replacement,
  type ScrubKind,
  snapshotFileName,
} from "./scrub";
export {
  type Cookie,
  type CookieJar,
  configureSessionVault,
  createSessionVault,
  forgetSessionKeys,
  loadSession,
  type SecureStoreLike,
  type SessionCipher,
  type SessionKeyService,
  type SessionState,
  SessionUnavailableError,
  type SessionVault,
  saveSession,
  wipeSession,
} from "./secureSession";
export {
  allowedHosts,
  isAllowedCookieDomain,
  RETAILER_SESSION_DOMAINS,
  retailerDisplayName,
  TIER3_STORES,
  type Tier3Store,
  type Tier3StoreId,
  tier3Store,
} from "./stores";
export { firstConnectStep, Tier3ConnectFlow } from "./Tier3ConnectFlow";
export { Tier3ConnectionCard } from "./Tier3ConnectionCard";
export { Tier3Login } from "./Tier3Login";
export { Tier3SettingsSection } from "./Tier3SettingsSection";
export {
  appTier3SessionDeps,
  buildStorageRestoreScript,
  createTier3Session,
  looksSignedIn,
  type RestoreResult,
  type SessionTarget,
  type Tier3Session,
  type Tier3SessionDeps,
  useTier3Session,
} from "./useTier3Session";
export { WebViewHost, type WebViewHostProps } from "./WebViewHost";
