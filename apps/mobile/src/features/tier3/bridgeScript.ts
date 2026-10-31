// The bridge as the host injects it: bridge.js with this WebView's token filled in.
import { BRIDGE_SOURCE } from "./bridge.generated";

export const BRIDGE_TOKEN_PLACEHOLDER = '"__MP_BRIDGE_TOKEN__"';

const TOKEN_FORMAT = /^[A-Za-z0-9]{16,64}$/;

/** A fresh token for one WebView. Not a secret against the device owner, only against page code. */
export function newBridgeToken(randomBytes: (n: number) => Uint8Array): string {
  const bytes = randomBytes(18);
  let out = "";
  for (const b of bytes) out += (b % 36).toString(36);
  return out.padEnd(18, "0");
}

/** bridge.js ready to inject, with the token in place of the placeholder. */
export function buildBridgeScript(token: string): string {
  if (!TOKEN_FORMAT.test(token)) throw new Error("bridge token must be 16 to 64 letters or digits");
  if (!BRIDGE_SOURCE.includes(BRIDGE_TOKEN_PLACEHOLDER)) {
    throw new Error("bridge.generated.ts has no token placeholder; regenerate it");
  }
  return `${BRIDGE_SOURCE.replace(BRIDGE_TOKEN_PLACEHOLDER, JSON.stringify(token))}\ntrue;`;
}
