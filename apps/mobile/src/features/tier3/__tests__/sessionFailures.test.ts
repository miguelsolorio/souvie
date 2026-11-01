// WS08 fix round, items 3 and 4 (lifted from the reviewer's reproductions): the failure paths of a
// session. A failed save must still clear the plaintext copy and must not leave an active
// connection with no sealed blob; Disconnect must run every step even when one fails. The key
// functions are the migration's own, on PGlite.
import { afterAll, afterEach, beforeAll, describe, expect, it, type Mock, vi } from "vitest";

vi.mock("react-native", () => ({
  AppState: { addEventListener: () => ({ remove: () => {} }) },
}));

import { createSessionVault, SessionUnavailableError, sessionStorageKey } from "../secureSession";
import { createTier3Session, finishTier3SignIn } from "../useTier3Session";
import { createPageHarness, type PageHarness, TEST_PAGE_URL } from "./jsdomPage";
import {
  ALICE,
  fakeCookieJar,
  HOUSEHOLD,
  memorySecureStore,
  nodeCipher,
  type SeededDb,
  seededDb,
} from "./sessionFakes";

const SESSION_COOKIE = {
  name: "SWY_SHARED_SESSION",
  value: "secret-session-value",
  domain: ".safeway.com",
  path: "/",
};

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

async function openWithStorage() {
  page = createPageHarness();
  await page.host.navigate(TEST_PAGE_URL);
  page.window().localStorage.setItem("site.session", "plaintext");
  return page;
}

/** The two RPCs Tier3Login calls, as alice, against the migration. */
function signInRpcs() {
  const keys = db.keysFor(ALICE);
  return {
    connect: vi.fn(async (_householdId: string, retailer: "safeway" | "costco") =>
      db.connect(retailer),
    ),
    revoke: vi.fn((connectionId: string) => keys.revoke(connectionId)),
  };
}

describe("item 4: wipeSession runs every step", () => {
  it("a cookie-store error still deletes the entry and the Vault key, revokes, and is rethrown", async () => {
    const connectionId = await db.connect("safeway");
    const store = memorySecureStore();
    const jar = fakeCookieJar([SESSION_COOKIE]);
    const vault = createSessionVault({
      store,
      cookies: jar,
      keys: db.keysFor(ALICE),
      cipher: nodeCipher(),
    });
    await vault.saveSession(connectionId, {
      cookies: [SESSION_COOKIE],
      localStorage: { a: "1" },
      sessionStorage: {},
      savedAt: "2026-10-31T18:00:00.000Z",
      origin: "https://www.safeway.com",
    });
    (jar.clearAll as unknown as Mock).mockImplementationOnce(async () => {
      throw new Error("native cookie store unavailable");
    });
    await expect(vault.wipeSession(connectionId)).rejects.toThrow("native cookie store");
    expect(store.items.has(sessionStorageKey(connectionId))).toBe(false);
    expect(await db.vaultSecretCount(connectionId)).toBe(0);
    expect(await db.status(connectionId)).toBe("revoked");
  });

  it("a failing secure-store delete still revokes, and the first error is the one rethrown", async () => {
    const connectionId = await db.connect("costco");
    const store = memorySecureStore();
    (store.deleteItemAsync as unknown as Mock).mockImplementationOnce(async () => {
      throw new Error("keychain locked");
    });
    const revoke = vi.fn(async () => {
      throw new Error("offline");
    });
    const vault = createSessionVault({
      store,
      cookies: fakeCookieJar(),
      keys: { fetchKey: db.keysFor(ALICE).fetchKey, revoke },
      cipher: nodeCipher(),
    });
    await expect(vault.wipeSession(connectionId)).rejects.toThrow("keychain locked");
    expect(revoke).toHaveBeenCalledWith(connectionId);
  });
});

describe("item 3: a failed save clears the plaintext copy and leaves no active row without a blob", () => {
  it("save({ clear: true }) clears the cookies and the page storage even when sealing fails", async () => {
    const connectionId = await db.connect("safeway");
    const p = await openWithStorage();
    const jar = fakeCookieJar([SESSION_COOKIE]);
    const vault = createSessionVault({
      store: memorySecureStore(false), // no keychain: fail closed
      cookies: jar,
      keys: db.keysFor(ALICE),
      cipher: nodeCipher(),
    });
    const session = createTier3Session(
      { connectionId, retailer: "safeway" },
      { vault, cookies: jar },
    );
    await expect(session.save(p.host, { clear: true })).rejects.toBeInstanceOf(
      SessionUnavailableError,
    );
    expect(jar.clearDomains).toHaveBeenCalledWith(["safeway.com", "albertsons.com", "haggen.com"]);
    expect(jar.all()).toEqual([]);
    await new Promise((r) => setTimeout(r, 10));
    expect(p.window().localStorage.length).toBe(0);
  });

  it("finishing sign-in with no keychain revokes the new connection and clears the WebView", async () => {
    const p = await openWithStorage();
    const jar = fakeCookieJar([SESSION_COOKIE]);
    const rpc = signInRpcs();
    const vault = createSessionVault({
      store: memorySecureStore(false),
      cookies: jar,
      keys: db.keysFor(ALICE),
      cipher: nodeCipher(),
    });
    await expect(
      finishTier3SignIn({
        householdId: HOUSEHOLD,
        retailer: "safeway",
        host: p.host,
        rpc,
        deps: { vault, cookies: jar },
      }),
    ).rejects.toBeInstanceOf(SessionUnavailableError);
    const connectionId = await rpc.connect.mock.results[0]?.value;
    expect(rpc.revoke).toHaveBeenCalledWith(connectionId);
    expect(await db.status(connectionId)).toBe("revoked");
    expect(await db.vaultSecretCount(connectionId)).toBe(0);
    expect(jar.all()).toEqual([]);
    await new Promise((r) => setTimeout(r, 10));
    expect(p.window().localStorage.length).toBe(0);
  });

  it("finishing sign-in normally leaves an active row, one sealed entry, and no plaintext", async () => {
    const p = await openWithStorage();
    const jar = fakeCookieJar([SESSION_COOKIE]);
    const store = memorySecureStore();
    const rpc = signInRpcs();
    const vault = createSessionVault({
      store,
      cookies: jar,
      keys: db.keysFor(ALICE),
      cipher: nodeCipher(),
    });
    const connectionId = await finishTier3SignIn({
      householdId: HOUSEHOLD,
      retailer: "safeway",
      host: p.host,
      rpc,
      deps: { vault, cookies: jar },
    });
    expect(rpc.revoke).not.toHaveBeenCalled();
    expect(await db.status(connectionId)).toBe("active");
    expect([...store.items.keys()]).toEqual([sessionStorageKey(connectionId)]);
    expect(jar.all()).toEqual([]);
    // The sealed session restores the cookie that was cleared.
    const later = createTier3Session(
      { connectionId, retailer: "safeway" },
      { vault, cookies: jar },
    );
    expect((await later.restore("run0123456789abcd")).status).toBe("restored");
    expect(jar.all()).toEqual([SESSION_COOKIE]);
  });
});
