// Records one golden-set case as a fixture (WS02). Shared by `eval:live` (Node) and
// `record-deno.ts` (Deno), so both write exactly the same bytes for the same page.
//
// What may be written, and why (README "Fixtures and licensing"):
//   * a page with a JSON-LD Recipe is redacted to facts (redact.ts)
//   * a page without one is kept only when the case names an open license in urls.json, because
//     the model path needs the page's real text
//   * anything else is refused

import * as cheerio from "cheerio";
import { importFromHtml, readableText } from "../src/index.ts";
import { fetchPage } from "../src/url.ts";
import type { FixtureMeta } from "./fixtures.ts";
import { redactRecipePage, sameImport } from "./redact.ts";
import type { Case } from "./score.ts";
import { slimHtml } from "./slim.ts";

export interface Recorded {
  /** The fixture to write, or null when the fetch failed (the meta says why). */
  html: string | null;
  meta: FixtureMeta;
}

/**
 * Fetches a case's page and reduces it to a fixture. Throws when the reduction would change what
 * the importer sees, or when the page may not be recorded.
 */
export async function recordCase(
  c: Case,
  recordedWith: "node" | "deno",
  deps: { fetch?: typeof fetch } = {},
): Promise<Recorded> {
  const page = await fetchPage(c.url, deps);
  const fetchedAt = new Date().toISOString();
  if (!page.ok) {
    return {
      html: null,
      meta: { status: page.failure.status ?? 0, reason: page.failure.reason, fetchedAt },
    };
  }

  const redacted = redactRecipePage(page.html);
  let fixture: string;
  let license: Pick<FixtureMeta, "license" | "licenseUrl" | "attribution"> = {};
  if (redacted !== null) {
    fixture = redacted;
  } else if (c.license) {
    fixture = slimHtml(page.html);
    license = {
      license: c.license.name,
      licenseUrl: c.license.url,
      attribution: c.license.attribution,
    };
    // The model reads the page text, so slimming must not change it.
    const before = readableText(cheerio.load(page.html));
    const after = readableText(cheerio.load(fixture));
    if (before !== after) {
      throw new Error(`${c.id}: the slimmed page reads differently from the full page`);
    }
  } else {
    throw new Error(
      `${c.id}: the page has no JSON-LD recipe and the case names no open license, ` +
        "so its text may not be recorded. Add a license to urls.json or drop the case.",
    );
  }

  const [full, reduced] = await Promise.all([
    importFromHtml(page.html, page.finalUrl, {}),
    importFromHtml(fixture, page.finalUrl, {}),
  ]);
  if (!sameImport(full, reduced)) {
    throw new Error(`${c.id}: the reduced page imports differently from the full page`);
  }

  return {
    html: fixture,
    meta: {
      status: 200,
      finalUrl: page.finalUrl,
      fetchedAt,
      bytes: new TextEncoder().encode(fixture).length,
      kind: redacted !== null ? "redacted" : "licensed",
      recordedWith,
      ...license,
    },
  };
}
