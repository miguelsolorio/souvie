// WS08 criteria 3 and 4: the bridge over the bundled test page, through a mocked WebView (jsdom).
// The host is the real one (bridgeHost.ts); only the WebView is stood in.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  BrowserHostError,
  countNodes,
  diffSnapshots,
  findByRole,
  findByText,
  hostMessageScript,
  nearestButton,
  type SnapshotNode,
  type SnapshotTree,
  validateSnapshotTree,
  walk,
} from "@mp/retailers";
import { afterEach, describe, expect, it } from "vitest";
import { BRIDGE_SOURCE } from "../bridge.generated";
import { renderGenerated } from "../build-bridge.mts";
import {
  createPageHarness,
  FAKE_JPEG,
  HERE_ROOT,
  type PageHarness,
  TEST_PAGE_URL,
  TEST_RECEIVER,
  TEST_TOKEN,
} from "./jsdomPage";

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

let page: PageHarness | null = null;
afterEach(() => {
  page?.close();
  page = null;
});

async function open(url = TEST_PAGE_URL, options = {}) {
  page = createPageHarness(options);
  await page.host.navigate(url);
  return page;
}

/** The tree without what legitimately differs between captures: the time and the layout. */
function shape(tree: SnapshotTree) {
  const strip = (n: SnapshotNode): unknown => ({
    id: n.id,
    role: n.role,
    name: n.name,
    ...(n.text !== undefined ? { text: n.text } : {}),
    ...(n.value !== undefined ? { value: n.value } : {}),
    ...(n.href !== undefined ? { href: n.href } : {}),
    ...(n.disabled ? { disabled: true } : {}),
    ...(n.checked !== undefined ? { checked: n.checked } : {}),
    ...(n.children ? { children: n.children.map(strip) } : {}),
  });
  return { url: tree.url, title: tree.title, root: strip(tree.root) };
}

function searchBox(tree: SnapshotTree): SnapshotNode {
  const [box] = findByRole(tree, "searchbox", "Search products");
  if (!box) throw new Error("no search box");
  return box;
}

function thirdAddButton(tree: SnapshotTree): SnapshotNode {
  const title = findByRole(tree, "heading", "Meadowline Peanut Butter")[0];
  if (!title) throw new Error("no third tile");
  const add = nearestButton(tree, title.id, "Add");
  if (!add) throw new Error("no Add button in the third tile");
  return add;
}

function reasons(p: PageHarness): string[] {
  return p.posted.filter((m) => m.type === "userRequired").map((m) => String(m.reason));
}

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

describe("bridge source", () => {
  it("BRIDGE_SOURCE is bridge.js as it is now (run tier3:bridge after editing)", () => {
    const bridge = readFileSync(join(HERE_ROOT, "..", "bridge.js"), "utf8");
    expect(BRIDGE_SOURCE).toBe(bridge);
    expect(renderGenerated(bridge)).toContain("export const BRIDGE_SOURCE");
  });
});

