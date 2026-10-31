// Client-side ids. A row the phone creates while offline needs its id before the server sees it:
// the optimistic update shows it, and a retried request must send the same id so the database
// treats the second attempt as the first (INSERT ... ON CONFLICT DO NOTHING) instead of adding a
// duplicate. The app can inject a better source (expo-crypto) with setIdGenerator.

let generator: (() => string) | undefined;

/** Replace the id source, for example with `() => Crypto.randomUUID()` from expo-crypto. */
export function setIdGenerator(next: (() => string) | undefined): void {
  generator = next;
}

function fromWebCrypto(): string | null {
  const webCrypto = (
    globalThis as {
      crypto?: {
        randomUUID?: () => string;
        getRandomValues?: (bytes: Uint8Array) => Uint8Array;
      };
    }
  ).crypto;
  if (webCrypto?.randomUUID) return webCrypto.randomUUID();
  if (webCrypto?.getRandomValues) {
    const bytes = webCrypto.getRandomValues(new Uint8Array(16));
    return uuidFromBytes(bytes);
  }
  return null;
}

function uuidFromBytes(bytes: Uint8Array): string {
  // Version 4, variant 10 (RFC 9562).
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * A random version 4 UUID. Prefers the injected generator, then Web Crypto. The last resort,
 * Math.random, is for a runtime with neither; a row id is not a secret, and Row Level Security
 * (not the id) decides who may write it.
 */
export function newId(): string {
  if (generator) return generator();
  const fromCrypto = fromWebCrypto();
  if (fromCrypto) return fromCrypto;
  const bytes = new Uint8Array(16);
  for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  return uuidFromBytes(bytes);
}
