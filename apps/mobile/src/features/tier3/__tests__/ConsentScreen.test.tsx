// WS08 criterion 6: the consent screen and the Tier 3 branch of the connect flow. Rendered with
// react-test-renderer over stand-in React Native host components. The union of retailers is
// checked against the real record_tier3_consent (the migration on PGlite), not a fake.
import type { Tier3Consent } from "@mp/retailers";
import { createElement } from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("react-native", () => ({
  View: "View",
  Text: "Text",
  ScrollView: "ScrollView",
  Pressable: "Pressable",
  ActivityIndicator: "ActivityIndicator",
}));

import type { RpcClient } from "../api";
import { ConsentScreen } from "../ConsentScreen";
import { CONSENT_VERSION, renderConsentCopy } from "../consent";
import { tier3Store } from "../stores";
import { Tier3ConnectFlow } from "../Tier3ConnectFlow";
import { ALICE, HOUSEHOLD, type SeededDb, seededDb } from "./sessionFakes";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let db: SeededDb;

beforeAll(async () => {
  db = await seededDb();
}, 120_000);

afterAll(async () => {
  await db?.t.close();
});

/** A supabase-js rpc that runs the migration's record_tier3_consent as alice. */
function databaseClient(): RpcClient & { calls: unknown[] } {
  const calls: unknown[] = [];
  return {
    calls,
    rpc: (async (fn: string, args: Record<string, unknown>) => {
      calls.push({ fn, args });
      try {
        const rows = await db.t.run({ sub: ALICE }, (q) =>
          q<{ v: unknown }>("select public.record_tier3_consent($1, $2, $3) as v", [
            args.household_id,
            args.retailers,
            args.copy_version,
          ]),
        );
        return { data: rows[0]?.v ?? null, error: null };
      } catch (err) {
        return { data: null, error: { message: (err as Error).message } };
      }
    }) as unknown as RpcClient["rpc"],
  };
}

function host(root: ReactTestInstance, testID: string): ReactTestInstance {
  const found = root.findAll((n) => n.props.testID === testID && typeof n.type === "string");
  if (found.length !== 1) throw new Error(`expected one ${testID}, found ${found.length}`);
  return found[0] as ReactTestInstance;
}

function has(root: ReactTestInstance, testID: string): boolean {
  return root.findAll((n) => n.props.testID === testID && typeof n.type === "string").length > 0;
}

async function render(element: ReturnType<typeof createElement>): Promise<ReactTestRenderer> {
  let renderer: ReactTestRenderer | null = null;
  await act(async () => {
    renderer = create(element);
  });
  return renderer as unknown as ReactTestRenderer;
}

async function scrollToEnd(root: ReactTestInstance, y = 900) {
  const scroll = host(root, "consent-scroll");
  await act(async () => {
    scroll.props.onLayout({ nativeEvent: { layout: { height: 600 } } });
    scroll.props.onContentSizeChange(390, 1500);
  });
  await act(async () => {
    scroll.props.onScroll({
      nativeEvent: {
        contentOffset: { y },
        contentSize: { height: 1500 },
        layoutMeasurement: { height: 600 },
      },
    });
  });
}

async function check(root: ReactTestInstance) {
  await act(async () => {
    host(root, "consent-ack").props.onPress();
  });
}

const continueDisabled = (root: ReactTestInstance) => host(root, "consent-continue").props.disabled;