describe("snapshot (criterion 3)", () => {
  it("gives every node an id, a role, a name and a bbox of four finite numbers", async () => {
    const p = await open();
    const tree = await p.host.snapshot();
    expect(validateSnapshotTree(tree)).toEqual([]);
    expect(tree.url).toBe(TEST_PAGE_URL);
    expect(tree.title).toBe("Fixture Pantry test page");
    expect(tree.truncated).toBe(false);
    for (const { node } of walk(tree)) {
      expect(typeof node.id).toBe("string");
      expect(node.id.length).toBeGreaterThan(0);
      expect(typeof node.role).toBe("string");
      expect(typeof node.name).toBe("string");
      expect(node.bbox).toHaveLength(4);
      for (const n of node.bbox) expect(Number.isFinite(n)).toBe(true);
    }
    // The page's parts are all there, under the roles the contract names.
    expect(findByRole(tree, "article")).toHaveLength(10);
    expect(findByRole(tree, "button", "Add")).toHaveLength(10);
    expect(findByRole(tree, "combobox", "Sort by")).toHaveLength(1);
    expect(findByRole(tree, "img", "Fixture Pantry logo")).toHaveLength(1);
    expect(findByRole(tree, "button", "Increase quantity")).toHaveLength(1);
    expect(findByText(tree, "$0.31/oz")).toHaveLength(1);
    // The hidden sign-in form is not in the tree.
    expect(findByRole(tree, "textbox", "Password")).toHaveLength(0);
  });

  it("returns identical ids across two calls on an unchanged DOM", async () => {
    const p = await open();
    const first = await p.host.snapshot();
    const second = await p.host.snapshot();
    expect(shape(second)).toEqual(shape(first));
    expect(new Set(walk(first).map((v) => v.node.id)).size).toBe(countNodes(first));
  });

  it("keeps the same ids across a reload, and matches the committed fixture", async () => {
    const p = await open();
    const before = await p.host.snapshot();
    await p.host.navigate(TEST_PAGE_URL);
    expect(p.loads).toHaveLength(2);
    const after = await p.host.snapshot();
    expect(shape(after)).toEqual(shape(before));

    if (process.env.UPDATE_TIER3_FIXTURE === "1" || !existsSync(FIXTURE)) {
      writeFileSync(FIXTURE, `${JSON.stringify(after, null, 2)}\n`);
    }
    const fixture = JSON.parse(readFileSync(FIXTURE, "utf8")) as SnapshotTree;
    expect(validateSnapshotTree(fixture)).toEqual([]);
    expect(shape(after)).toEqual(shape(fixture));
  });

  it("after typing into the search box only that node's value changes", async () => {
    const p = await open();
    const before = await p.host.snapshot();
    const box = searchBox(before);
    expect(box.value).toBe("");
    await p.host.type(box.id, "oat milk");
    const after = await p.host.snapshot();
    expect(diffSnapshots(before, after)).toEqual([{ id: box.id, fields: ["value"] }]);
    expect(searchBox(after).value).toBe("oat milk");
  });

  it("caps the tree at maxNodes and marks the truncation", async () => {
    const p = await open();
    const full = await p.host.snapshot();
    expect(countNodes(full)).toBeGreaterThan(50);
    const capped = await p.host.snapshot({ maxNodes: 50 });
    expect(countNodes(capped)).toBeLessThanOrEqual(50);
    expect(capped.nodeCount).toBe(countNodes(capped));
    expect(capped.truncated).toBe(true);
    // The capped tree is a prefix of the full one: same ids for the nodes it kept.
    const fullIds = walk(full).map((v) => v.node.id);
    expect(walk(capped).map((v) => v.node.id)).toEqual(fullIds.slice(0, countNodes(capped)));
  });
});

