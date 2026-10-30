import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { tokens } from "../../../packages/ui/src/tokens";
import { site } from "../src/config";

const script = fileURLToPath(new URL("../scripts/sync-brand.mjs", import.meta.url));
const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");

// The name the product had before checkpoint 6. Joined from parts so a repo-wide search for the
// old name finds only places that still use it.
const PLACEHOLDER = ["meal", "planner"].join(" ");

describe("the product name", () => {
  const ui = (name: string) => read(`../../../packages/ui/assets/${name}`);

  it("is Souvie in config.ts", () => {
    expect(site.name).toBe("Souvie");
    expect(site.description.startsWith("Souvie ")).toBe(true);
  });

  it("is the same in config.ts, both logo SVGs, the mark titles, and the OG image", () => {
    for (const file of ["logo.svg", "logo-wordmark.svg"]) {
      const svg = ui(file);
      expect(/<title id="title">([^<]*)<\/title>/.exec(svg)?.[1], `${file} title`).toBe(site.name);
      expect(/<text id="wordmark"[^>]*>([^<]*)<\/text>/.exec(svg)?.[1], `${file} text`).toBe(
        site.name,
      );
    }
    expect(ui("logo-mark.svg")).toContain(`<title id="title">${site.name}</title>`);
    expect(ui("favicon.svg")).toContain(`<title>${site.name}</title>`);
    expect(ui("app-icon.svg")).toContain(`<title>${site.name} app icon</title>`);
    expect(ui("app-icon-foreground.svg")).toContain(
      `<title>${site.name} app icon foreground</title>`,
    );
    expect(ui("splash-icon.svg")).toContain(`<title>${site.name} splash mark</title>`);

    const og = read("../src/assets/og.svg");
    expect(og).toContain(`<title>${site.name}: ${site.headline}</title>`);
    const nameLines = [...og.matchAll(/<!-- NAME -->\s*<text[^>]*>([^<]*)<\/text>/g)].map(
      (match) => match[1],
    );
    expect(nameLines).toEqual([site.name, `${site.name} plans the week and fills your carts.`]);
  });

  it("the placeholder name is gone from the site, the logos, and the OG source", () => {
    for (const text of [
      read("../src/config.ts"),
      read("../src/assets/og.svg"),
      ui("logo.svg"),
      ui("logo-wordmark.svg"),
      ui("logo-mark.svg"),
    ]) {
      expect(text.toLowerCase()).not.toContain(PLACEHOLDER);
    }
  });
});

describe("generated brand files", () => {
  it("are up to date with packages/ui (tokens.css and the public SVGs)", () => {
    const result = spawnSync(process.execPath, [script, "--check"], {
      encoding: "utf8",
      env: { ...process.env, NODE_NO_WARNINGS: "1" },
    });
    expect(`${result.stdout}${result.stderr}`).toContain("up to date");
    expect(result.status).toBe(0);
  });

  it("tokens.css carries every light and dark semantic color", () => {
    const css = read("../src/styles/tokens.css");
    const [lightPart, darkPart] = css.split("@media (prefers-color-scheme: dark)") as [
      string,
      string,
    ];
    for (const [name, hex] of Object.entries(tokens.color.light)) {
      const variable = `--color-${name.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase()}`;
      expect(lightPart, variable).toContain(`${variable}: ${hex};`);
    }
    for (const [name, hex] of Object.entries(tokens.color.dark)) {
      const variable = `--color-${name.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase()}`;
      expect(darkPart, variable).toContain(`${variable}: ${hex};`);
    }
  });

  it("the page styles use token variables and no raw colors", () => {
    const css = read("../src/styles/global.css");
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(css).not.toMatch(/\brgba?\(/);
  });
});
