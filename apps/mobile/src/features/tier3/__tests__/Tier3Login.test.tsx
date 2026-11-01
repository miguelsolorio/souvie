// WS08: Tier3Login's wiring. The sign-in WebView knows the retailer's own hosts (fix round item 7),
// and when the session cannot be sealed the screen revokes the connection it just made through
// revoke_browser_connection and shows the error (re-review item 3). The WebView is stood in.
import type { MpClient } from "@mp/db";
import type { SnapshotTree } from "@mp/retailers";
import { createElement, useEffect } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  last: null as Record<string, unknown> | null,
  host: null as unknown,
  deps: null as unknown,
}));

vi.mock("react-native", () => ({
  View: "View",
  Text: "Text",
  Pressable: "Pressable",
  ActivityIndicator: "ActivityIndicator",
  AppState: { addEventListener: () => ({ remove: () => {} }) },
}));

vi.mock("../WebViewHost", () => ({
  WebViewHost: (props: Record<string, unknown>) => {
    harness.last = props;
    useEffect(() => {
      if (harness.host) (props.onHost as (h: unknown) => void)?.(harness.host);
    }, [props.onHost]);
    return null;
  },
}));

// The real finishTier3SignIn, with test deps in place of the device's native modules.
vi.mock("../useTier3Session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../useTier3Session")>()),
  appTier3SessionDeps: () => harness.deps,
}));

import { createSessionVault } from "../secureSession";
import { tier3Store } from "../stores";
import { Tier3Login } from "../Tier3Login";
import { fakeCookieJar, memorySecureStore, nodeCipher } from "./sessionFakes";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const HOUSEHOLD = "0a000000-0000-4000-8000-00000000000a";
const CONNECTION = "c0000000-0000-4000-8000-0000000000a1";
const KEY = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=";

describe("Tier3Login", () => {
  it("opens the store's own site with the retailer's hosts as the allowed hosts", async () => {
    harness.host = null;
    for (const [id, hosts] of [
      ["albertsons", ["safeway.com", "albertsons.com", "haggen.com"]],
      ["costco", ["costco.com"]],
    ] as const) {
      await act(async () => {
        create(
          createElement(Tier3Login, {
            store: tier3Store(id),
            householdId: HOUSEHOLD,
            client: {} as MpClient,
            onConnected: () => {},
          }),
        );
      });
      expect(harness.last?.initialUrl).toBe(tier3Store(id).homeUrl);
      expect(harness.last?.allowedHosts).toEqual(hosts);
    }
  });

  it("revokes the new connection through revoke_browser_connection when the seal fails", async () => {
    const tree: SnapshotTree = {
      url: "https://www.safeway.com/",
      title: "Safeway",
      capturedAt: "2026-10-31T18:00:00.000Z",
      root: {
        id: "r",
        role: "document",
        name: "Safeway",
        bbox: [0, 0, 1, 1],
        children: [{ id: "a", role: "button", name: "Account", bbox: [0, 0, 1, 1] }],
      },
    };
    harness.host = {
      isReady: () => true,
      snapshot: async () => tree,
      readStorage: async () => ({
        origin: "https://www.safeway.com",
        localStorage: {},
        sessionStorage: {},
      }),
      clearPageStorage: vi.fn(),
    };
    const jar = fakeCookieJar([
      { name: "SWY_SESSION", value: "secret", domain: ".safeway.com", path: "/" },
    ]);
    harness.deps = {
      // No keychain: the session cannot be sealed.
      vault: createSessionVault({
        store: memorySecureStore(false),
        cookies: jar,
        keys: { fetchKey: async () => KEY, revoke: async () => {} },
        cipher: nodeCipher(),
      }),
      cookies: jar,
    };
    const rpc = vi.fn(async (fn: string) =>
      fn === "connect_browser_session"
        ? { data: CONNECTION, error: null }
        : { data: null, error: null },
    );
    const onConnected = vi.fn();
    let renderer: ReactTestRenderer | null = null;
    await act(async () => {
      renderer = create(
        createElement(Tier3Login, {
          store: tier3Store("safeway"),
          householdId: HOUSEHOLD,
          client: { rpc } as unknown as MpClient,
          onConnected,
        }),
      );
    });
    const root = (renderer as unknown as ReactTestRenderer).root;
    // The screen checks for a signed-in page every two seconds.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 2200));
    });
    const finish = root.findAll(
      (n) => n.props.testID === "tier3-finish" && typeof n.type === "string",
    )[0];
    expect(finish?.props.disabled).toBe(false);
    await act(async () => {
      finish?.props.onPress();
      await new Promise((r) => setTimeout(r, 50));
    });

    expect(rpc).toHaveBeenCalledWith("connect_browser_session", {
      household_id: HOUSEHOLD,
      retailer: "safeway",
    });
    expect(rpc).toHaveBeenCalledWith("revoke_browser_connection", { connection_id: CONNECTION });
    expect(onConnected).not.toHaveBeenCalled();
    expect(jar.all()).toEqual([]);
    const alerts = root.findAll(
      (n) => (n.type as unknown) === "Text" && n.props.accessibilityRole === "alert",
    );
    expect(alerts).toHaveLength(1);
  }, 10_000);
});
