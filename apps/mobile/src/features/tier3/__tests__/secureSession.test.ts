// WS08 criterion 8: the session after a simulated sign-in on the test page is one encrypted
// expo-secure-store entry keyed by connection id, round-trips, and Disconnect wipes it, the
// WebView cookies, and the Vault key, and leaves the connection revoked. The key functions are the
// migration's own (PGlite); the cipher is AES-256-GCM over Web Crypto, the format the device uses.
import { findByRole } from "@mp/retailers";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  BLOB_PREFIX,
  type Cookie,
  createSessionVault,
  type SessionState,
  SessionUnavailableError,
  sanitizeSession,
  sessionStorageKey,
} from "../secureSession";
import { createPageHarness, type PageHarness, TEST_PAGE_URL } from "./jsdomPage";
import {
  ALICE,
  CAROL,
  fakeCookieJar,
  memorySecureStore,
  nodeCipher,
  type SeededDb,
  seededDb,
} from "./sessionFakes";

const TEST_PASSWORD = "hunter2-test-password";

let db: SeededDb;
let page: PageHarness | null = null;

beforeAll(async () => {
  db = await seededDb();
}, 120_000);

afterAll(async () => {
  await db?.t.close();
});

afterEach(() => {
  page?.close();
  page = null;
});

/** Signs in on the test page the way a person does, and returns what a session save captures. */
async function signInOnTestPage(): Promise<{ state: SessionState; cookies: Cookie[] }> {
  page = createPageHarness();
  await page.host.navigate(`${TEST_PAGE_URL}?signin=1`);
  const tree = await page.host.snapshot();
  const [email] = findByRole(tree, "textbox", "Email");
  const [continueButton] = findByRole(tree, "button", "Continue");
  if (!email || !continueButton) throw new Error("no sign-in form");
  await page.host.type(email.id, "test.shopper@example.test");
  // The person types the password into the retailer's own field; the agent never does.
  (page.window().document.getElementById("password") as HTMLInputElement).value = TEST_PASSWORD;
  await page.host.click(continueButton.id);

  const cookies: Cookie[] = page
    .window()
    .document.cookie.split(";")
    .map((pair) => pair.trim())
    .filter(Boolean)
    .map((pair) => {
      const [name = "", ...rest] = pair.split("=");
      return { name, value: rest.join("="), domain: "localhost", path: "/" };
    });
  const storage = await page.host.readStorage();
  return {
    cookies,
    state: {
      cookies,
      localStorage: storage.localStorage,
      sessionStorage: storage.sessionStorage,
      savedAt: "2026-10-31T18:00:00.000Z",
      origin: storage.origin,
    },
  };
}

