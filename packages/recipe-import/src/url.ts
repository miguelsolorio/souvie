// URL import (WS02): fetch the page, read its structured data with recipe-scrapers, and fall back
// to a model reading the page text. docs/03-ai-design.md §4.
//
//   importFromUrl(url)         fetch with a desktop user agent and a 10 s budget, then:
//   importFromHtml(html, url)  scrapers (JSON-LD, microdata, site rules) -> normalize
//                              no recipe or no ingredients -> readable text -> Sonnet
//
// `importFromHtml` is the entry point the golden-set eval and WS15 use with recorded pages, so it
// never touches the network.
//
// What this module refuses to do, on purpose:
//   * fetch a video platform page (Instagram, TikTok, YouTube, ...). Caption-only import is a
//     product rule (R11); see caption.ts.
//   * fetch a private, loopback, or link-local address, follow a redirect into one, or talk to a
//     non-web port. The URL comes from a user and the fetch runs on our infrastructure.
//   * read more than `maxBytes` of a page.

import * as cheerio from "cheerio";
import { ExtractorPlugin, getScraper, LogLevel, type RecipeFields } from "recipe-scrapers";
import {
  hasJsonLdRecipe,
  jsonLdIngredientLines,
  looksLikeChallenge,
  pageImage,
  readableText,
} from "./html.ts";
import { JsonLdInstructionsPlugin } from "./jsonld.ts";
import {
  cleanImageUrl,
  cleanSourceUrl,
  normalizeModelOutput,
  normalizeScraped,
  recipeWarnings,
  type ScrapedRecipe,
} from "./normalize.ts";
import {
  failure,
  type ImportDeps,
  type ImportFailure,
  type ImportResult,
  type UrlImportDeps,
} from "./schema.ts";
import { isVideoPlatformUrl } from "./share.ts";
import { runExtraction } from "./text.ts";

/** Sent with every page fetch (docs/04: "fetch with a desktop user agent"). */
export const DESKTOP_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

export const DEFAULT_TIMEOUT_MS = 10_000;
export const DEFAULT_MAX_BYTES = 4 * 1024 * 1024;
const MAX_REDIRECTS = 5;

// ---------------------------------------------------------------------------------------
// Address checks
// ---------------------------------------------------------------------------------------

function isPrivateIPv4(host: string): boolean {
  const parts = host.split(".").map((p) => Number(p));
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255))
    return true;
  const [a, b] = parts as [number, number, number, number];
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

/**
 * True when an IP literal or host name must not be fetched: private, loopback, link-local,
 * multicast, or an internal-looking name. For IPv6 only global unicast (2000::/3) is allowed, minus
 * 6to4 and Teredo, which embed IPv4 addresses.
 */
export function isPrivateHost(hostname: string): boolean {
  const host = hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "");
  if (host === "") return true;
  if (host.includes(":")) {
    return (
      !/^[23][0-9a-f]{3}:/.test(host) ||
      host.startsWith("2002:") ||
      host.startsWith("2001:0:") ||
      host.startsWith("2001::")
    );
  }
  if (/^[0-9.]+$/.test(host)) return isPrivateIPv4(host);
  if (/^(?:0x[0-9a-f]+|\d+)$/.test(host)) return true; // a number the URL parser should have rewritten
  return (
    !host.includes(".") ||
    host === "localhost" ||
    /\.(?:localhost|local|internal|lan|home|corp|intranet|home\.arpa)$/.test(host) ||
    host === "metadata.google.internal"
  );
}

export type UrlCheck = { ok: true; url: URL } | { ok: false; failure: ImportFailure };

/**
 * Validates an address before any request: web scheme, no credentials, a normal port, not a video
 * platform, not a private host (and, with `resolveHost`, no private address behind the name).
 */
