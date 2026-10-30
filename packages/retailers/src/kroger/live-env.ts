// Developer-only helpers for the live Kroger smoke test and the login script. Node only; never
// imported by the adapter, the app, or an Edge Function. Values are read, never printed.
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { RefreshTokenVault } from "./auth.ts";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");

/** The env file to read when a variable is not in the environment. A worktree can point at the
 * main checkout's file with KROGER_ENV_FILE. */
const ENV_FILE = process.env.KROGER_ENV_FILE ?? join(REPO_ROOT, ".env.local");

/** Where the developer's own Kroger refresh token lives. `.env.*.local` is gitignored. */
export const LIVE_TOKEN_FILE =
  process.env.KROGER_LIVE_TOKEN_FILE ?? join(REPO_ROOT, ".env.kroger.local");

function readEnvFile(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (!m?.[1]) continue;
    out[m[1]] = (m[2] ?? "")
      .replace(/\s+#.*$/, "")
      .trim()
      .replace(/^["']|["']$/g, "");
  }
  return out;
}

/** A variable from the environment, else .env.local (or KROGER_ENV_FILE), else the token file. */
export function liveEnv(name: string): string | undefined {
  const fromEnv = process.env[name]?.trim();
  if (fromEnv) return fromEnv;
  const fromLocal = readEnvFile(ENV_FILE)[name];
  if (fromLocal) return fromLocal;
  return readEnvFile(LIVE_TOKEN_FILE)[name] || undefined;
}

/** Writes the refresh token to the live token file, readable by the owner only. */
export function saveLiveRefreshToken(token: string): void {
  writeFileSync(
    LIVE_TOKEN_FILE,
    `# Developer's own Kroger refresh token for the live smoke test. Gitignored. Never commit.\nKROGER_LIVE_REFRESH_TOKEN=${token}\n`,
    { mode: 0o600 },
  );
  chmodSync(LIVE_TOKEN_FILE, 0o600);
}

/**
 * A vault over the live token file. Kroger reissues the refresh token on every refresh, so
 * `rotate` must persist the new one or the next run is locked out.
 */
export function fileVault(connectionId = "live-smoke"): RefreshTokenVault {
  return {
    async saveConnection(input) {
      saveLiveRefreshToken(input.refreshToken);
      return { connectionId };
    },
    async read() {
      return liveEnv("KROGER_LIVE_REFRESH_TOKEN") ?? null;
    },
    async rotate(_id, refreshToken) {
      process.env.KROGER_LIVE_REFRESH_TOKEN = refreshToken;
      saveLiveRefreshToken(refreshToken);
    },
    async markNeedsReauth() {
      // Nothing to flag outside the database. The test reports the failure.
    },
  };
}
