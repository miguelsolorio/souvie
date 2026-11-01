// The native half of secureSession.ts (WS08): expo-secure-store for the ciphertext, the WebView
// cookie store through @preeternal/react-native-cookie-manager, AES-256-GCM through expo-crypto,
// and the two Supabase RPCs for the per-connection key. Loaded only on a device; tests never
// import this file.
import CookieManager, {
  type Cookie as NativeCookie,
} from "@preeternal/react-native-cookie-manager";
import { AESEncryptionKey, AESSealedData, aesDecryptAsync, aesEncryptAsync } from "expo-crypto";
import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";
import { getSupabase } from "../../lib/supabase";
import { base64ToBytes, bytesToBase64, utf8Decode, utf8Encode } from "./bytes";
import {
  type Cookie,
  type CookieJar,
  createSessionVault,
  type SecureStoreLike,
  type SessionCipher,
  type SessionKeyService,
  type SessionVault,
} from "./secureSession";
import { isAllowedCookieDomain } from "./stores";

const STORE_OPTIONS: SecureStore.SecureStoreOptions = {
  // Never synced to iCloud or moved to another device; readable once the phone is unlocked.
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};

export const nativeSecureStore: SecureStoreLike = {
  isAvailableAsync: () => SecureStore.isAvailableAsync(),
  getItemAsync: (key) => SecureStore.getItemAsync(key, STORE_OPTIONS),
  setItemAsync: (key, value) => SecureStore.setItemAsync(key, value, STORE_OPTIONS),
  deleteItemAsync: (key) => SecureStore.deleteItemAsync(key, STORE_OPTIONS),
};

const WEBKIT = { iosCookieStore: "webKit" } as const;

function toCookie(c: NativeCookie, fallbackDomain: string): Cookie {
  return {
    name: c.name,
    value: c.value,
    domain: c.domain ?? fallbackDomain,
    path: c.path ?? "/",
    ...(c.expires ? { expires: c.expires } : {}),
    ...(c.secure !== undefined ? { secure: c.secure } : {}),
    ...(c.httpOnly !== undefined ? { httpOnly: c.httpOnly } : {}),
    ...(c.sameSite ? { sameSite: c.sameSite } : {}),
  };
}

function urlFor(domain: string): string {
  return `https://${domain.replace(/^\.+/, "")}`;
}

/** The WebView's cookie store (WKWebsiteDataStore on iOS, the shared store on Android). */
export const nativeCookieJar: CookieJar = {
  async read(domains) {
    const found: Cookie[] = [];
    if (Platform.OS === "ios") {
      for (const c of await CookieManager.getAllAsArray(WEBKIT)) {
        if (isAllowedCookieDomain(c.domain, domains)) found.push(toCookie(c, c.domain ?? ""));
      }
    } else {
      // Android has no "all cookies" call: ask for each registered domain and its www host.
      for (const d of domains) {
        for (const host of [d, `www.${d}`]) {
          for (const c of await CookieManager.getAsArray(urlFor(host))) {
            found.push(toCookie(c, host));
          }
        }
      }
    }
    const seen = new Set<string>();
    return found.filter((c) => {
      const key = `${c.domain}|${c.path}|${c.name}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  },

  async write(cookies) {
    for (const c of cookies) {
      await CookieManager.set(
        urlFor(c.domain),
        {
          name: c.name,
          value: c.value,
          domain: c.domain,
          path: c.path,
          ...(c.expires ? { expires: c.expires } : {}),
          ...(c.secure !== undefined ? { secure: c.secure } : {}),
          ...(c.httpOnly !== undefined ? { httpOnly: c.httpOnly } : {}),
          ...(c.sameSite ? { sameSite: c.sameSite } : {}),
        },
        WEBKIT,
      );
    }
    await CookieManager.flush().catch(() => {});
  },

  async clearDomains(domains) {
    for (const c of await nativeCookieJar.read(domains)) {
      await CookieManager.clearByName(urlFor(c.domain), c.name, WEBKIT);
    }
    await CookieManager.flush().catch(() => {});
  },

  async clearAll() {
    await CookieManager.clearAllStores();
    await CookieManager.flush().catch(() => {});
  },
};

/** AES-256-GCM through expo-crypto. Output is base64(iv | ciphertext | tag), as webCryptoCipher. */
export const nativeCipher: SessionCipher = {
  async encrypt(plaintext, keyB64, aad) {
    const key = await AESEncryptionKey.import(keyB64, "base64");
    const sealed = await aesEncryptAsync(utf8Encode(plaintext), key, {
      nonce: { length: 12 },
      tagLength: 16,
      additionalData: utf8Encode(aad),
    });
    return bytesToBase64(await sealed.combined("bytes"));
  },
  async decrypt(sealedB64, keyB64, aad) {
    const key = await AESEncryptionKey.import(keyB64, "base64");
    const sealed = AESSealedData.fromCombined(base64ToBytes(sealedB64), {
      ivLength: 12,
      tagLength: 16,
    });
    const plain = await aesDecryptAsync(sealed, key, { additionalData: utf8Encode(aad) });
    return utf8Decode(plain);
  },
};

export const supabaseSessionKeys: SessionKeyService = {
  async fetchKey(connectionId) {
    const { data, error } = await getSupabase().rpc("connection_session_key", {
      connection_id: connectionId,
    });
    if (error || typeof data !== "string") throw new Error(error?.message ?? "no session key");
    return data;
  },
  async revoke(connectionId) {
    const { error } = await getSupabase().rpc("revoke_browser_connection", {
      connection_id: connectionId,
    });
    if (error) throw new Error(error.message);
  },
};

export function nativeSessionVault(): SessionVault {
  return createSessionVault({
    store: nativeSecureStore,
    cookies: nativeCookieJar,
    keys: supabaseSessionKeys,
    cipher: nativeCipher,
  });
}
