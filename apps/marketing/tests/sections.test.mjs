// Parses dist/index.html and checks the landing page structure (acceptance criterion 3).
// Run after a build:  pnpm --filter @mp/marketing build && node apps/marketing/tests/sections.test.mjs

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const distIndex = fileURLToPath(new URL("../dist/index.html", import.meta.url));

if (!existsSync(distIndex)) {
  console.error("dist/index.html not found. Run `pnpm --filter @mp/marketing build` first.");
  process.exit(1);
}

const html = readFileSync(distIndex, "utf8");

/** Visible text of an HTML fragment: tags, scripts, and styles removed, spaces collapsed. */
function text(fragment) {
  return fragment
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

/** The six top-level blocks, in document order: five sections inside <main>, then the footer. */
const blocks = [...html.matchAll(/<(section|footer)\b([^>]*)>([\s\S]*?)<\/\1>/gi)].map((match) => ({
  tag: match[1].toLowerCase(),
  name:
    /data-section="([^"]+)"/.exec(match[2])?.[1] ??
    (match[1].toLowerCase() === "footer" ? "footer" : undefined),
  inner: match[3],
}));

describe("landing page sections", () => {
  it("has the six sections in order: hero, how it works, stores, trust, waitlist, footer", () => {
    assert.deepEqual(
      blocks.map((block) => block.name),
      ["hero", "how-it-works", "stores", "trust", "waitlist", "footer"],
    );
  });

  it("puts the five sections inside <main> and the footer after it", () => {
    const main = /<main\b[^>]*>([\s\S]*?)<\/main>/i.exec(html);
    assert.ok(main, "has a <main>");
    for (const name of ["hero", "how-it-works", "stores", "trust", "waitlist"]) {
      assert.ok(main[1].includes(`data-section="${name}"`), `${name} is inside <main>`);
    }
    assert.ok(!/<footer\b/i.test(main[1]), "the footer is outside <main>");
  });

  it("hero: slogan, positioning, and a waitlist call to action", () => {
    const hero = text(blocks[0].inner);
    assert.match(hero, /Dinner, decided\./);
    assert.match(hero, /Groceries, done\./);
    assert.match(hero, /plans your household's week/);
    assert.match(hero, /Join the waitlist/);
    assert.match(hero, /Coming to iOS and web/);
    assert.match(blocks[0].inner, /href="#waitlist"/);
  });

  it("how it works: three steps named Plan, List, Cart", () => {
    const section = blocks[1].inner;
    const steps = [...section.matchAll(/<li class="step[^"]*"[^>]*>([\s\S]*?)<\/li>/gi)].map(
      (match) => /<h3[^>]*>([\s\S]*?)<\/h3>/i.exec(match[1])?.[1].trim(),
    );
    assert.deepEqual(steps, ["Plan", "List", "Cart"]);
  });

  it("stores: the text list, no retailer logos", () => {
    const section = text(blocks[2].inner);
    assert.match(
      section,
      /Works with QFC, Fred Meyer, Safeway, Albertsons, and Costco in Washington\./,
    );
    assert.ok(!/<img\b/i.test(blocks[2].inner), "no images in the stores section");
  });

  it("trust: no card data, pay in the store's app, export and delete", () => {
    const section = text(blocks[3].inner);
    assert.match(section, /We never see your card/);
    assert.match(section, /pay in the store's own app/i);
    assert.match(section, /export or delete everything/i);
  });

  it("waitlist: a labelled form with a honeypot and a live status region", () => {
    const section = blocks[4].inner;
    assert.match(section, /<form[^>]*id="waitlist-form"/);
    assert.match(section, /<label[^>]*for="waitlist-email"/);
    assert.match(
      section,
      /<input[^>]*name="email"[^>]*type="email"|<input[^>]*type="email"[^>]*name="email"/,
    );
    assert.match(section, /<input[^>]*name="website"[^>]*tabindex="-1"/);
    assert.match(
      section,
      /role="status"[^>]*aria-live="polite"|aria-live="polite"[^>]*role="status"/,
    );
  });

  it("footer: privacy policy link and the trademark line, with its spacing intact", () => {
    assert.match(blocks[5].inner, /<a[^>]*href="\/privacy\/"[^>]*>\s*Privacy policy\s*<\/a>/);
    assert.match(
      text(blocks[5].inner),
      /trademarks of their owners\. Meal Planner isn't affiliated with or endorsed by them\./,
    );
  });
});

describe("page-wide rules", () => {
  it("has one h1 and a lang attribute", () => {
    assert.equal([...html.matchAll(/<h1\b/gi)].length, 1);
    assert.match(html, /<html[^>]*lang="en"/);
  });

  it("shows no retailer logos or prices", () => {
    assert.ok(
      !/<img\b[^>]*(qfc|kroger|fred-?meyer|safeway|albertsons|costco|instacart)/i.test(html),
    );
    assert.ok(!/\$\s?\d/.test(text(html)), "no dollar amounts");
  });

  it("never says partner near Instacart, Free Delivery, or Kroger in the title", () => {
    const page = text(html);
    assert.ok(!/free[\s-]*delivery/i.test(page));
    assert.ok(!/partner/i.test(page));
    const title = /<title>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? "";
    assert.ok(!/kroger/i.test(title));
  });
});
