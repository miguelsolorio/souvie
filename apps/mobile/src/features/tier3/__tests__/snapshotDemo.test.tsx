// WS08 demo round: demo mode of the (dev)/snapshot screen, souvie://snapshot?demo=1. Rendered with
// react-test-renderer over stand-in React Native host components and a stand-in WebViewHost, a fake
// BridgeHost behind it, and fake timers so the 1.5 s start and the 1.2 s pauses are exact.
// The normal mode is checked beside it: it must keep its URL field, its Steps list and its button,
// and make the same bridge calls in the same order.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { findByText, type SnapshotNode, type SnapshotTree, walk } from "@mp/retailers";
import { createElement, useEffect } from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BridgeHost } from "../bridgeHost";
import { FAKE_JPEG, HERE_ROOT } from "./jsdomPage";

const harness = vi.hoisted(() => ({
  params: {} as { demo?: string | string[] },
  host: null as unknown,
  webView: null as Record<string, unknown> | null,
  /** Every LogBox.ignoreAllLogs argument, in order. */
  ignoreAllLogs: [] as boolean[],
}));

vi.mock("react-native", () => ({
  View: "View",
  Text: "Text",
  Pressable: "Pressable",
  Image: "Image",
  TextInput: "TextInput",
  ScrollView: "ScrollView",
  ActivityIndicator: "ActivityIndicator",
  Platform: { OS: "ios" },
  Share: { share: async () => ({}) },
  LogBox: { ignoreAllLogs: (value: boolean) => harness.ignoreAllLogs.push(value) },
}));
vi.mock("react-native-safe-area-context", () => ({ SafeAreaView: "SafeAreaView" }));
vi.mock("expo-router", () => ({
  Redirect: "Redirect",
  useLocalSearchParams: () => harness.params,
}));
vi.mock("expo-file-system", () => ({ File: class {}, Paths: { cache: "cache" } }));
vi.mock("../WebViewHost", () => ({
  WebViewHost: (props: Record<string, unknown>) => {
    harness.webView = props;
    useEffect(() => {
      (props.onHost as (h: unknown) => void)?.(harness.host);
    }, [props.onHost]);
    return null;
  },
}));

import SnapshotScreen from "../../../../app/(dev)/snapshot";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean; __DEV__?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;
(globalThis as { __DEV__?: boolean }).__DEV__ = true;

const FIXTURE = join(
  HERE_ROOT,
  "..",
  "..",
  "..",
  "..",
  "..",
  "..",
  "packages",
  "retailers",
  "src",
  "browser",
  "__fixtures__",
  "static-test-page.snapshot.json",
);
const fixture = JSON.parse(readFileSync(FIXTURE, "utf8")) as SnapshotTree;

function cloneWith(edit: (node: SnapshotNode) => void): SnapshotTree {
  const copy = JSON.parse(JSON.stringify(fixture)) as SnapshotTree;
  for (const { node } of walk(copy)) edit(node);
  return copy;
}

const afterClick = cloneWith((n) => {
  if (n.text?.startsWith("Cart:")) n.text = "Cart: 1 item";
});
const withResults = cloneWith((n) => {
  if (n.text?.startsWith("Cart:")) n.text = "Cart: 1 item";
  if (n.role === "searchbox") n.value = "oat milk";
});
// The late node, added under the root the way the page adds it.
withResults.root.children = [
  ...(withResults.root.children ?? []),
  {
    id: "nresultsnote",
    role: "status",
    name: "",
    text: 'Showing results for "oat milk"',
    bbox: [0, 0, 0, 0],
  },
];

/** What normal mode opens, and what demo mode opens: the same page with the demo flag. */
const PAGE = "http://localhost:8790/";
const DEMO_PAGE = `${PAGE}?demo=1`;

/** The nodes under `node`, `node` first, in document order. */
function subtree(node: SnapshotNode): SnapshotNode[] {
  return [node, ...(node.children ?? []).flatMap(subtree)];
}

// The ids the script must act on, read from the fixture without the helpers the screen uses.
const articles = subtree(fixture.root).filter((n) => n.role === "article");
const thirdTile = articles[2];
const thirdTitle = thirdTile ? subtree(thirdTile).find((n) => n.role === "heading") : undefined;
const thirdAdd = thirdTile
  ? subtree(thirdTile).find((n) => n.role === "button" && n.name === "Add")
  : undefined;
const searchBox = subtree(fixture.root).find((n) => n.role === "searchbox");
if (!thirdTile || !thirdAdd || !searchBox) throw new Error("the fixture lacks the nodes");

