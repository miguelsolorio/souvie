// WS08 re-review round: each rule proven on its own (lifted from the reviewer's round-2
// reproductions), the iOS channel, and the password rule's word boundaries.
import { findByRole, type SnapshotTree } from "@mp/retailers";
import { afterEach, describe, expect, it } from "vitest";
import { BRIDGE_SOURCE } from "../bridge.generated";
import { buildBridgeScript, newBridgeReceiver, newBridgeToken } from "../bridgeScript";
import { findPersonalData, SECRET_FIELD_HINT } from "../scrub";
import {
  createPageHarness,
  type HarnessOptions,
  type PageHarness,
  TEST_PAGE_URL,
  TEST_RECEIVER,
  TEST_TOKEN,
} from "./jsdomPage";

let page: PageHarness | null = null;
afterEach(() => {
  page?.close();
  page = null;
});
const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));
async function open(options: HarnessOptions = {}) {
  page = createPageHarness(options);
  await page.host.navigate(TEST_PAGE_URL);
  return page;
}

describe("item 1: the iOS channel (react-native-webview's webkit message handler)", () => {
  it("a page that shadows the webkit handler after install neither reads nor blocks the bridge", async () => {
    const p = await open({ platform: "ios", requestTimeoutMs: 1500 });
    p.window().eval(`
      window.__leaked = [];
      window.webkit.messageHandlers.ReactNativeWebView.postMessage = function (d) {
        window.__leaked.push(d);
      };
      window.ReactNativeWebView.postMessage = function (d) { window.__leaked.push(d); };
    `);
    const before = p.posted.length;
    const tree = await p.host.snapshot();
    expect(tree.title).toBe("Fixture Pantry test page");
    // The message reached the original native handler, and the page saw nothing.
    expect(p.posted.length).toBeGreaterThan(before);
    expect(p.window().eval("window.__leaked.length")).toBe(0);
    expect(JSON.stringify(p.window().eval("window.__leaked"))).not.toContain(TEST_TOKEN);
  });

  it("works through the wrapper's native end on iOS when nothing is shadowed", async () => {
    const p = await open({ platform: "ios" });
    const tree = await p.host.snapshot();
    expect(findByRole(tree, "button", "Add")).toHaveLength(10);
  });
});

describe("the token (reviewer round 2)", () => {
  it("is nowhere a page script can enumerate or print", async () => {
    const p = await open();
    const token = JSON.stringify(TEST_TOKEN);
    const found = p.window().eval(`
      (function () {
        var hits = [];
        Object.getOwnPropertyNames(window).forEach(function (n) {
          if (n.indexOf(${token}) >= 0) hits.push("name:" + n);
          try {
            var v = window[n];
            if (typeof v === "string" && v.indexOf(${token}) >= 0) hits.push("value:" + n);
            if (typeof v === "function" && Function.prototype.toString.call(v).indexOf(${token}) >= 0) hits.push("src:" + n);
            if (v && v.receive && String(v.receive).indexOf(${token}) >= 0) hits.push("receive-src:" + n);
            if (v && v.ping && String(v.ping).indexOf(${token}) >= 0) hits.push("ping-src:" + n);
          } catch (e) {}
        });
        return hits;
      })()
    `) as string[];
    expect(found).toEqual([]);
  });

  it("the receiver name is visible but is not the token; a message signed with it is ignored", async () => {
    const p = await open();
    const seen: string[] = [];
    p.host.onUserRequired((r) => seen.push(r));
    const receiver = p
      .window()
      .eval(
        `Object.getOwnPropertyNames(window).filter(function(n){return n.indexOf("__mpTier3Bridge_")===0})[0]`,
      ) as string;
    expect(receiver).toBe(TEST_RECEIVER);
    for (const token of [receiver, receiver.slice("__mpTier3Bridge_".length)]) {
      p.window().eval(`
        window.ReactNativeWebView.postMessage(JSON.stringify({ __mp: "mp-tier3-bridge", v: 1,
          token: ${JSON.stringify(token)}, type: "userRequired", reason: "captcha", url: location.href }));
      `);
    }
    await tick(30);
    expect(seen).toEqual([]);
  });
});

describe("item 3: newBridgeReceiver is independent of the token", () => {
  /** A random source that replays these bytes, then counts up. */
  function bytesFrom(...first: Uint8Array[]) {
    let n = 0;
    return (len: number) => {
      const next = first.shift();
      if (next) return next.slice(0, len);
      n += 1;
      return Uint8Array.from({ length: len }, (_, i) => (i * 7 + n) % 256);
    };
  }

  it("draws again when the random source repeats the token, and never carries the token", () => {
    const seed = Uint8Array.from({ length: 18 }, (_, i) => i * 3);
    const token = newBridgeToken(() => seed);
    const receiver = newBridgeReceiver(bytesFrom(seed, seed), token);
    expect(receiver.startsWith("__mpTier3Bridge_")).toBe(true);
    expect(receiver).not.toContain(token);
    expect(() => buildBridgeScript(token, receiver)).not.toThrow();
  });

  it("over many draws the receiver is never the token, and the script refuses one that is", () => {
    const random = (n: number) => globalThis.crypto.getRandomValues(new Uint8Array(n));
    for (let i = 0; i < 200; i++) {
      const token = newBridgeToken(random);
      expect(newBridgeReceiver(random, token)).not.toContain(token);
    }
    expect(() => buildBridgeScript(TEST_TOKEN, `__mpTier3Bridge_${TEST_TOKEN}`)).toThrow(
      /must not carry the token/,
    );
  });
});

