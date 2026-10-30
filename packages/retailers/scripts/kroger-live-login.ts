// Developer tool: get your own Kroger refresh token for the live smoke test's cart step.
//
//   pnpm --filter @mp/retailers kroger:login
//
// 1. Open the printed URL in a browser and sign in to your own Kroger (QFC) account.
// 2. Kroger redirects to souvie://oauth/kroger?code=...&state=... . The browser cannot open that
//    scheme on a Mac, so copy the address from the error page, or from the browser's network
//    panel, and paste it here.
// 3. The refresh token is written to .env.kroger.local (gitignored, mode 600). Nothing is printed.
//
// The app's real flow goes through the retailer-oauth Edge Function and Vault instead.
import { createInterface } from "node:readline/promises";
import { KrogerAdapter } from "../src/kroger/KrogerAdapter.ts";
import { fileVault, LIVE_TOKEN_FILE, liveEnv } from "../src/kroger/live-env.ts";

const clientId = liveEnv("KROGER_CLIENT_ID");
const clientSecret = liveEnv("KROGER_CLIENT_SECRET");
const redirectUri = liveEnv("KROGER_REDIRECT_URI") ?? "souvie://oauth/kroger";
if (!clientId || !clientSecret) {
  console.error("Set KROGER_CLIENT_ID and KROGER_CLIENT_SECRET in .env.local first.");
  process.exit(1);
}

const adapter = new KrogerAdapter({ clientId, clientSecret, redirectUri, vault: fileVault() });
const who = { householdId: "live-smoke", userId: "live-smoke" };
const { authorizeUrl } = await adapter.connect({ ...who, redirectUri, banner: "qfc" });

console.log("\nOpen this URL and sign in to your own Kroger account:\n");
console.log(authorizeUrl);
const rl = createInterface({ input: process.stdin, output: process.stdout });
const pasted = (await rl.question("\nPaste the souvie://oauth/kroger?... address: ")).trim();
rl.close();

const url = new URL(pasted);
const code = url.searchParams.get("code");
const state = url.searchParams.get("state");
if (!code || !state) {
  console.error(
    `No code in that address${url.searchParams.get("error") ? `: ${url.searchParams.get("error")}` : ""}.`,
  );
  process.exit(1);
}
await adapter.completeConnect({ code, state, userId: who.userId });
console.log(`\nSaved your refresh token to ${LIVE_TOKEN_FILE}. It is good for 6 months.`);
