// WS08: a session through a run. Restore before the first navigation, save after, only the
// retailer's own cookies, nothing left in plaintext at the end, a save when the app goes to the
// background, and a fail-closed path when the device cannot keep a session.
import { findByRole, type Tier3RetailerId } from "@mp/retailers";
import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const appState = vi.hoisted(() => ({
  listeners: [] as ((state: string) => void)[],
}));

vi.mock("react-native", () => ({
  AppState: {
    addEventListener: (_type: string, cb: (state: string) => void) => {
      appState.listeners.push(cb);
      return {
        remove: () => {
          appState.listeners = appState.listeners.filter((l) => l !== cb);
        },
      };
    },
  },
}));

import type { BridgeHost, StorageDump } from "../bridgeHost";
import {
  type Cookie,
  createSessionVault,
  type SessionState,
  type SessionVault,
} from "../secureSession";
import {
  buildStorageRestoreScript,
  createTier3Session,
  looksSignedIn,
  sessionFingerprint,
  useTier3Session,
} from "../useTier3Session";
import { createPageHarness, type PageHarness, TEST_PAGE_URL } from "./jsdomPage";
import { fakeCookieJar, memorySecureStore, nodeCipher } from "./sessionFakes";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const CONNECTION = "c0000000-0000-4000-8000-0000000000a1";
const KEY = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8="; // 32 bytes

function memoryVault(available = true) {
  const store = memorySecureStore(available);
  const keys = { fetchKey: vi.fn(async () => KEY), revoke: vi.fn(async () => {}) };
  const vault = createSessionVault({ store, cookies: fakeCookieJar(), keys, cipher: nodeCipher() });
  return { vault, store, keys };
}

function fakeHost(
  storage: StorageDump = {
    origin: "https://www.safeway.com",
    localStorage: { cart: "2" },
    sessionStorage: { step: "1" },
  },
) {
  return {
    readStorage: vi.fn(async () => storage),
    clearPageStorage: vi.fn(),
  } as unknown as BridgeHost & {
    readStorage: ReturnType<typeof vi.fn>;
    clearPageStorage: ReturnType<typeof vi.fn>;
  };
}

const SAFEWAY_COOKIES: Cookie[] = [
  { name: "SWY_SESSION", value: "abc", domain: ".safeway.com", path: "/", httpOnly: true },
  { name: "abs_pref", value: "store-1", domain: "www.albertsons.com", path: "/" },
  { name: "_tracker", value: "t", domain: ".ads.example", path: "/" },
  { name: "costco_member", value: "m", domain: ".costco.com", path: "/" },
];

let page: PageHarness | null = null;
afterEach(() => {
  page?.close();
  page = null;
});

beforeEach(() => {
  appState.listeners = [];
});

