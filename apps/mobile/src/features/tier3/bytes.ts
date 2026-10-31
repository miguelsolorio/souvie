// Bytes, base64 and UTF-8 without Buffer, TextEncoder or TextDecoder, which Hermes does not all
// have. Used by the session cipher and the screenshot path.

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

export function bytesToBase64(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] ?? 0;
    const b = bytes[i + 1];
    const c = bytes[i + 2];
    const n = (a << 16) | ((b ?? 0) << 8) | (c ?? 0);
    out += B64[(n >> 18) & 63];
    out += B64[(n >> 12) & 63];
    out += b === undefined ? "=" : B64[(n >> 6) & 63];
    out += c === undefined ? "=" : B64[n & 63];
  }
  return out;
}

export function base64ToBytes(b64: string): Uint8Array {
  const clean = b64.replace(/[^A-Za-z0-9+/]/g, "");
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let buffer = 0;
  let bits = 0;
  let index = 0;
  for (const ch of clean) {
    buffer = (buffer << 6) | B64.indexOf(ch);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[index++] = (buffer >> bits) & 0xff;
    }
  }
  return out.subarray(0, index);
}

export function utf8Encode(s: string): Uint8Array {
  const out: number[] = [];
  for (const ch of s) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp < 0x80) out.push(cp);
    else if (cp < 0x800) out.push(0xc0 | (cp >> 6), 0x80 | (cp & 63));
    else if (cp < 0x10000) out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
    else {
      out.push(
        0xf0 | (cp >> 18),
        0x80 | ((cp >> 12) & 63),
        0x80 | ((cp >> 6) & 63),
        0x80 | (cp & 63),
      );
    }
  }
  return new Uint8Array(out);
}

export function utf8Decode(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; ) {
    const a = bytes[i] ?? 0;
    let cp: number;
    if (a < 0x80) {
      cp = a;
      i += 1;
    } else if (a < 0xe0) {
      cp = ((a & 31) << 6) | ((bytes[i + 1] ?? 0) & 63);
      i += 2;
    } else if (a < 0xf0) {
      cp = ((a & 15) << 12) | (((bytes[i + 1] ?? 0) & 63) << 6) | ((bytes[i + 2] ?? 0) & 63);
      i += 3;
    } else {
      cp =
        ((a & 7) << 18) |
        (((bytes[i + 1] ?? 0) & 63) << 12) |
        (((bytes[i + 2] ?? 0) & 63) << 6) |
        ((bytes[i + 3] ?? 0) & 63);
      i += 4;
    }
    out += String.fromCodePoint(cp);
  }
  return out;
}
