import { resolve } from "node:path";

/**
 * The folder the browser tests serve and check: apps/mobile/dist, or E2E_DIST (relative to
 * e2e-web). One definition, shared by the Playwright config, the global setup and the specs.
 */
export const DIST = resolve(
  import.meta.dirname,
  "..",
  process.env.E2E_DIST ?? "../apps/mobile/dist",
);
