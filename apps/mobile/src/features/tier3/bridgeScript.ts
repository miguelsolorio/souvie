// The bridge as the host injects it: bridge.js with this WebView's token and receiver name filled in.
//
// The token signs every message the bridge posts and stays in the bridge's closure. The receiver is
// the global the host calls to deliver messages, so page scripts can see its name; it is a separate
// random value and never contains the token. Defence in depth against the page's own scripts, not
// a guarantee: they run in the same JavaScript realm as the bridge.
import { BRIDGE_SOURCE } from "./bridge.generated";

export const BRIDGE_TOKEN_PLACEHOLDER = '"__MP_BRIDGE_TOKEN__"';
export const BRIDGE_RECEIVER_PLACEHOLDER = '"__MP_BRIDGE_RECEIVER__"';
const RECEIVER_PREFIX = "__mpTier3Bridge_";

const TOKEN_FORMAT = /^[A-Za-z0-9]{16,64}$/;
const RECEIVER_FORMAT = /^__mpTier3Bridge_[A-Za-z0-9]{16,64}$/;

/** A fresh random id for one WebView. Not a secret against the device owner, only against page code. */
export function newBridgeToken(randomBytes: (n: number) => Uint8Array): string {
  const bytes = randomBytes(18);
  let out = "";
  for (const b of bytes) out += (b % 36).toString(36);
  return out.padEnd(18, "0");
}

/** A receiver name for one WebView: random, and never the token. */
export function newBridgeReceiver(randomBytes: (n: number) => Uint8Array, token: string): string {
  for (let i = 0; i < 8; i++) {
    const id = newBridgeToken(randomBytes);
    if (id !== token && !id.includes(token) && !token.includes(id))
      return `${RECEIVER_PREFIX}${id}`;
  }
  throw new Error("could not pick a bridge receiver name");
}

/** bridge.js ready to inject, with the token and the receiver name in place of the placeholders. */
export function buildBridgeScript(token: string, receiver: string): string {
  if (!TOKEN_FORMAT.test(token)) throw new Error("bridge token must be 16 to 64 letters or digits");
  if (!RECEIVER_FORMAT.test(receiver)) throw new Error("bridge receiver name is malformed");
  if (receiver.includes(token))
    throw new Error("the bridge receiver name must not carry the token");
  if (
    !BRIDGE_SOURCE.includes(BRIDGE_TOKEN_PLACEHOLDER) ||
    !BRIDGE_SOURCE.includes(BRIDGE_RECEIVER_PLACEHOLDER)
  ) {
    throw new Error("bridge.generated.ts is missing a placeholder; regenerate it");
  }
  return `${BRIDGE_SOURCE.replace(BRIDGE_TOKEN_PLACEHOLDER, JSON.stringify(token)).replace(
    BRIDGE_RECEIVER_PLACEHOLDER,
    JSON.stringify(receiver),
  )}\ntrue;`;
}