export async function checkUrl(
  raw: string,
  resolveHost?: (hostname: string) => Promise<string[]>,
): Promise<UrlCheck> {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return { ok: false, failure: failure("invalid_request", "That is not a valid web address.") };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return {
      ok: false,
      failure: failure("invalid_request", "Only http and https links can be imported."),
    };
  }
  if (url.username || url.password) {
    return {
      ok: false,
      failure: failure("invalid_request", "Links with a username or password cannot be imported."),
    };
  }
  if (url.port !== "" && url.port !== "80" && url.port !== "443") {
    return { ok: false, failure: failure("invalid_request", "That address uses an unusual port.") };
  }
  if (isVideoPlatformUrl(url.href)) {
    return {
      ok: false,
      failure: failure(
        "video_platform",
        "Video pages are not downloaded. Share the post into the app to import its caption.",
      ),
    };
  }
  if (isPrivateHost(url.hostname)) {
    return {
      ok: false,
      failure: failure("invalid_request", "That address is not a public web page."),
    };
  }
  if (resolveHost && !/^[0-9.]+$/.test(url.hostname) && !url.hostname.startsWith("[")) {
    let addresses: string[];
    try {
      addresses = await resolveHost(url.hostname);
    } catch {
      return { ok: false, failure: failure("fetch_failed", "We could not find that site.") };
    }
    if (addresses.length === 0 || addresses.some((address) => isPrivateHost(address))) {
      return {
        ok: false,
        failure: failure("invalid_request", "That address is not a public web page."),
      };
    }
  }
  return { ok: true, url };
}

// ---------------------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------------------

const BLOCKED_STATUSES = new Set([401, 403, 407, 429, 451]);