describe("createTier3Session", () => {
  it("keeps only the retailer's own cookies and its origin's storage", async () => {
    const { vault, store } = memoryVault();
    const cookies = fakeCookieJar(SAFEWAY_COOKIES);
    const session = createTier3Session(
      { connectionId: CONNECTION, retailer: "safeway" },
      { vault, cookies, now: () => new Date("2026-10-31T18:00:00.000Z") },
    );
    const state = await session.capture(fakeHost());
    expect(state.cookies.map((c) => c.name)).toEqual(["SWY_SESSION", "abs_pref"]);
    expect(state.localStorage).toEqual({ cart: "2" });
    expect(state.origin).toBe("https://www.safeway.com");
    await session.signedIn(fakeHost());
    expect(store.items.size).toBe(1);

    // Storage from a page off the retailer's site is not kept.
    const offsite = await session.capture(
      fakeHost({ origin: "https://login.example", localStorage: { x: "1" }, sessionStorage: {} }),
    );
    expect(offsite.localStorage).toEqual({});
    expect(offsite.origin).toBe("");
  });

  it("restores before a run: cookies into the WebView store and a one-time storage script", async () => {
    const { vault } = memoryVault();
    const saved: SessionState = {
      cookies: SAFEWAY_COOKIES.slice(0, 2),
      localStorage: { cart: "2" },
      sessionStorage: { step: "1" },
      savedAt: "2026-10-31T18:00:00.000Z",
      origin: "https://www.safeway.com",
    };
    await vault.saveSession(CONNECTION, saved);
    const cookies = fakeCookieJar();
    const session = createTier3Session(
      { connectionId: CONNECTION, retailer: "safeway" },
      { vault, cookies },
    );
    const result = await session.restore("run0123456789abcd");
    expect(result.status).toBe("restored");
    expect(cookies.write).toHaveBeenCalledWith(SAFEWAY_COOKIES.slice(0, 2));
    if (result.status !== "restored") throw new Error("not restored");
    expect(result.restoreScript).toContain('"https://www.safeway.com"');
  });

  it("says needs_sign_in when nothing is saved, and unavailable when the device cannot keep one", async () => {
    const empty = createTier3Session(
      { connectionId: CONNECTION, retailer: "costco" },
      { vault: memoryVault().vault, cookies: fakeCookieJar() },
    );
    expect(await empty.restore("run0123456789abcd")).toEqual({ status: "needs_sign_in" });

    const throwing: SessionVault = {
      ...memoryVault().vault,
      loadSession: async () => {
        const { SessionUnavailableError } = await import("../secureSession");
        throw new SessionUnavailableError();
      },
    };
    const unavailable = createTier3Session(
      { connectionId: CONNECTION, retailer: "costco" },
      { vault: throwing, cookies: fakeCookieJar() },
    );
    expect(await unavailable.restore("run0123456789abcd")).toEqual({ status: "unavailable" });
  });

  it("re-saves after a run only when the session changed, then clears the plaintext copy", async () => {
    const { vault, store } = memoryVault();
    const cookies = fakeCookieJar(SAFEWAY_COOKIES);
    const session = createTier3Session(
      { connectionId: CONNECTION, retailer: "safeway" },
      { vault, cookies },
    );
    const host = fakeHost();
    await session.signedIn(host);
    expect(store.setItemAsync).toHaveBeenCalledTimes(1);

    expect(await session.save(host)).toBe("unchanged");
    expect(store.setItemAsync).toHaveBeenCalledTimes(1);

    cookies.set([
      { ...SAFEWAY_COOKIES[0], value: "rotated" } as Cookie,
      ...SAFEWAY_COOKIES.slice(1),
    ]);
    expect(await session.save(host, { clear: true })).toBe("saved");
    expect(store.setItemAsync).toHaveBeenCalledTimes(2);
    expect(cookies.clearDomains).toHaveBeenCalledWith([
      "safeway.com",
      "albertsons.com",
      "haggen.com",
    ]);
    expect(cookies.all().map((c) => c.name)).toEqual(["_tracker", "costco_member"]);
    expect(host.clearPageStorage).toHaveBeenCalledTimes(1);
  });

  it("fingerprints ignore the save time and cookie order", () => {
    const a: SessionState = {
      cookies: SAFEWAY_COOKIES.slice(0, 2),
      localStorage: { b: "2", a: "1" },
      sessionStorage: {},
      savedAt: "2026-10-31T18:00:00.000Z",
      origin: "https://www.safeway.com",
    };
    const b = { ...a, cookies: [...a.cookies].reverse(), savedAt: "2026-11-01T00:00:00.000Z" };
    expect(sessionFingerprint(a)).toBe(sessionFingerprint(b));
  });
});