describe("ConsentScreen", () => {
  it("keeps continue disabled until the copy is scrolled to the end and the box is checked", async () => {
    const client = databaseClient();
    const r = await render(
      createElement(ConsentScreen, {
        store: tier3Store("safeway"),
        householdId: HOUSEHOLD,
        client,
        onAccepted: () => {},
      }),
    );
    const root = r.root;
    expect(continueDisabled(root)).toBe(true);
    await check(root);
    expect(host(root, "consent-ack").props.accessibilityState).toEqual({ checked: true });
    expect(continueDisabled(root)).toBe(true); // checked, not scrolled
    await check(root);
    await scrollToEnd(root, 400); // not far enough
    expect(has(root, "consent-scroll-hint")).toBe(true);
    await scrollToEnd(root);
    expect(has(root, "consent-scroll-hint")).toBe(false);
    expect(continueDisabled(root)).toBe(true); // scrolled, not checked
    await check(root);
    expect(continueDisabled(root)).toBe(false);
    // Pressing a disabled continue does nothing.
    expect(client.calls).toEqual([]);
  });

  it("renders the approved copy with the store's name", async () => {
    const r = await render(
      createElement(ConsentScreen, {
        store: tier3Store("albertsons"),
        householdId: HOUSEHOLD,
        client: databaseClient(),
        onAccepted: () => {},
      }),
    );
    const texts = r.root
      .findAll((n) => (n.type as unknown) === "Text")
      .map((n) => (n.children as unknown[]).join(""));
    const copy = renderConsentCopy("Albertsons");
    expect(texts).toContain("Before Souvie shops at Albertsons");
    for (const section of copy.sections) {
      expect(texts).toContain(section.heading);
      expect(texts).toContain(section.body);
    }
    expect(texts).toContain(copy.acknowledgment);
    expect(texts.join(" ")).not.toContain("{store}");
  });

  it("accepting calls record_tier3_consent with the retailer and CONSENT_VERSION", async () => {
    const accepted: Tier3Consent[] = [];
    const rpc = vi.fn(async () => ({
      data: {
        accepted_at: "2026-10-31T18:00:00.000000+00:00",
        by_user_id: ALICE,
        retailers: ["safeway"],
        copy_version: CONSENT_VERSION,
      },
      error: null,
    }));
    const r = await render(
      createElement(ConsentScreen, {
        // Albertsons is a banner of the safeway retailer: consent is recorded for "safeway".
        store: tier3Store("albertsons"),
        householdId: HOUSEHOLD,
        client: { rpc } as unknown as RpcClient,
        onAccepted: (c) => accepted.push(c),
      }),
    );
    await scrollToEnd(r.root);
    await check(r.root);
    await act(async () => {
      host(r.root, "consent-continue").props.onPress();
    });
    expect(rpc).toHaveBeenCalledWith("record_tier3_consent", {
      household_id: HOUSEHOLD,
      retailers: ["safeway"],
      copy_version: "2026-10-31",
    });
    expect(accepted).toHaveLength(1);
    expect(accepted[0]?.retailers).toEqual(["safeway"]);
  });

  it("accepting for costco after safeway leaves both in retailers[] (the real SQL union)", async () => {
    const results: Tier3Consent[] = [];
    for (const id of ["safeway", "costco"] as const) {
      const r = await render(
        createElement(ConsentScreen, {
          store: tier3Store(id),
          householdId: HOUSEHOLD,
          client: databaseClient(),
          onAccepted: (c) => results.push(c),
        }),
      );
      await scrollToEnd(r.root);
      await check(r.root);
      await act(async () => {
        host(r.root, "consent-continue").props.onPress();
      });
    }
    expect(results.map((c) => c.retailers)).toEqual([["safeway"], ["costco", "safeway"]]);
    const stored = await db.t.query<{ c: Tier3Consent }>(
      "select tier3_consent as c from public.households where id = $1",
      [HOUSEHOLD],
    );
    expect(stored[0]?.c.retailers).toEqual(["costco", "safeway"]);
    expect(stored[0]?.c.copy_version).toBe(CONSENT_VERSION);
  });

  it("shows the server's refusal and stays on the screen", async () => {
    const rpc = vi.fn(async () => ({ data: null, error: { message: "not_a_member" } }));
    const accepted = vi.fn();
    const r = await render(
      createElement(ConsentScreen, {
        store: tier3Store("costco"),
        householdId: HOUSEHOLD,
        client: { rpc } as unknown as RpcClient,
        onAccepted: accepted,
      }),
    );
    await scrollToEnd(r.root);
    await check(r.root);
    await act(async () => {
      host(r.root, "consent-continue").props.onPress();
    });
    expect(accepted).not.toHaveBeenCalled();
    const alert = r.root.findAll(
      (n) => (n.type as unknown) === "Text" && n.props.accessibilityRole === "alert",
    );
    expect(alert.map((n) => (n.children as unknown[]).join(""))).toEqual([
      "You are not a member of this household.",
    ]);
  });
});

describe("the connect flow's Tier 3 branch", () => {
  const signIn = () => createElement("View", { testID: "login-webview" });

  function flow(consent: Tier3Consent | null, version?: string) {
    return createElement(Tier3ConnectFlow, {
      store: tier3Store("safeway"),
      householdId: HOUSEHOLD,
      consent,
      client: databaseClient(),
      renderSignIn: signIn,
      ...(version ? { version } : {}),
    });
  }

  const consentFor = (retailers: string[], copyVersion = CONSENT_VERSION): Tier3Consent => ({
    accepted_at: "2026-10-31T18:00:00.000000+00:00",
    by_user_id: ALICE,
    retailers,
    copy_version: copyVersion,
  });

  it("shows ConsentScreen for a household with no consent, then the login WebView", async () => {
    const r = await render(flow(null));
    expect(has(r.root, "consent-screen")).toBe(true);
    expect(has(r.root, "login-webview")).toBe(false);
    await scrollToEnd(r.root);
    await check(r.root);
    await act(async () => {
      host(r.root, "consent-continue").props.onPress();
    });
    expect(has(r.root, "consent-screen")).toBe(false);
    expect(has(r.root, "login-webview")).toBe(true);
  });

  it("skips it when retailers[] already includes safeway at the current version", async () => {
    const r = await render(flow(consentFor(["costco", "safeway"])));
    expect(has(r.root, "consent-screen")).toBe(false);
    expect(has(r.root, "login-webview")).toBe(true);
  });

  it("shows it for a retailer the household has not consented to", async () => {
    const r = await render(flow(consentFor(["costco"])));
    expect(has(r.root, "consent-screen")).toBe(true);
  });

  it("shows it again after a bumped CONSENT_VERSION", async () => {
    const r = await render(flow(consentFor(["safeway"]), "2026-12-01"));
    expect(has(r.root, "consent-screen")).toBe(true);
    const old = await render(flow(consentFor(["safeway"], "2026-09-01")));
    expect(has(old.root, "consent-screen")).toBe(true);
  });
});
