import { defineConfig } from "vitest/config";

// `pnpm --filter marketing test` runs the TypeScript tests only. tests/sections.test.mjs is a
// node:test file that needs a build first, so it runs on its own (`pnpm test:sections`).
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
  },
});
