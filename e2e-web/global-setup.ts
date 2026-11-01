import { DIST } from "./support/dist";
import { assertTestBuild } from "./support/exportGuard";

/**
 * Runs once before any test. Fails the whole run unless the export is the placeholder build, so a
 * suite can never be pointed at the hosted Supabase project by what happens to be in dist.
 */
export default function globalSetup(): void {
  assertTestBuild(DIST);
}
