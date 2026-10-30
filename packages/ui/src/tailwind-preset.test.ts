import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import postcss from "postcss";
import tailwind from "tailwindcss";
import { describe, expect, it } from "vitest";
import preset from "../tailwind.preset.js";
import { colorVars, hexToTriplet, tokensCss } from "./css";
import { tokens } from "./tokens";

const CLASSES = [
  "bg-surface",
  "bg-surface-raised",
  "text-content",
  "text-content-muted",
  "text-content-on-primary",
  "border-line",
  "border-line-strong",
  "bg-primary",
  "bg-primary-600",
  "bg-surface/50",
  "p-4",
  "gap-3",
  "rounded-lg",
  "shadow-md",
  "text-display",
  "text-caption",
].join(" ");

async function compile(): Promise<string> {
  const config = { presets: [preset as never], content: [{ raw: CLASSES }] };
  const result = await postcss([tailwind(config)]).process("@tailwind base; @tailwind utilities;", {
    from: undefined,
  });
  return result.css;
}

describe("tailwind.preset.js", () => {
  it("emits light variables on :root and dark variables on :root.dark", async () => {
    const css = await compile();
    expect(css).toMatch(
      new RegExp(`:root\\s*{[^}]*--color-surface: ${hexToTriplet(tokens.color.light.surface)}`),
    );
    expect(css).toMatch(
      new RegExp(
        `:root\\[class~="dark"\\]\\s*{[^}]*--color-surface: ${hexToTriplet(tokens.color.dark.surface)}`,
      ),
    );
  });

  it("maps semantic colors to mode-aware variables", async () => {
    const css = await compile();
    expect(css).toMatch(/\.bg-surface\s*{[^}]*rgb\(var\(--color-surface\) \/ var\(--tw-bg-opacity/);
    expect(css).toMatch(/\.bg-surface-raised\s*{[^}]*--color-surface-raised/);
    expect(css).toMatch(/\.text-content\s*{[^}]*--color-text\)/);
    expect(css).toMatch(/\.text-content-on-primary\s*{[^}]*--color-text-on-primary/);
    expect(css).toMatch(/\.border-line-strong\s*{[^}]*--color-border-strong/);
    expect(css).toMatch(/\.bg-primary\s*{[^}]*--color-primary\)/);
  });

  it("supports opacity modifiers on semantic colors", async () => {
    const css = await compile();
    expect(css).toMatch(/\.bg-surface\\\/50\s*{[^}]*rgb\(var\(--color-surface\) \/ 0\.5\)/);
  });

  it("keeps fixed scales as literal colors", async () => {
    const css = await compile();
    expect(css).toMatch(
      new RegExp(`\\.bg-primary-600\\s*{[^}]*${hexToTriplet(tokens.color.scale.primary[600])}`),
    );
  });

  it("sets spacing, radius, shadow, and type from the tokens, in px", async () => {
    const css = await compile();
    expect(css).toMatch(/\.p-4\s*{\s*padding: 16px/);
    expect(css).toMatch(/\.gap-3\s*{\s*gap: 12px/);
    expect(css).toMatch(/\.rounded-lg\s*{\s*border-radius: 16px/);
    expect(css).toMatch(/\.text-display\s*{[^}]*font-size: 40px[^}]*line-height: 44px/);
    expect(css).toMatch(/\.text-caption\s*{[^}]*font-size: 13px[^}]*line-height: 18px/);
    expect(css).toContain("0px 4px 12px 0px rgb(26 24 20 / 0.1)");
  });

  it("agrees with the CSS the marketing site uses", () => {
    const css = tokensCss();
    for (const [name, hex] of Object.entries(colorVars("dark"))) {
      expect(css, name).toContain(`${name}: ${hex};`);
    }
    expect(css).toContain("@media (prefers-color-scheme: dark)");
    expect(css).toContain(':root[data-theme="dark"]');
  });

  it("loads under plain Node with no bundler (Metro and the Tailwind CLI do this)", () => {
    const file = fileURLToPath(new URL("../tailwind.preset.js", import.meta.url));
    const out = execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `const m = await import(${JSON.stringify(file)}); console.log(m.default.darkMode)`,
      ],
      { encoding: "utf8", env: { ...process.env, NODE_NO_WARNINGS: "1" } },
    );
    expect(out.trim()).toBe("class");
  });

  it("returns the preset itself from require() so a CommonJS Tailwind config can use it", () => {
    const file = fileURLToPath(new URL("../tailwind.preset.js", import.meta.url));
    const out = execFileSync(
      process.execPath,
      [
        "-e",
        `const p = require(${JSON.stringify(file)}); console.log(p.darkMode, typeof p.theme.extend.colors.surface)`,
      ],
      { encoding: "utf8", env: { ...process.env, NODE_NO_WARNINGS: "1" } },
    );
    expect(out.trim()).toBe("class object");
  });
});