/** Every bridge call the demo script makes, with its arguments, for the page it opens. */
function expectedCalls(page: string): string[] {
  return [
    `navigate ${page}`,
    "snapshot",
    `click ${thirdAdd?.id}`,
    "snapshot",
    `type ${searchBox?.id} oat milk clear=true`,
    "waitFor 10000",
    "screenshot",
    "snapshot",
  ];
}

interface FakeHost {
  host: BridgeHost;
  calls: string[];
  waitChecks: Array<(tree: SnapshotTree, url: string) => boolean>;
}

function fakeHost(options: { ready?: () => boolean; failNavigate?: string } = {}): FakeHost {
  const calls: string[] = [];
  const waitChecks: FakeHost["waitChecks"] = [];
  let snapshots = 0;
  const host = {
    isReady: options.ready ?? (() => true),
    async navigate(url: string) {
      calls.push(`navigate ${url}`);
      if (options.failNavigate) throw new Error(options.failNavigate);
    },
    async snapshot() {
      calls.push("snapshot");
      snapshots += 1;
      // First the page as loaded, then after the click, then after the search.
      return snapshots === 1 ? fixture : snapshots === 2 ? afterClick : withResults;
    },
    async click(id: string) {
      calls.push(`click ${id}`);
    },
    async type(id: string, text: string, opts?: { clear?: boolean }) {
      calls.push(`type ${id} ${text} clear=${opts?.clear === true}`);
    },
    async waitFor(check: FakeHost["waitChecks"][number], timeoutMs: number) {
      calls.push(`waitFor ${timeoutMs}`);
      waitChecks.push(check);
    },
    async screenshot() {
      calls.push("screenshot");
      return FAKE_JPEG;
    },
  } as unknown as BridgeHost;
  return { host, calls, waitChecks };
}

let renderer: ReactTestRenderer | null = null;
let logs: string[] = [];

beforeEach(() => {
  vi.useFakeTimers();
  logs = [];
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    logs.push(args.join(" "));
  });
  harness.params = {};
  harness.webView = null;
  harness.ignoreAllLogs = [];
});