describe("secureSession", () => {
  it("saves one ciphertext entry keyed by connection id, and loads it back", async () => {
    const connectionId = await db.connect("safeway");
    const { state, cookies } = await signInOnTestPage();
    expect(cookies.map((c) => c.name)).toEqual(["fixture_session"]);
    expect(state.localStorage).toEqual({ "fixture.account": "signed-in" });

    const store = memorySecureStore();
    const vault = createSessionVault({
      store,
      cookies: fakeCookieJar(),
      keys: db.keysFor(ALICE),
      cipher: nodeCipher(),
    });
    await vault.saveSession(connectionId, state);

    expect([...store.items.keys()]).toEqual([sessionStorageKey(connectionId)]);
    expect(sessionStorageKey(connectionId)).toBe(`tier3.session.${connectionId}`);
    const blob = store.items.get(sessionStorageKey(connectionId)) ?? "";
    expect(blob.startsWith(BLOB_PREFIX)).toBe(true);
    // Ciphertext: no part of the password, no cookie or storage name, no value in plaintext.
    for (const plain of [
      TEST_PASSWORD,
      "hunter2",
      "fixture_session",
      "signed-in",
      "fixture.account",
      "localhost",
      "cookies",
    ]) {
      expect(blob).not.toContain(plain);
    }

    // A fresh vault (a later run) fetches the same key from Vault and opens the blob.
    const later = createSessionVault({
      store,
      cookies: fakeCookieJar(),
      keys: db.keysFor(ALICE),
      cipher: nodeCipher(),
    });
    expect(await later.loadSession(connectionId)).toEqual(state);
    expect(JSON.stringify(state)).not.toContain(TEST_PASSWORD);
  });

  it("wipeSession removes the entry, clears the WebView cookies, deletes the Vault key and revokes", async () => {
    const connectionId = await db.connect("costco");
    const { state } = await signInOnTestPage();
    const store = memorySecureStore();
    const cookies = fakeCookieJar([
      { name: "member", value: "x", domain: ".costco.com", path: "/" },
    ]);
    const vault = createSessionVault({
      store,
      cookies,
      keys: db.keysFor(ALICE),
      cipher: nodeCipher(),
    });
    await vault.saveSession(connectionId, state);
    expect(await db.vaultSecretCount(connectionId)).toBe(1);
    expect(await db.status(connectionId)).toBe("active");

    await vault.wipeSession(connectionId);

    expect(store.items.size).toBe(0);
    expect(store.deleteItemAsync).toHaveBeenCalledWith(sessionStorageKey(connectionId));
    expect(cookies.clearAll).toHaveBeenCalledTimes(1);
    expect(cookies.all()).toEqual([]);
    expect(await db.vaultSecretCount(connectionId)).toBe(0);
    expect(await db.status(connectionId)).toBe("revoked");
    // Nothing can open a blob for it any more.
    await expect(db.keysFor(ALICE).fetchKey(connectionId)).rejects.toThrow("connection_revoked");
  });

  it("another member of the household cannot get the key, so cannot open the blob", async () => {
    const connectionId = await db.connect("safeway");
    const { state } = await signInOnTestPage();
    const store = memorySecureStore();
    const own = createSessionVault({
      store,
      cookies: fakeCookieJar(),
      keys: db.keysFor(ALICE),
      cipher: nodeCipher(),
    });
    await own.saveSession(connectionId, state);
    const other = createSessionVault({
      store,
      cookies: fakeCookieJar(),
      keys: db.keysFor(CAROL),
      cipher: nodeCipher(),
    });
    await expect(other.loadSession(connectionId)).rejects.toThrow("not_allowed");
  });

  it("fails closed when the secure store is unavailable: no save, nothing loaded", async () => {
    const connectionId = await db.connect("safeway");
    const store = memorySecureStore(false);
    const vault = createSessionVault({
      store,
      cookies: fakeCookieJar(),
      keys: db.keysFor(ALICE),
      cipher: nodeCipher(),
    });
    const state: SessionState = {
      cookies: [],
      localStorage: {},
      sessionStorage: {},
      savedAt: "2026-10-31T18:00:00.000Z",
      origin: "https://www.safeway.com",
    };
    await expect(vault.saveSession(connectionId, state)).rejects.toBeInstanceOf(
      SessionUnavailableError,
    );
    expect(store.setItemAsync).not.toHaveBeenCalled();
    expect(await vault.loadSession(connectionId)).toBeNull();
  });

  it("drops a blob the current key cannot open (a reconnect made a new key)", async () => {
    const connectionId = await db.connect("safeway");
    const store = memorySecureStore();
    store.items.set(sessionStorageKey(connectionId), `${BLOB_PREFIX}AAAAAAAAAAAAAAAAAAAAAAAAAAAA`);
    const vault = createSessionVault({
      store,
      cookies: fakeCookieJar(),
      keys: db.keysFor(ALICE),
      cipher: nodeCipher(),
    });
    expect(await vault.loadSession(connectionId)).toBeNull();
    expect(store.items.size).toBe(0);
  });

  it("never keeps a storage entry or cookie named like a password", () => {
    const clean = sanitizeSession({
      cookies: [
        { name: "sid", value: "1", domain: "safeway.com", path: "/" },
        { name: "remember_password", value: "x", domain: "safeway.com", path: "/" },
      ],
      localStorage: { cart: "3", savedPassword: TEST_PASSWORD, __mp_tier3_restored_abc: "1" },
      sessionStorage: { pwd: TEST_PASSWORD, step: "2" },
      savedAt: "2026-10-31T18:00:00.000Z",
      origin: "https://www.safeway.com",
    });
    expect(clean.cookies.map((c) => c.name)).toEqual(["sid"]);
    expect(clean.localStorage).toEqual({ cart: "3" });
    expect(clean.sessionStorage).toEqual({ step: "2" });
    expect(JSON.stringify(clean)).not.toContain(TEST_PASSWORD);
  });

  it("refuses a malformed connection id as a storage key", () => {
    expect(() => sessionStorageKey("../../etc")).toThrow();
  });
});