describe("actions (criterion 3)", () => {
  it("click posts the expected message and resolves on action.result", async () => {
    const p = await open();
    const tree = await p.host.snapshot();
    const add = thirdAddButton(tree);
    const sent = p.evaluated.length;
    await p.host.click(add.id);
    const scripts = p.evaluated.slice(sent);
    expect(scripts).toHaveLength(1);
    const script = scripts[0] ?? "";
    expect(script).toContain('\\"type\\":\\"click\\"');
    expect(script).toContain(`\\"nodeId\\":\\"${add.id}\\"`);
    const results = p.posted.filter((m) => m.type === "action.result");
    expect(results.at(-1)).toMatchObject({ ok: true, token: TEST_TOKEN });
    const status = p.window().document.getElementById("cart-count");
    expect(status?.textContent).toBe("Cart: 1 item");
  });

  it("type posts the expected message, fires input events and resolves on action.result", async () => {
    const p = await open();
    const tree = await p.host.snapshot();
    const box = searchBox(tree);
    const input = p.window().document.getElementById("search") as HTMLInputElement;
    const events: string[] = [];
    for (const type of ["keydown", "input", "keyup", "change"]) {
      input.addEventListener(type, () => events.push(type));
    }
    const sent = p.evaluated.length;
    await p.host.type(box.id, "oat", { clear: true });
    const script = p.evaluated[sent] ?? "";
    expect(script).toContain('\\"type\\":\\"type\\"');
    expect(script).toContain('\\"text\\":\\"oat\\"');
    expect(input.value).toBe("oat");
    expect(events.filter((e) => e === "input")).toHaveLength(3);
    expect(events.at(-1)).toBe("change");
    await p.host.type(box.id, "oat milk", { clear: true });
    expect(input.value).toBe("oat milk");
  });

  it("selects an option by visible text or value, and refuses one that does not exist", async () => {
    const p = await open();
    const tree = await p.host.snapshot();
    const [sort] = findByRole(tree, "combobox", "Sort by");
    if (!sort) throw new Error("no select");
    await p.host.select(sort.id, "Price, low to high");
    const select = p.window().document.getElementById("sort") as HTMLSelectElement;
    expect(select.value).toBe("price-asc");
    await p.host.select(sort.id, "price-desc");
    expect(select.value).toBe("price-desc");
    await expect(p.host.select(sort.id, "Cheapest first")).rejects.toMatchObject({
      code: "no_such_option",
    });
  });

  it("refuses to type into a password field and never serializes one", async () => {
    const p = await open();
    const showSignin = findByRole(await p.host.snapshot(), "button", "Sign in")[0];
    if (!showSignin) throw new Error("no sign in button");
    await p.host.click(showSignin.id);
    const doc = p.window().document;
    // The person types their own password; the bridge must never see it.
    (doc.getElementById("password") as HTMLInputElement).value = "hunter2-test-password";
    const tree = await p.host.snapshot();
    const [password] = findByRole(tree, "textbox", "Password");
    if (!password) throw new Error("no password field in the tree");
    expect(password.value).toBeUndefined();
    expect(JSON.stringify(tree)).not.toContain("hunter2");
    await expect(p.host.type(password.id, "x")).rejects.toMatchObject({ code: "password_field" });
    expect((doc.getElementById("password") as HTMLInputElement).value).toBe(
      "hunter2-test-password",
    );
  });

  it("answers stale_node for a node that left the page", async () => {
    const p = await open();
    const tree = await p.host.snapshot();
    const add = thirdAddButton(tree);
    p.window().document.getElementById("results")?.remove();
    await expect(p.host.click(add.id)).rejects.toMatchObject({ code: "stale_node" });
  });

  it("returns a screenshot from the host, not the page", async () => {
    const p = await open();
    expect(await p.host.screenshot()).toEqual(FAKE_JPEG);
  });
});

describe("waitFor", () => {
  it("resolves when the slow node appears after typing", async () => {
    const p = await open(`${TEST_PAGE_URL}?slow=300`);
    const box = searchBox(await p.host.snapshot());
    await p.host.type(box.id, "oat milk");
    const started = Date.now();
    let streamed = 0;
    await p.host.waitFor((tree) => {
      streamed += 1;
      return findByText(tree, 'Showing results for "oat milk"').length > 0;
    }, 3_000);
    expect(Date.now() - started).toBeGreaterThanOrEqual(200);
    expect(streamed).toBeGreaterThan(1);
    const stops = p.evaluated.filter((s) => s.includes('\\"type\\":\\"waitFor.stop\\"'));
    expect(stops).toHaveLength(1);
  });

  it("rejects with timeout when the condition never holds", async () => {
    const p = await open();
    const error = await p.host.waitFor(() => false, 400).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BrowserHostError);
    expect((error as BrowserHostError).code).toBe("timeout");
  });
});

