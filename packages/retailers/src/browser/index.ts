// @mp/retailers browser surface (WS08): the BrowserHost interface every Tier 3 adapter drives, the
// snapshot tree and its serializer contract, the bridge message protocol, the shared page skills,
// and the Tier 3 gate. Platform-neutral: no React Native, DOM, Node or Deno imports. Re-exported
// from the package root.
export {
  configureTier3Gate,
  createTier3Gate,
  decideTier3,
  getGatedAdapter,
  installTier3Gate,
  isTier3Allowed,
  isTier3Retailer,
  TIER3_FLAG,
  TIER3_RETAILER_IDS,
  type Tier3Consent,
  type Tier3Decision,
  type Tier3Gate,
  type Tier3GateDeps,
  Tier3GateError,
  type Tier3GateReason,
  type Tier3RetailerId,
  tier3Gate,
} from "./gating.ts";
export {
  type BrowserHost,
  BrowserHostError,
  type BrowserHostErrorCode,
  isBrowserHostError,
  type SnapshotOptions,
  type TypeOptions,
  USER_REQUIRED_REASONS,
  type UserRequiredReason,
} from "./host.ts";
export {
  BRIDGE_ENVELOPE,
  BRIDGE_PROTOCOL_VERSION,
  type BridgeErrorPayload,
  type HostMessage,
  hostMessageScript,
  type PageMessage,
  parsePageMessage,
  WAIT_INTERVAL_MS,
} from "./protocol.ts";
export {
  findByRole,
  findByText,
  findStepper,
  nearestButton,
  normalizeText,
  type ParsedPrice,
  parsePrice,
  type Stepper,
  type TextMatch,
} from "./skills.ts";
export {
  countNodes,
  DEFAULT_MAX_NODES,
  diffSnapshots,
  findNode,
  type NodeChange,
  pathTo,
  type SnapshotNode,
  type SnapshotTree,
  type VisitedNode,
  validateSnapshotTree,
  WAIT_MAX_NODES,
  walk,
} from "./snapshot.ts";
