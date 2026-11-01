// Serves the Tier 3 test page on a fixed port for the Simulator demo (WS08):
//
//   pnpm --filter @mp/mobile tier3:test-page      # http://localhost:8790/
//
// The iOS Simulator reaches the Mac's localhost. EXPO_PUBLIC_TIER3_TEST_PAGE_URL points the
// (dev)/snapshot tool here; a public static host replaces it later. Serves this folder only.
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.TIER3_TEST_PAGE_PORT || 8790);
const types = { ".html": "text/html; charset=utf-8", ".json": "application/json" };

createServer(async (req, res) => {
  const path = new URL(req.url ?? "/", "http://localhost").pathname;
  const file = normalize(join(root, path.endsWith("/") ? `${path}index.html` : path));
  if (!file.startsWith(root) || file.endsWith(".mjs")) {
    res.writeHead(404).end("not found");
    return;
  }
  try {
    const body = await readFile(file);
    const ext = file.slice(file.lastIndexOf("."));
    res.writeHead(200, { "content-type": types[ext] ?? "application/octet-stream" }).end(body);
  } catch {
    // Any other path (a sign-in URL, for the login check) gets the page itself.
    res
      .writeHead(200, { "content-type": types[".html"] })
      .end(await readFile(join(root, "index.html")));
  }
}).listen(port, () => console.log(`Tier 3 test page at http://localhost:${port}/`));
