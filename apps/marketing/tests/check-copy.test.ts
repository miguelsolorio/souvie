import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const script = fileURLToPath(new URL("../scripts/check-copy.mjs", import.meta.url));

function run(args: string[], root?: string) {
  const result = spawnSync(process.execPath, [script, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...(root ? { CHECK_COPY_ROOT: root } : {}), NODE_NO_WARNINGS: "1" },
  });
  return { code: result.status, out: `${result.stdout}${result.stderr}` };
}

const temp: string[] = [];
function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "check-copy-"));
  temp.push(root);
  for (const [path, content] of Object.entries(files)) {
    const full = join(root, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  return root;
}

function fixture(text: string, name = "fixture.txt"): string {
  const root = tree({ [name]: text });
  return join(root, name);
}

afterEach(() => {
  for (const dir of temp.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("check-copy on the shipped copy", () => {
  it("exits 0", () => {
    const { code, out } = run([]);
    expect(out).toContain("check-copy: ok");
    expect(code).toBe(0);
  });
});

describe("check-copy rules (acceptance criterion 6)", () => {
  it('exits 1 on "our partner Instacart"', () => {
    const { code, out } = run(["--file", fixture("our partner Instacart")]);
    expect(code).toBe(1);
    expect(out).toContain("[instacart-partner]");
  });

  it("catches partner before or after Instacart, and its variants", () => {
    expect(run(["--file", fixture("Instacart is our trusted partner for lists.")]).code).toBe(1);
    expect(run(["--file", fixture("Our partnership with Instacart")]).code).toBe(1);
  });

  it("allows partner when it is not near Instacart", () => {
    const far = `We partner with local farmers.${" Plain words.".repeat(12)} Lists open on Instacart.`;
    expect(run(["--file", fixture(far)]).code).toBe(0);
  });

  it('exits 1 on "Free Delivery" in any case', () => {
    expect(run(["--file", fixture("Free Delivery on your first order")]).code).toBe(1);
    expect(run(["--file", fixture("free-delivery")]).code).toBe(1);
  });

  it("exits 1 on Kroger in a title, heading, or logo text", () => {
    expect(run(["--file", fixture("<title>Kroger Meals</title>")]).code).toBe(1);
    expect(run(["--file", fixture("<h1>Meals for Kroger shoppers</h1>")]).code).toBe(1);
    expect(
      run(["--file", fixture('<meta property="og:title" content="Kroger planner">')]).code,
    ).toBe(1);
    expect(run(["--file", fixture("<text>Kroger Planner</text>")]).code).toBe(1);
    expect(run(["--file", fixture('export const site = { name: "Kroger Planner" };')]).code).toBe(
      1,
    );
  });

  it("allows a plain mention of Kroger in body text", () => {
    expect(run(["--file", fixture("<p>QFC and Fred Meyer are Kroger banners.</p>")]).code).toBe(0);
  });

  it("exits 1 on em dashes, prices, and subscription language", () => {
    expect(run(["--file", fixture("Plan the week — skip the store.")]).code).toBe(1);
    expect(run(["--file", fixture("Only $9.99 a month")]).code).toBe(1);
    expect(run(["--file", fixture("Upgrade to Pro")]).code).toBe(1);
    expect(run(["--file", fixture("Start your subscription")]).code).toBe(1);
  });

  it("exits 1 on a retailer logo image", () => {
    expect(run(["--file", fixture('<img src="/img/qfc-banner.png" alt="QFC">')]).code).toBe(1);
  });

  it("passes clean copy", () => {
    expect(run(["--file", fixture("<p>Lists open ready to shop on Instacart.</p>")]).code).toBe(0);
  });
});

describe("check-copy on a tree (criterion 7 and the docs listing)", () => {
  const doc = (inside: string, outside = "") =>
    `# Brand\n\n${outside}\n\n<!-- copy:start -->\n${inside}\n<!-- copy:end -->\n`;

  it("fails when a retailer logo file sits under apps/marketing/public", () => {
    const root = tree({
      "apps/marketing/public/qfc-logo.png": "x",
      "docs/08-brand.md": doc("Fine copy."),
    });
    const { code, out } = run([], root);
    expect(code).toBe(1);
    expect(out).toContain("[retailer-logo]");
  });

  it("fails on a retailer logo file under src/assets, in any case", () => {
    const root = tree({
      "apps/marketing/src/assets/Kroger-Banner.svg": "<svg/>",
      "docs/08-brand.md": doc("Fine."),
    });
    expect(run([], root).code).toBe(1);
  });

  it("passes a tree with no logos and clean copy blocks", () => {
    const root = tree({
      "apps/marketing/public/logo.svg": "<svg><title>Souvie</title></svg>",
      "apps/marketing/src/pages/index.astro": "<h1>Dinner, decided.</h1>",
      "docs/08-brand.md": doc("- **Title (30):** Souvie: Meal plan to cart"),
    });
    expect(run([], root).code).toBe(0);
  });

  it("checks listing copy inside copy blocks", () => {
    const root = tree({ "docs/08-brand.md": doc("Lists open with our partner Instacart.") });
    const { code, out } = run([], root);
    expect(code).toBe(1);
    expect(out).toContain("docs/08-brand.md");
    expect(out).toContain("[instacart-partner]");
  });

  it("flags Kroger in a listing title or heading", () => {
    const root = tree({ "docs/08-brand.md": doc("- **Title (30):** Kroger Meal Plan") });
    expect(run([], root).code).toBe(1);
  });

  it("ignores rules text outside copy blocks", () => {
    const root = tree({
      "docs/08-brand.md": doc(
        "Fine copy.",
        'Rule: never call Instacart a partner. Never write "Free Delivery".',
      ),
    });
    expect(run([], root).code).toBe(0);
  });

  it("fails when the doc has no copy blocks, so the check cannot silently pass", () => {
    const root = tree({ "docs/08-brand.md": "# Brand\n\nNo markers here." });
    const { code, out } = run([], root);
    expect(code).toBe(1);
    expect(out).toContain("[no-copy-blocks]");
  });
});
