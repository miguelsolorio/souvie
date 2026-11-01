// WS08 demo round: the test page's visible feedback (a pressed Add, the cart counter, the late
// note) changes how the page looks and nothing the host reads. The tree after a click differs from
// the tree before it only by the cart's text, and the keyframes move colour and shadow only. The
// committed fixture is held to the page by bridge.test.ts and snapshot.test.ts; this file holds
// the feedback to its promise.
import { diffSnapshots, findByRole, findByText, nearestButton } from "@mp/retailers";
import { afterEach, describe, expect, it } from "vitest";
import { createPageHarness, type PageHarness, TEST_PAGE_HTML, TEST_PAGE_URL } from "./jsdomPage";

let page: PageHarness | null = null;
afterEach(() => {
  page?.close();
  page = null;
});

async function open() {
  page = createPageHarness();
  await page.host.navigate(TEST_PAGE_URL);
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

  it("keeps the keyboard down and scrolls the search box into view when it takes focus", async () => {
    const p = await open();
    const doc = p.window().document;
    const search = doc.getElementById("search");
    expect(search?.getAttribute("inputmode")).toBe("none");
    const scrolls: unknown[] = [];
    (search as unknown as { scrollIntoView: (o: unknown) => void }).scrollIntoView = (o) =>
      scrolls.push(o);
    const tree = await p.host.snapshot();
    const [box] = findByRole(tree, "searchbox");
    if (!box) throw new Error("no search box");
    await p.host.type(box.id, "oat", { clear: true });
    expect(scrolls).toContainEqual({ block: "center" });
  });
});