function charsetOf(contentType: string | null, head: Uint8Array): string {
  const fromHeader = /charset=["']?([\w-]+)/i.exec(contentType ?? "")?.[1];
  if (fromHeader) return fromHeader;
  const sniffed = /<meta[^>]+charset=["']?([\w-]+)/i.exec(
    new TextDecoder("latin1").decode(head.subarray(0, 4096)),
  )?.[1];
  return sniffed ?? "utf-8";
}

function decode(bytes: Uint8Array, contentType: string | null): string {
  const label = charsetOf(contentType, bytes);
  try {
    return new TextDecoder(label).decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

async function readBody(res: Response, maxBytes: number): Promise<Uint8Array | "too_large"> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) return "too_large";
  const reader = res.body?.getReader();
  if (!reader) return new Uint8Array(await res.arrayBuffer());
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      return "too_large";
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

export type PageFetch =
  | { ok: true; html: string; finalUrl: string }
  | { ok: false; failure: ImportFailure };

/** Fetches one page: manual redirects (each hop re-checked), a time budget, a size cap. */
export async function fetchPage(rawUrl: string, deps: UrlImportDeps = {}): Promise<PageFetch> {
  const doFetch = deps.fetch ?? fetch;
  const maxBytes = deps.maxBytes ?? DEFAULT_MAX_BYTES;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    let next = rawUrl;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const checked = await checkUrl(next, deps.resolveHost);
      if (!checked.ok) return checked;

      const res = await doFetch(checked.url.href, {
        method: "GET",
        redirect: "manual",
        signal: controller.signal,
        headers: {
          "user-agent": DESKTOP_USER_AGENT,
          accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
          "accept-language": "en-US,en;q=0.9",
        },
      });

      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get("location");
        await res.body?.cancel();
        if (!location)
          return {
            ok: false,
            failure: failure("fetch_failed", "The site sent a bad redirect.", res.status),
          };
        next = new URL(location, checked.url).href;
        continue;
      }

      if (BLOCKED_STATUSES.has(res.status)) {
        await res.body?.cancel();
        return {
          ok: false,
          failure: failure(
            "blocked",
            `The site refused the request (HTTP ${res.status}).`,
            res.status,
          ),
        };
      }
      if (res.status < 200 || res.status >= 300) {
        await res.body?.cancel();
        return {
          ok: false,
          failure: failure("fetch_failed", `The site answered HTTP ${res.status}.`, res.status),
        };
      }

      const contentType = res.headers.get("content-type");
      if (contentType && !/(?:text\/html|application\/xhtml\+xml|text\/plain)/i.test(contentType)) {
        await res.body?.cancel();
        return {
          ok: false,
          failure: failure("not_html", "That link is not a web page.", res.status),
        };
      }

      const body = await readBody(res, maxBytes);
      if (body === "too_large") {
        return {
          ok: false,
          failure: failure("too_large", "That page is too large to import.", res.status),
        };
      }
      return { ok: true, html: decode(body, contentType), finalUrl: checked.url.href };
    }
    return { ok: false, failure: failure("fetch_failed", "The link redirected too many times.") };
  } catch (err) {
    const aborted =
      controller.signal.aborted || (err instanceof Error && err.name === "AbortError");
    return {
      ok: false,
      failure: failure(
        "fetch_failed",
        aborted ? "The site took too long to answer." : "We could not load that page.",
      ),
    };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------------------
// recipe-scrapers
// ---------------------------------------------------------------------------------------

/**
 * recipe-scrapers requires a description and an http(s) image on every recipe and throws without
 * them. A recipe with neither is still a recipe, so this plugin supplies empty values at the
 * lowest priority; `normalize.ts` drops what is not a real image link.
 */
class LenientFieldsPlugin extends ExtractorPlugin {
  name = "LenientFieldsPlugin";
  priority = -10;

  supports(field: string): boolean {
    return field === "description" || field === "image";
  }

  extract<Key extends keyof RecipeFields>(field: Key): RecipeFields[Key] {
    // Only description and image reach this method, and both are strings. Try the page's own
    // preview metadata (protocol-relative image links are why the library gives up), else "".
    const value =
      field === "image"
        ? (cleanImageUrl(this.$('meta[property="og:image"]').attr("content")) ?? "")
        : (this.$('meta[property="og:description"]').attr("content") ??
          this.$('meta[name="description"]').attr("content") ??
          "");
    return value as RecipeFields[Key];
  }
}

/** Runs recipe-scrapers on a page. Null when it finds no recipe it can read. */
async function scrapeHtml(html: string, url: string): Promise<ScrapedRecipe | null> {
  try {
    const Scraper = getScraper(url, { wildMode: true });
    const document = cheerio.load(html);
    const scraper = new Scraper(html, url, {
      // Both are required by the library; missing values must not fail the import.
      fallbackAuthor: "unknown",
      fallbackYield: "Yield not specified",
      extraExtractors: [new JsonLdInstructionsPlugin(document), new LenientFieldsPlugin(document)],
      logLevel: LogLevel.ERROR,
    });
    return (await scraper.toRecipeObject()) as ScrapedRecipe;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------------------

/**
 * A page that was already fetched (or recorded) to a recipe. Structured data first; when the
 * scrapers find no recipe or no ingredients, the page text goes to Sonnet. The result's `path`
 * says which one produced it.
 */
export async function importFromHtml(
  html: string,
  url: string,
  deps: ImportDeps = {},
): Promise<ImportResult> {
  const sourceUrl = cleanSourceUrl(url);
  const document = cheerio.load(html);
  const jsonLd = hasJsonLdRecipe(document);

  const scraped = await scrapeHtml(html, url);
  if (scraped) {
    const recipe = normalizeScraped(scraped, sourceUrl, {
      referenceIngredients: jsonLdIngredientLines(document),
    });
    if (recipe && recipe.ingredients.length > 0) {
      return {
        ok: true,
        recipe,
        path: jsonLd ? "jsonld" : "scraper",
        warnings: recipeWarnings(recipe),
      };
    }
  }

  // No structured recipe. Before paying for a model, rule out a bot-check page.
  if (looksLikeChallenge(html)) {
    return failure("blocked", "The site showed a bot check instead of the recipe.");
  }

  const image = pageImage(document, sourceUrl);
  const text = readableText(document);
  if (text.length < 120) {
    return failure("no_recipe_found", "The page has no readable recipe.");
  }
  if (!deps.extract) {
    return failure(
      "model_unavailable",
      "No structured recipe on the page and no model to read it.",
    );
  }

  const run = await runExtraction(deps, { source: "web_page", text, sourceUrl });
  if (!run.ok) return run;

  const recipe = normalizeModelOutput(run.output, { sourceUrl, imageUrl: image });
  if (!recipe) return failure("no_recipe_found", "We could not find a recipe on that page.");
  return { ok: true, recipe, path: "llm", warnings: recipeWarnings(recipe) };
}

/** Fetches a recipe page and imports it. Never fetches a video platform or a private address. */
export async function importFromUrl(
  rawUrl: string,
  deps: UrlImportDeps = {},
): Promise<ImportResult> {
  const page = await fetchPage(rawUrl, deps);
  if (!page.ok) return page.failure;
  return importFromHtml(page.html, page.finalUrl, deps);
}
