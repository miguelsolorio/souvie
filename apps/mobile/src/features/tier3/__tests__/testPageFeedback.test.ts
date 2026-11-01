// WS08 demo round: the test page's visible feedback (a pressed Add, the cart counter, the late
// note) changes how the page looks and nothing the host reads. The tree after a click differs from
// the tree before it only by the cart's text, and the keyframes move colour and shadow only. The
// committed fixture is held to the page by bridge.test.ts and snapshot.test.ts; this file holds
// the feedback to its promise. The last group covers the one thing that is not on for every visit:
// with ?demo=1 the search box asks for no keyboard and scrolls itself into view. The default page
// leaves both alone, so the host and the device checks see the real keyboard.
import { diffSnapshots, findByRole, findByText, nearestButton } from "@mp/retailers";
import { afterEach, describe, expect, it } from "vitest";
import { createPageHarness, type PageHarness, TEST_PAGE_HTML, TEST_PAGE_URL } from "./jsdomPage";

let page: PageHarness | null = null;
afterEach(() => {
  page?.close();
  page = null;
});

/** The test page with the demo flag, as demo mode opens it. */
const DEMO_PAGE_URL = `${TEST_PAGE_URL}?demo=1`;

async function open(url = TEST_PAGE_URL) {
  page?.close();
  page = createPageHarness();
  await page.host.navigate(url);
  return page;
}