describe("item 3: the password rule, each part on its own (reviewer round 2)", () => {
  async function tree(p: PageHarness, build: (doc: Document) => void) {
    build(p.window().document);
    return p.host.snapshot();
  }

  it("autocomplete alone (type=text, label says nothing about passwords)", async () => {
    const p = await open();
    const t = await tree(p, (doc) => {
      const i = doc.createElement("input");
      i.setAttribute("type", "text");
      i.setAttribute("autocomplete", "current-password");
      i.setAttribute("aria-label", "Account secret");
      i.value = "s3cret-A";
      doc.body.appendChild(i);
    });
    expect(JSON.stringify(t)).not.toContain("s3cret-A");
    const [f] = findByRole(t, "textbox", "Account secret");
    await expect(p.host.type(f?.id ?? "", "x")).rejects.toMatchObject({ code: "password_field" });
  });

  it("type=password alone (no hint in name, id, label or placeholder)", async () => {
    const p = await open();
    const t = await tree(p, (doc) => {
      const i = doc.createElement("input");
      i.setAttribute("type", "password");
      i.setAttribute("id", "q7");
      i.setAttribute("aria-label", "Account secret B");
      i.value = "s3cret-B";
      doc.body.appendChild(i);
    });
    expect(JSON.stringify(t)).not.toContain("s3cret-B");
    const [f] = findByRole(t, "textbox", "Account secret B");
    await expect(p.host.type(f?.id ?? "", "x")).rejects.toMatchObject({ code: "password_field" });
  });

  it("a textarea named password", async () => {
    const p = await open();
    const t = await tree(p, (doc) => {
      const i = doc.createElement("textarea");
      i.setAttribute("name", "password");
      i.setAttribute("aria-label", "Account secret C");
      i.value = "s3cret-C";
      doc.body.appendChild(i);
    });
    expect(JSON.stringify(t)).not.toContain("s3cret-C");
    const [f] = findByRole(t, "textbox", "Account secret C");
    await expect(p.host.type(f?.id ?? "", "x")).rejects.toMatchObject({ code: "password_field" });
  });
});

describe("item 2: the password rule matches words, not prefixes", () => {
  it("a search box that mentions passion fruit keeps its value and takes typing", async () => {
    const p = await open();
    const doc = p.window().document;
    const i = doc.createElement("input");
    i.setAttribute("type", "search");
    i.setAttribute("placeholder", "Search passion fruit");
    i.setAttribute("aria-label", "Search the produce aisle");
    i.value = "kiwi";
    doc.body.appendChild(i);
    const t = await p.host.snapshot();
    const [box] = findByRole(t, "searchbox", "Search the produce aisle");
    expect(box?.value).toBe("kiwi");
    await p.host.type(box?.id ?? "", " and mango");
    expect(i.value).toBe("kiwi and mango");
  });

  it("other words that only start with pass keep their values", async () => {
    const p = await open();
    const doc = p.window().document;
    const cases: [string, string][] = [
      ["aria-label", "Passport number"],
      ["placeholder", "Passenger name"],
      ["name", "compass_heading"],
    ];
    cases.forEach(([attr, value], n) => {
      const i = doc.createElement("input");
      i.setAttribute(attr, value);
      if (attr !== "aria-label") i.setAttribute("aria-label", `Plain field ${n}`);
      i.value = `plain-${n}`;
      doc.body.appendChild(i);
    });
    const t = await p.host.snapshot();
    const text = JSON.stringify(t);
    for (let n = 0; n < cases.length; n++) expect(text).toContain(`plain-${n}`);
  });

  it("password, passcode and pwd are still caught as words and inside names", async () => {
    const p = await open();
    const doc = p.window().document;
    const cases: [string, string][] = [
      ["name", "user_password"],
      ["name", "passcode1"],
      ["name", "currentPassword"],
      ["name", "newpassword"],
      ["id", "pwd-field"],
      ["placeholder", "Your passcode"],
      ["aria-label", "Pass code"],
      ["aria-label", "Password"],
    ];
    cases.forEach(([attr, value], n) => {
      const i = doc.createElement("input");
      i.setAttribute("type", "text");
      i.setAttribute(attr, value);
      if (attr !== "aria-label") i.setAttribute("aria-label", `Secret field ${n}`);
      i.value = `hidden-${n}`;
      doc.body.appendChild(i);
    });
    const t = await p.host.snapshot();
    expect(JSON.stringify(t)).not.toMatch(/hidden-\d/);
  });

  it("the bridge and the TypeScript side use the same rule", () => {
    expect(BRIDGE_SOURCE).toContain(SECRET_FIELD_HINT.source);
  });
});

describe("item 3: the scrubber blanks a password-named field and nothing else", () => {
  it("replaces the value of a field named like a password, keeps a passion fruit search", () => {
    const tree: SnapshotTree = {
      url: "https://shop.example/",
      title: "Shop",
      capturedAt: "2026-10-31T18:00:00.000Z",
      root: {
        id: "r",
        role: "document",
        name: "Shop",
        bbox: [0, 0, 1, 1],
        children: [
          { id: "pw", role: "textbox", name: "Password", value: "leaked", bbox: [0, 0, 1, 1] },
          { id: "pc", role: "textbox", name: "Passcode", value: "123456", bbox: [0, 0, 1, 1] },
          {
            id: "s",
            role: "searchbox",
            name: "Search passion fruit",
            value: "kiwi",
            bbox: [0, 0, 1, 1],
          },
        ],
      },
    };
    const found = findPersonalData(tree);
    const byNode = new Map(found.map((r) => [r.nodeId, r]));
    expect(byNode.get("pw")).toMatchObject({
      field: "value",
      kinds: ["form_value"],
      replacement: "",
    });
    expect(byNode.get("pc")).toMatchObject({
      field: "value",
      kinds: ["form_value"],
      replacement: "",
    });
    expect(byNode.has("s")).toBe(false);
  });
});