describe("user required (criterion 4)", () => {
  it("raises nothing on the plain page", async () => {
    const p = await open();
    const seen: string[] = [];
    p.host.onUserRequired((r) => seen.push(r));
    await tick(400);
    expect(seen).toEqual([]);
    expect(reasons(p)).toEqual([]);
  });

  it("raises captcha when an iframe named like a human check appears", async () => {
    const p = await open();
    const seen: string[] = [];
    p.host.onUserRequired((r) => seen.push(r));
    const frame = p.window().document.createElement("iframe");
    frame.title = "Please verify you are human";
    p.window().document.body.appendChild(frame);
    await tick(400);
    expect(seen).toEqual(["captcha"]);
    const message = p.posted.find((m) => m.type === "userRequired");
    expect(message).toMatchObject({ reason: "captcha", url: TEST_PAGE_URL });
    const tree = await p.host.snapshot();
    const [iframe] = findByRole(tree, "iframe", /verify you are human/i);
    expect(iframe?.id).toBe(message?.nodeId);
  });

  it("raises captcha for the test page's own verification button too", async () => {
    const p = await open();
    const seen: string[] = [];
    p.host.onUserRequired((r) => seen.push(r));
    const button = findByRole(await p.host.snapshot(), "button", "Show a verification check")[0];
    if (!button) throw new Error("no button");
    await p.host.click(button.id);
    await tick(400);
    expect(seen).toEqual(["captcha"]);
  });

  it("raises login when a password field appears", async () => {
    const p = await open();
    const seen: string[] = [];
    p.host.onUserRequired((r) => seen.push(r));
    const button = findByRole(await p.host.snapshot(), "button", "Sign in")[0];
    if (!button) throw new Error("no button");
    await p.host.click(button.id);
    await tick(400);
    expect(seen).toEqual(["login"]);
  });

  it("raises login on a sign-in URL", async () => {
    const p = await open("http://localhost:8790/account/sign-in");
    const seen: string[] = [];
    p.host.onUserRequired((r) => seen.push(r));
    await tick(400);
    expect(reasons(p)).toContain("login");
  });

  it("raises mfa when an input with autocomplete=one-time-code appears", async () => {
    const p = await open();
    const seen: string[] = [];
    p.host.onUserRequired((r) => seen.push(r));
    const input = p.window().document.createElement("input");
    input.setAttribute("autocomplete", "one-time-code");
    p.window().document.body.appendChild(input);
    await tick(400);
    expect(seen).toEqual(["mfa"]);
  });

  it("raises unexpected when the page leaves the allowed hosts", async () => {
    const p = await open(TEST_PAGE_URL, { allowedHosts: ["localhost"] });
    const seen: string[] = [];
    p.host.onUserRequired((r) => seen.push(r));
    p.host.notifyNavigation("https://elsewhere.example/");
    expect(seen).toEqual(["unexpected"]);
    await expect(p.host.navigate("https://elsewhere.example/")).rejects.toMatchObject({
      code: "navigation_failed",
    });
  });
});

describe("protocol hygiene", () => {
  it("injects before content loads and on load end, and installs one bridge", async () => {
    const p = await open();
    await tick(50);
    const injections = p.evaluated.filter((s) => s === p.host.bridgeScript);
    expect(injections).toHaveLength(1); // load end; before-content-loaded runs in beforeParse
    const tree = await p.host.snapshot();
    await p.host.click(thirdAddButton(tree).id);
    // One bridge, so one answer per request.
    const answers = p.posted.filter((m) => m.type === "action.result");
    expect(answers).toHaveLength(1);
  });

  it("ignores a message without the bridge's token", async () => {
    const p = await open();
    const forged = JSON.stringify({
      __mp: "mp-tier3-bridge",
      v: 1,
      token: "not-the-token",
      type: "userRequired",
      reason: "captcha",
      url: TEST_PAGE_URL,
    });
    const seen: string[] = [];
    p.host.onUserRequired((r) => seen.push(r));
    p.host.receive(forged);
    expect(seen).toEqual([]);
  });

  it("delivers host messages as data, never as code", () => {
    const script = hostMessageScript(TEST_RECEIVER, {
      type: "type",
      requestId: "r1",
      nodeId: "n1",
      text: '");alert(1);("',
    });
    expect(script).not.toContain('");alert(1);("');
  });

  it("reports history navigation", async () => {
    const p = await open();
    p.window().history.pushState({}, "", "/results?q=oats");
    await tick(20);
    expect(await p.host.url()).toBe("http://localhost:8790/results?q=oats");
    expect(p.posted.some((m) => m.type === "navigated")).toBe(true);
  });

  it("reads the origin's storage after the fake sign-in", async () => {
    const p = await open(`${TEST_PAGE_URL}?signin=1`);
    const doc = p.window().document;
    (doc.getElementById("email") as HTMLInputElement).value = "test.shopper@example.test";
    (doc.getElementById("password") as HTMLInputElement).value = "hunter2-test-password";
    (doc.getElementById("signin") as HTMLFormElement).requestSubmit();
    const dump = await p.host.readStorage();
    expect(dump).toEqual({
      origin: "http://localhost:8790",
      localStorage: { "fixture.account": "signed-in" },
      sessionStorage: { "fixture.visit": "1" },
    });
    expect(JSON.stringify(dump)).not.toContain("hunter2");
  });
});
