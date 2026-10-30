import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { tokens } from "../../../packages/ui/src/tokens";

const script = fileURLToPath(new URL("../scripts/sync-brand.mjs", import.meta.url));
const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");

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
