// WS08: the dev snapshot tool's scrubber finds personal data in a signed-in page, lists each
// replacement for review, and applies only the ones kept.
import { findByText, type SnapshotTree } from "@mp/retailers";
import { afterEach, describe, expect, it } from "vitest";
import { applyReplacements, findPersonalData, snapshotFileName } from "../scrub";
import { createPageHarness, type PageHarness, TEST_PAGE_URL } from "./jsdomPage";

let page: PageHarness | null = null;
afterEach(() => {
  page?.close();
  page = null;
});

async function signedInTree(): Promise<SnapshotTree> {
  page = createPageHarness();
  await page.host.navigate(`${TEST_PAGE_URL}?signin=1#account`);
  const doc = page.window().document;
  (doc.getElementById("password") as HTMLInputElement).value = "x";
  (doc.getElementById("signin") as HTMLFormElement).requestSubmit();
  return page.host.snapshot();
}

describe("scrub", () => {
  it("finds the email, name, order number and address on the signed-in test page", async () => {
    const tree = await signedInTree();
    const found = findPersonalData(tree);
    const kinds = new Set(found.flatMap((r) => r.kinds));
    for (const k of ["email", "name", "order", "address", "url_query"])
      expect(kinds.has(k as never)).toBe(true);

    const clean = applyReplacements(tree, found, new Set(found.map((r) => r.index)));
    const text = JSON.stringify(clean);
    expect(text).not.toContain("test.shopper@example.test");
    expect(text).not.toContain("A1234567");
    expect(text).not.toContain("123 Fixture Lane");
    expect(text).toContain("shopper@example.test");
    expect(clean.url).toBe(TEST_PAGE_URL);
    // The input is untouched.
    expect(JSON.stringify(tree)).toContain("A1234567");
  });

  it("applies only the replacements the reviewer kept", async () => {
    const tree = await signedInTree();
    const found = findPersonalData(tree);
    const order = found.find((r) => r.kinds.includes("order"));
    if (!order) throw new Error("no order number found");
    const keep = new Set(found.filter((r) => r.index !== order.index).map((r) => r.index));
    const clean = applyReplacements(tree, found, keep);
    expect(findByText(clean, "A1234567")).toHaveLength(1);
  });

  it("handles phones, cards, greetings and personal form values, and leaves prices alone", () => {
    const tree: SnapshotTree = {
      url: "https://shop.example/checkout?token=abc",
      title: "Checkout",
      capturedAt: "2026-10-31T18:00:00.000Z",
      root: {
        id: "r",
        role: "document",
        name: "Checkout",
        bbox: [0, 0, 1, 1],
        children: [
          { id: "a", role: "text", name: "Hi, Jordan Rivera", bbox: [0, 0, 1, 1] },
          { id: "b", role: "text", name: "Call (206) 555-1234 with questions", bbox: [0, 0, 1, 1] },
          { id: "c", role: "text", name: "Visa ending in 4242", bbox: [0, 0, 1, 1] },
          {
            id: "d",
            role: "textbox",
            name: "Street address",
            value: "9 Elm St",
            bbox: [0, 0, 1, 1],
          },
          { id: "e", role: "text", name: "$4.99", bbox: [0, 0, 1, 1] },
          { id: "f", role: "text", name: "Order history", bbox: [0, 0, 1, 1] },
          {
            id: "g",
            role: "link",
            name: "Help",
            href: "https://shop.example/help?ref=mail",
            bbox: [0, 0, 1, 1],
          },
        ],
      },
    };
    const found = findPersonalData(tree);
    const byNode = new Map(found.map((r) => [r.nodeId, r]));
    expect(byNode.get("a")?.replacement).toBe("Hi, Test Shopper");
    expect(byNode.get("b")?.replacement).toBe("Call 555-0100 with questions");
    expect(byNode.get("c")?.replacement).toBe("card ending 0000");
    expect(byNode.get("d")).toMatchObject({
      field: "value",
      kinds: ["form_value"],
      replacement: "",
    });
    expect(byNode.has("e")).toBe(false);
    expect(byNode.has("f")).toBe(false);
    expect(byNode.get("g")?.replacement).toBe("https://shop.example/help");
    expect(found.find((r) => r.field === "url")?.replacement).toBe("https://shop.example/checkout");
    expect(snapshotFileName(tree)).toBe("shop.example-20261031-1800.snapshot.json");
  });
});