describe("test page feedback", () => {
  it("flashes the pressed Add and the cart counter, and changes only the cart's text", async () => {
    const p = await open();
    const before = await p.host.snapshot();
    const [tile] = findByRole(before, "article").slice(2);
    const add = tile ? nearestButton(before, tile.id, "Add") : null;
    if (!add) throw new Error("no Add button in the third tile");
    await p.host.click(add.id);

    const doc = p.window().document;
    const pressed = doc.querySelectorAll(".add.pressed");
    expect(pressed).toHaveLength(1);
    expect(pressed[0]?.closest("article")?.querySelector("h3")?.textContent).toBe(
      "Meadowline Peanut Butter",
    );
    expect(doc.getElementById("cart-count")?.classList.contains("bump")).toBe(true);
    expect(doc.getElementById("cart-count")?.textContent).toBe("Cart: 1 item");

    const after = await p.host.snapshot();
    const cart = findByText(after, /^Cart:/)[0];
    expect(diffSnapshots(before, after)).toEqual([{ id: cart?.id, fields: ["text"] }]);
  });

  it("flashes again on a second press, not only the first", async () => {
    const p = await open();
    const tree = await p.host.snapshot();
    const [first] = findByRole(tree, "button", "Add");
    if (!first) throw new Error("no Add button");
    await p.host.click(first.id);
    const doc = p.window().document;
    const counter = doc.getElementById("cart-count");
    if (!counter) throw new Error("no cart counter");
    // A finished animation leaves the class on; a new press must take it off and put it back.
    const calls: string[] = [];
    const remove = counter.classList.remove.bind(counter.classList);
    const add = counter.classList.add.bind(counter.classList);
    counter.classList.remove = (...names: string[]) => {
      calls.push(`remove ${names.join(" ")}`);
      remove(...names);
    };
    counter.classList.add = (...names: string[]) => {
      calls.push(`add ${names.join(" ")}`);
      add(...names);
    };
    await p.host.click(first.id);
    expect(calls).toEqual(["remove bump", "add bump"]);
    expect(counter.textContent).toBe("Cart: 2 items");
    expect(counter.classList.contains("bump")).toBe(true);
  });

  it("animates colour and shadow only, so no layout moves", () => {
    const frames = [...TEST_PAGE_HTML.matchAll(/@keyframes\s+[\w-]+\s*\{([\s\S]*?)\n {6}\}/g)];
    expect(frames.length).toBeGreaterThanOrEqual(2);
    for (const [, body] of frames) {
      const properties = [...(body ?? "").matchAll(/([a-z-]+)\s*:/g)].map((m) => m[1]);
      expect(properties.length).toBeGreaterThan(0);
      for (const property of properties) {
        expect(["background-color", "box-shadow"]).toContain(property);
      }
    }
  });

  it("starts the late note's flash when the note is created", async () => {
    // The animation is on the id the late node gets, so it plays when the node appears.
    expect(TEST_PAGE_HTML).toMatch(/#results-note\s*\{[^}]*animation:\s*flash/);
    const p = await open();
    const tree = await p.host.snapshot();
    const [box] = findByRole(tree, "searchbox");
    if (!box) throw new Error("no search box");
    await p.host.type(box.id, "oat milk", { clear: true });
    await p.host.waitFor((t) => findByText(t, 'Showing results for "oat milk"').length > 0, 5_000);
    expect(p.window().document.getElementById("results-note")?.getAttribute("role")).toBe("status");
  });
});

/** Types into the search box and returns what the page did to it: its inputmode and its scrolls. */
async function typeIntoSearch(p: PageHarness) {
  const search = p.window().document.getElementById("search");
  if (!search) throw new Error("no search input");
  const scrolls: unknown[] = [];
  (search as unknown as { scrollIntoView: (o: unknown) => void }).scrollIntoView = (o) =>
    scrolls.push(o);
  const tree = await p.host.snapshot();
  const [box] = findByRole(tree, "searchbox");
  if (!box) throw new Error("no search box");
  await p.host.type(box.id, "oat", { clear: true });
  return { inputmode: search.getAttribute("inputmode"), scrolls };
}

describe("the keyboard and the scroll on the search box", () => {
  it("leave the default page alone, so the iOS keyboard rises over the app as it really does", async () => {
    const p = await open();
    const { inputmode, scrolls } = await typeIntoSearch(p);
    expect(inputmode).toBeNull();
    expect(scrolls).toEqual([]);
  });

  it("are on with ?demo=1: no keyboard, and the box scrolls itself into view on focus", async () => {
    const p = await open(DEMO_PAGE_URL);
    const { inputmode, scrolls } = await typeIntoSearch(p);
    expect(inputmode).toBe("none");
    expect(scrolls).toEqual([{ block: "center" }]);
  });

  it("stay off for other query parameters, and for demo values other than 1", async () => {
    for (const query of ["?slow=100", "?demo=0", "?demo=", "?signin=1"]) {
      const p = await open(`${TEST_PAGE_URL}${query}`);
      const { inputmode, scrolls } = await typeIntoSearch(p);
      expect([query, inputmode, scrolls]).toEqual([query, null, []]);
      p.close();
      page = null;
    }
  });

  it("do not change the tree the host reads: the demo page and the default page are the same", async () => {
    const plain = await open();
    const bare = await plain.host.snapshot();
    plain.close();
    const demo = await open(DEMO_PAGE_URL);
    const flagged = await demo.host.snapshot();
    expect(flagged.url).toBe(DEMO_PAGE_URL);
    expect(bare.url).toBe(TEST_PAGE_URL);
    expect(flagged.nodeCount).toBe(bare.nodeCount);
    // The one difference is the "Back to top" link, whose #top resolves against the page's own URL.
    const [back] = findByRole(bare, "link", "Back to top");
    if (!back) throw new Error("no Back to top link");
    expect(diffSnapshots(bare, flagged)).toEqual([{ id: back.id, fields: ["href"] }]);
    expect(back.href).toBe(`${TEST_PAGE_URL}#top`);
    expect(findByRole(flagged, "link", "Back to top")[0]?.href).toBe(`${DEMO_PAGE_URL}#top`);
  });

  it("are set by the page script, not written into the markup", () => {
    expect(TEST_PAGE_HTML).not.toMatch(/<input[^>]*inputmode="none"/);
    expect(TEST_PAGE_HTML).toMatch(/params\.get\("demo"\) === "1"/);
  });
});