describe("storage restore script", () => {
  it("puts storage back once per run, on the session's origin only", async () => {
    const state: SessionState = {
      cookies: [],
      localStorage: { "fixture.account": "signed-in" },
      sessionStorage: { "fixture.visit": "1" },
      savedAt: "2026-10-31T18:00:00.000Z",
      origin: "http://localhost:8790",
    };
    const script = buildStorageRestoreScript(state, "run0123456789abcd") ?? "";
    page = createPageHarness();
    await page.host.navigate(TEST_PAGE_URL);
    const win = page.window();
    win.eval(script);
    expect(win.localStorage.getItem("fixture.account")).toBe("signed-in");
    win.localStorage.setItem("fixture.account", "changed by the site");
    win.eval(script);
    expect(win.localStorage.getItem("fixture.account")).toBe("changed by the site");

    const elsewhere =
      buildStorageRestoreScript(
        { ...state, origin: "https://www.safeway.com" },
        "r2abcdefghijklmno",
      ) ?? "";
    win.localStorage.clear();
    win.eval(elsewhere);
    expect(win.localStorage.length).toBe(0);
    expect(
      buildStorageRestoreScript({ ...state, localStorage: {}, sessionStorage: {} }, "x"),
    ).toBeNull();
  });
});

describe("looksSignedIn", () => {
  it("reads the test page as signed out before the fake sign-in and signed in after", async () => {
    page = createPageHarness();
    await page.host.navigate(`${TEST_PAGE_URL}?signin=1`);
    expect(looksSignedIn(await page.host.snapshot(), TEST_PAGE_URL)).toBe(false);
    const doc = page.window().document;
    (doc.getElementById("password") as HTMLInputElement).value = "x";
    (doc.getElementById("signin") as HTMLFormElement).requestSubmit();
    const tree = await page.host.snapshot();
    expect(findByRole(tree, "button", "Account")).toHaveLength(1);
    expect(looksSignedIn(tree, TEST_PAGE_URL)).toBe(true);
    expect(looksSignedIn(tree, "https://www.safeway.com/account/sign-in.html")).toBe(false);
  });
});

describe("useTier3Session", () => {
  function Probe(props: {
    target: { connectionId: string; retailer: Tier3RetailerId } | null;
    deps: Parameters<typeof useTier3Session>[1];
    onValue: (v: ReturnType<typeof useTier3Session>) => void;
  }) {
    props.onValue(useTier3Session(props.target, props.deps));
    return null;
  }

  it("restores, saves on background, and saves with a clear at run end", async () => {
    const { vault, store } = memoryVault();
    const cookies = fakeCookieJar(SAFEWAY_COOKIES);
    let hook: ReturnType<typeof useTier3Session> | null = null;
    let renderer: ReactTestRenderer | null = null;
    await act(async () => {
      renderer = create(
        createElement(Probe, {
          target: { connectionId: CONNECTION, retailer: "safeway" },
          deps: { vault, cookies },
          onValue: (v) => {
            hook = v;
          },
        }),
      );
    });
    const current = () => {
      if (!hook) throw new Error("hook not rendered");
      return hook;
    };
    expect(current().status).toBe("idle");
    await act(async () => {
      await current().restore("run0123456789abcd");
    });
    expect(current().status).toBe("needs_sign_in");

    const host = fakeHost();
    current().attach(host);
    expect(appState.listeners).toHaveLength(1);
    await act(async () => {
      for (const l of appState.listeners) l("background");
      await new Promise((r) => setTimeout(r, 10));
    });
    expect(store.setItemAsync).toHaveBeenCalledTimes(1);
    expect(current().status).toBe("ready");

    await act(async () => {
      expect(await current().save({ clear: true })).toBe("unchanged");
    });
    expect(host.clearPageStorage).toHaveBeenCalledTimes(1);

    await act(async () => {
      (renderer as unknown as ReactTestRenderer).unmount();
    });
    expect(appState.listeners).toHaveLength(0);
  });

  it("does nothing without a connection", async () => {
    let hook: ReturnType<typeof useTier3Session> | null = null;
    await act(async () => {
      create(
        createElement(Probe, {
          target: null,
          deps: { vault: memoryVault().vault, cookies: fakeCookieJar() },
          onValue: (v) => {
            hook = v;
          },
        }),
      );
    });
    const h = hook as unknown as ReturnType<typeof useTier3Session>;
    expect(h.session).toBeNull();
    expect(await h.restore("run0123456789abcd")).toBeNull();
    expect(appState.listeners).toHaveLength(0);
  });
});