afterEach(() => {
  act(() => renderer?.unmount());
  renderer = null;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function render(fake: FakeHost, params: { demo?: string | string[] } = { demo: "1" }) {
  harness.host = fake.host;
  harness.params = params;
  await act(async () => {
    renderer = create(createElement(SnapshotScreen));
  });
  return (renderer as unknown as ReactTestRenderer).root;
}

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

function hosts(root: ReactTestInstance, testID: string): ReactTestInstance[] {
  return root.findAll((n) => n.props.testID === testID && typeof n.type === "string");
}

function text(root: ReactTestInstance, testID: string): string {
  const found = hosts(root, testID);
  if (found.length !== 1) throw new Error(`expected one ${testID}, found ${found.length}`);
  return ((found[0] as ReactTestInstance).children as unknown[]).join("");
}

/** The text of every Text on screen. */
function allText(root: ReactTestInstance): string[] {
  return root
    .findAll((n) => (n.type as unknown) === "Text")
    .map((t) => (t.children as unknown[]).join(""));
}

async function press(root: ReactTestInstance, testID: string) {
  const [node] = hosts(root, testID);
  if (!node) throw new Error(`no ${testID}`);
  await act(async () => {
    (node.props.onPress as () => void)();
  });
}

describe("demo mode (?demo=1)", () => {
  it("shows only the WebView and the caption strip", async () => {
    const root = await render(fakeHost());
    expect(harness.webView?.testID).toBe("snapshot-webview");
    // The demo page: the test page with the flag that keeps the on-screen keyboard down.
    expect(harness.webView?.initialUrl).toBe(DEMO_PAGE);
    expect(hosts(root, "demo-caption")).toHaveLength(1);
    // Gone: the URL field, Open, Run the demo, the Steps list and the Fixture section.
    for (const id of ["snapshot-url", "snapshot-open", "snapshot-demo", "snapshot-step-0"]) {
      expect(hosts(root, id)).toHaveLength(0);
    }
    const all = allText(root);
    expect(all).not.toContain("Steps");
    expect(all).not.toContain("Fixture");
    expect(all).not.toContain("Snapshot tool");
  });

  it("starts by itself 1.5 s after the host is ready, and not before", async () => {
    const fake = fakeHost();
    const root = await render(fake);
    expect(text(root, "demo-caption")).toBe("Getting ready");
    expect(logs).toContain("[tier3-demo] ready");
    await advance(1_499);
    expect(fake.calls).toEqual([]);
    await advance(1);
    expect(fake.calls).toEqual([`navigate ${DEMO_PAGE}`]);
    expect(text(root, "demo-caption")).toBe("Opening the page");
  });

  it("waits for the page to be ready before it counts the 1.5 s", async () => {
    let ready = false;
    const fake = fakeHost({ ready: () => ready });
    const root = await render(fake);
    await advance(5_000);
    expect(fake.calls).toEqual([]);
    expect(text(root, "demo-caption")).toBe("Getting ready");
    ready = true;
    await advance(100);
    expect(logs).toContain("[tier3-demo] ready");
    await advance(1_499);
    expect(fake.calls).toEqual([]);
    await advance(1);
    expect(fake.calls).toHaveLength(1);
  });

  it("captions each step in plain words, in order, pausing 1.2 s between steps", async () => {
    const fake = fakeHost();
    const root = await render(fake);
    await advance(1_500);
    const captions = [text(root, "demo-caption")];
    const labels = [text(root, "demo-step")];
    for (let i = 0; i < 7; i++) {
      // Just short of the pause: nothing has moved on.
      await advance(1_199);
      expect(text(root, "demo-caption")).toBe(captions.at(-1));
      await advance(1);
      captions.push(text(root, "demo-caption"));
      labels.push(text(root, "demo-step"));
    }
    expect(captions).toEqual([
      "Opening the page",
      "Reading the page (90 elements)",
      "Picking the third product",
      "Adding it to the cart",
      "Cart: 1 item",
      "Searching for oat milk",
      "Waiting for the results",
      "Taking a screenshot for the review",
    ]);
    expect(labels[0]).toBe("Step 1 of 8");
    expect(labels.at(-1)).toBe("Step 8 of 8");
    // No ids or node counts leak into a caption except the one the brief asks for.
    for (const c of captions) expect(c).not.toMatch(/\bn[0-9a-z]{10,}\b/);
    expect(logs.filter((l) => l.startsWith("[tier3-demo] step"))).toHaveLength(8);
  });

  it("makes exactly these bridge calls, verbs and arguments, and ends on Done with the screenshot", async () => {
    const fake = fakeHost();
    const root = await render(fake);
    await advance(1_500 + 8 * 1_200);
    // The click is the third product tile's Add button, not another tile's, and the search types
    // "oat milk" into the search box with the field cleared first. The wait gives the late node
    // 10 s. The ids come from the committed fixture.
    expect(thirdTitle?.name).toBe("Meadowline Peanut Butter");
    expect(fake.calls).toEqual(expectedCalls(DEMO_PAGE));
    // The wait is for the late node, and only for it.
    expect(fake.waitChecks[0]?.(fixture, fixture.url)).toBe(false);
    expect(fake.waitChecks[0]?.(withResults, withResults.url)).toBe(true);
    expect(findByText(withResults, 'Showing results for "oat milk"')).toHaveLength(1);

    expect(text(root, "demo-caption")).toBe("Done in 10 s");
    expect(text(root, "demo-step")).toBe("Finished");
    const [shot] = hosts(root, "demo-shot");
    if (!shot) throw new Error("no screenshot thumbnail");
    expect((shot.props.source as { uri: string }).uri).toMatch(/^data:image\/jpeg;base64,\/9j\//);
    expect(hosts(root, "demo-replay")).toHaveLength(1);
    expect(logs).toContain("[tier3-demo] done 10");
  });

  it("makes the same calls, with the same arguments, as the normal Run the demo", async () => {
    const demo = fakeHost();
    await render(demo);
    await advance(1_500 + 8 * 1_200);
    act(() => renderer?.unmount());
    renderer = null;

    const normal = fakeHost();
    const root = await render(normal, {});
    await press(root, "snapshot-demo");
    await advance(0);

    // They differ in one argument only: the page the first navigate opens.
    expect(demo.calls[0]).toBe(`navigate ${DEMO_PAGE}`);
    expect(normal.calls[0]).toBe(`navigate ${PAGE}`);
    expect(demo.calls.slice(1)).toEqual(normal.calls.slice(1));
    expect(demo.calls).toHaveLength(8);
    expect(normal.calls).toHaveLength(8);
  });

  it("adds the demo flag to a page URL that has a query or a fragment", async () => {
    const before = process.env.EXPO_PUBLIC_TIER3_TEST_PAGE_URL;
    process.env.EXPO_PUBLIC_TIER3_TEST_PAGE_URL = "https://pages.example.test/t?x=1#top";
    try {
      vi.resetModules();
      const fresh = await import("../../../../app/(dev)/snapshot");
      harness.host = fakeHost().host;
      harness.params = { demo: "1" };
      await act(async () => {
        renderer = create(createElement(fresh.default));
      });
      expect(harness.webView?.initialUrl).toBe("https://pages.example.test/t?x=1&demo=1#top");
    } finally {
      if (before === undefined) delete process.env.EXPO_PUBLIC_TIER3_TEST_PAGE_URL;
      else process.env.EXPO_PUBLIC_TIER3_TEST_PAGE_URL = before;
    }
  });

  it("replays from the first step when Replay is pressed", async () => {
    const fake = fakeHost();
    const root = await render(fake);
    await advance(1_500 + 8 * 1_200);
    expect(text(root, "demo-caption")).toBe("Done in 10 s");
    expect(fake.calls).toHaveLength(8);

    await press(root, "demo-replay");
    expect(text(root, "demo-caption")).toBe("Opening the page");
    expect(hosts(root, "demo-replay")).toHaveLength(0);
    await advance(1_200);
    expect(text(root, "demo-caption")).toBe("Reading the page (90 elements)");
    await advance(7 * 1_200);
    expect(text(root, "demo-caption")).toBe("Done in 10 s");
    expect(fake.calls).toHaveLength(16);
  });

  it("stops quietly when the screen goes away", async () => {
    const fake = fakeHost();
    await render(fake);
    await advance(1_500 + 1_200);
    const seen = fake.calls.length;
    act(() => renderer?.unmount());
    renderer = null;
    await advance(20_000);
    expect(fake.calls).toHaveLength(seen);
  });

  it("says what stopped it, and offers Replay", async () => {
    const fake = fakeHost({ failNavigate: "The page did not load within 30000 ms" });
    const root = await render(fake);
    await advance(1_500);
    expect(text(root, "demo-caption")).toBe("Stopped. The page did not load within 30000 ms");
    expect(text(root, "demo-step")).toBe("Problem");
    expect(hosts(root, "demo-replay")).toHaveLength(1);
    expect(logs.some((l) => l.startsWith("[tier3-demo] failed"))).toBe(true);
  });

  it("gives up after 20 s when the test page never loads", async () => {
    const fake = fakeHost({ ready: () => false });
    const root = await render(fake);
    await advance(20_200);
    expect(text(root, "demo-caption")).toMatch(/^The test page did not load/);
    expect(fake.calls).toEqual([]);
  });

  it("keeps LogBox warning badges off the recording, and puts them back on leaving", async () => {
    await render(fakeHost());
    expect(harness.ignoreAllLogs).toEqual([true]);
    act(() => renderer?.unmount());
    renderer = null;
    expect(harness.ignoreAllLogs).toEqual([true, false]);
  });

  it("also reads demo=1 from a repeated parameter", async () => {
    const root = await render(fakeHost(), { demo: ["1"] });
    expect(hosts(root, "demo-caption")).toHaveLength(1);
  });
});

describe("normal mode (no ?demo=1) is unchanged", () => {
  it("keeps the URL field, Open, Run the demo, Steps and Fixture, and does not auto-start", async () => {
    const fake = fakeHost();
    const root = await render(fake, {});
    for (const id of ["snapshot-url", "snapshot-open", "snapshot-demo"]) {
      expect(hosts(root, id).length).toBeGreaterThan(0);
    }
    expect(harness.webView?.testID).toBe("snapshot-webview");
    expect(harness.webView?.initialUrl).toBe(PAGE);
    expect(hosts(root, "demo-caption")).toHaveLength(0);
    const all = allText(root);
    expect(all).toContain("Steps");
    expect(all).toContain("Fixture");
    await advance(10_000);
    expect(fake.calls).toEqual([]);
    expect(logs).toEqual([]);
  });

  it("Run the demo shows ids and timings, with the same bridge calls and no pauses", async () => {
    const fake = fakeHost();
    const root = await render(fake, {});
    await press(root, "snapshot-demo");
    // Microtasks only: the normal run has no pauses, so no timer needs to fire.
    await advance(0);
    // The bare test page, with no demo flag, so the page keeps its real keyboard behaviour.
    expect(fake.calls).toEqual(expectedCalls(PAGE));
    const steps = hosts(root, "snapshot-step-0").concat(hosts(root, "snapshot-step-1"));
    expect(steps).toHaveLength(2);
    expect(text(root, "snapshot-step-0")).toMatch(
      /^ok {2}.*navigate \(\d+ ms\): http:\/\/localhost:8790\/$/,
    );
    expect(text(root, "snapshot-step-1")).toMatch(/snapshot \(\d+ ms\): 90 nodes$/);
    expect(hosts(root, "snapshot-step-3")).toHaveLength(1);
    expect(text(root, "snapshot-step-3")).toMatch(/cart: Cart: 1 item$/);
  });
});
