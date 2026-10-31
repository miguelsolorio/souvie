import { describe, expect, it } from "vitest";
import { sha256Hex } from "./sha256.ts";

// Web Crypto and TextEncoder are on every runtime that runs the tests but not in this package's
// type libraries, so they are reached through globalThis like @mp/db's ids.ts does.
type SubtleLike = { digest(algorithm: string, data: Uint8Array): Promise<ArrayBuffer> };
const runtime = globalThis as unknown as {
  crypto?: { subtle?: SubtleLike };
  TextEncoder: new () => { encode(text: string): Uint8Array };
};
const subtle = runtime.crypto?.subtle;

async function reference(text: string): Promise<string> {
  if (!subtle) throw new Error("Web Crypto is not available to compare against");
  const digest = await subtle.digest("SHA-256", new runtime.TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

describe("sha256Hex", () => {
  it("matches the published test vectors", () => {
    expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    expect(sha256Hex("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq")).toBe(
      "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
    );
  });

  it("matches the runtime's own SHA-256 around every block boundary", async () => {
    for (const length of [1, 54, 55, 56, 57, 63, 64, 65, 119, 120, 128, 1000]) {
      const text = "x".repeat(length);
      expect(sha256Hex(text), `length ${length}`).toBe(await reference(text));
    }
  });

  it("matches on text outside ASCII, including surrogate pairs", async () => {
    for (const text of ["café", "日本語のレシピ", "🍝 pasta 🧄", "a\u0000b", "é́"]) {
      expect(sha256Hex(text), text).toBe(await reference(text));
    }
  });

  it("matches on a plan-shaped message", async () => {
    const text = Array.from(
      { length: 40 },
      (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}|r${i}|${i + 0.5}|planned`,
    ).join("\n");
    expect(sha256Hex(text)).toBe(await reference(text));
  });
});
