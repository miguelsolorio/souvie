// Shrinks a page that may be kept whole: one whose text is under an open license (record.ts).
// Real pages are 300 KB to 2 MB, mostly scripts, styles, and inline SVG that no importer reads.
// This keeps what the importers read: the head metadata, JSON-LD, and the body markup with its
// classes and microdata attributes.
//
// Pages with a JSON-LD recipe never come here. They go through redact.ts, which drops their prose.
// For a page that does come here, record.ts checks that the readable text the model would see and
// the import result are unchanged, so a fixture never hides a regression the full page would show.

import * as cheerio from "cheerio";

const REMOVE_ELEMENTS = [
  "style",
  "noscript",
  "iframe",
  "svg",
  "canvas",
  "template",
  "object",
  "embed",
  "video",
  "audio",
  "source",
  "picture",
  "link[rel=stylesheet]",
  "link[rel=preload]",
  "link[rel=prefetch]",
  "link[rel=preconnect]",
  "link[rel=dns-prefetch]",
  "link[rel=modulepreload]",
  "link[rel=alternate]",
  "link[rel=icon]",
  "link[rel=apple-touch-icon]",
  "link[rel=manifest]",
  "link[rel=shortlink]",
  // Page furniture and reader comments. No importer reads them (readableText drops them too).
  "nav",
  "footer",
  "aside",
  "form",
  "button",
  "#comments",
  ".comments",
  ".comments-area",
  ".comment-list",
  "ol.commentlist",
];

const DROP_ATTRIBUTES = ["style", "srcset", "sizes", "onclick", "onload", "nonce", "integrity"];

export function slimHtml(html: string): string {
  const $ = cheerio.load(html);

  // Scripts: keep only structured data.
  $("script").each((_, el) => {
    const type = ($(el).attr("type") ?? "").toLowerCase();
    if (type !== "application/ld+json") $(el).remove();
  });
  $(REMOVE_ELEMENTS.join(",")).remove();

  // Comments.
  $("*")
    .contents()
    .filter((_, node) => node.type === "comment")
    .remove();

  $("*").each((_, el) => {
    if (el.type !== "tag") return;
    for (const name of DROP_ATTRIBUTES) $(el).removeAttr(name);
    for (const name of Object.keys(el.attribs)) {
      const value = el.attribs[name] ?? "";
      // Inline data: images and long tracking blobs.
      if (value.startsWith("data:") || (name.startsWith("data-") && value.length > 200)) {
        $(el).removeAttr(name);
      }
    }
  });

  return $.html()
    .replace(/\n\s*\n+/g, "\n")
    .trim();
}
