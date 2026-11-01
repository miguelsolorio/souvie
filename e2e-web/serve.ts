// A static file server for the web export, for the browser tests (WS13).
//
// It answers a request the way Cloudflare Pages does for a project with no 404.html:
//   1. a file at the path ("/_expo/static/js/web/entry-<hash>.js", "/favicon.ico"),
//   2. a folder's index.html ("/plan" -> "plan/index.html"),
//   3. the path plus ".html" ("/sign-in" -> "sign-in.html", "/callback" -> "callback.html"),
//   4. otherwise "/index.html" with status 200 (the single-page-app fallback). A dynamic route
//      such as /list/<id> lands here and the client router takes over.
// Plain Node, no dependency. Erasable TypeScript only, so Node runs it directly.
//
//   node serve.ts [distDir] [port]

import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize, resolve, sep } from "node:path";

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".ico": "image/x-icon",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ttf": "font/ttf",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

function isFile(path: string): boolean {
  return existsSync(path) && statSync(path).isFile();
}

/** Maps a URL path to a file under `root`, or null when nothing (not even the fallback) exists. */
export function resolveRequest(root: string, urlPath: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  const relative = normalize(decoded).replace(/^[/\\]+/, "");
  const target = resolve(root, relative);
  // Never leave the export folder.
  if (target !== root && !target.startsWith(root + sep)) return null;

  const candidates = [target, join(target, "index.html"), `${target}.html`];
  for (const candidate of candidates) {
    if (isFile(candidate)) return candidate;
  }
  const fallback = join(root, "index.html");
  return isFile(fallback) ? fallback : null;
}

export function startServer(root: string, port: number) {
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://localhost").pathname;
    const file = resolveRequest(root, path);
    if (!file) {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("Not found");
      return;
    }
    response.writeHead(200, {
      "content-type": CONTENT_TYPES[extname(file)] ?? "application/octet-stream",
      "cache-control": "no-store",
    });
    createReadStream(file).pipe(response);
  });
  server.listen(port, "127.0.0.1");
  return server;
}

const invokedDirectly = process.argv[1]?.endsWith("serve.ts") ?? false;
if (invokedDirectly) {
  const root = resolve(process.argv[2] ?? "../apps/mobile/dist");
  const port = Number(process.argv[3] ?? 4173);
  if (!isFile(join(root, "index.html"))) {
    console.error(`No index.html in ${root}. Run \`pnpm --filter @mp/mobile export:web\` first.`);
    process.exit(1);
  }
  startServer(root, port);
  console.log(`serving ${root} at http://127.0.0.1:${port}`);
}
