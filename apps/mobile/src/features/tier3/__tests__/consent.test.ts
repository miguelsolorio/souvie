// WS08: consent.ts carries the copy Miguel approved at checkpoint 4 (docs/08-brand.md §11), word for
// word, and the version the orchestrator set. If either file changes alone, this fails.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { TIER3_RETAILER_IDS } from "@mp/retailers";
import { describe, expect, it } from "vitest";
import {
  CONSENT_COPY,
  CONSENT_VERSION,
  needsConsent,
  parseConsent,
  renderConsentCopy,
  TIER3_RETAILERS,
} from "../consent";
import { retailerDisplayName, TIER3_STORES } from "../stores";
import { HERE_ROOT } from "./jsdomPage";

const BRAND_DOC = join(HERE_ROOT, "..", "..", "..", "..", "..", "..", "docs", "08-brand.md");

function approvedCopy() {
  const doc = readFileSync(BRAND_DOC, "utf8");
  const start = doc.indexOf("## 11. Tier 3 consent screen");
  const end = doc.indexOf("\n## ", start + 10);
  const lines = doc
    .slice(start, end === -1 ? undefined : end)
    .split("\n")
    .map((l) => l.trim());
  const title = lines.find((l) => l.startsWith("**Title:** "))?.slice("**Title:** ".length);
  const ack = lines
    .find((l) => l.startsWith("**Acknowledgment (checkbox):** "))
    ?.slice("**Acknowledgment (checkbox):** ".length);
  const sections: { heading: string; body: string }[] = [];
  lines.forEach((line, i) => {
    const heading = /^\*\*([^*]+)\*\*$/.exec(line)?.[1];
    if (heading) sections.push({ heading, body: lines[i + 1] ?? "" });
  });
  return { title, sections, acknowledgment: ack };
}

describe("the consent copy", () => {
  it("is docs/08 §11 verbatim: title, five sections, acknowledgment", () => {
    const approved = approvedCopy();
    expect(approved.sections).toHaveLength(5);
    expect(CONSENT_COPY.title).toBe(approved.title);
    expect(CONSENT_COPY.sections).toEqual(approved.sections);
    expect(CONSENT_COPY.acknowledgment).toBe(approved.acknowledgment);
  });

  it("is version 2026-10-31 and covers the two Tier 3 retailers and four stores", () => {
    expect(CONSENT_VERSION).toBe("2026-10-31");
    expect(TIER3_RETAILERS).toEqual(["safeway", "costco"]);
    expect(TIER3_RETAILERS).toBe(TIER3_RETAILER_IDS);
    expect(TIER3_STORES.map((s) => `${s.name}:${s.retailer}`)).toEqual([
      "Safeway:safeway",
      "Albertsons:safeway",
      "Haggen:safeway",
      "Costco:costco",
    ]);
    expect(retailerDisplayName("safeway")).toBe("Safeway, Albertsons and Haggen");
  });

  it("fills {store} everywhere and has no em dash", () => {
    const copy = renderConsentCopy("Haggen");
    const all = [
      copy.title,
      copy.acknowledgment,
      ...copy.sections.flatMap((s) => [s.heading, s.body]),
    ];
    expect(all.join(" ")).not.toContain("{store}");
    expect(copy.title).toBe("Before Souvie shops at Haggen");
    expect(all.join(" ")).not.toContain(String.fromCodePoint(0x2014));
  });

  it("needsConsent: none, another retailer, an older version all need it; a match does not", () => {
    const base = {
      accepted_at: "2026-10-31T18:00:00Z",
      by_user_id: "a1111111-1111-4111-8111-111111111111",
    };
    expect(needsConsent(null, "safeway")).toBe(true);
    expect(
      needsConsent({ ...base, retailers: ["costco"], copy_version: CONSENT_VERSION }, "safeway"),
    ).toBe(true);
    expect(
      needsConsent({ ...base, retailers: ["safeway"], copy_version: "2026-09-01" }, "safeway"),
    ).toBe(true);
    expect(
      needsConsent({ ...base, retailers: ["safeway"], copy_version: CONSENT_VERSION }, "safeway"),
    ).toBe(false);
    expect(parseConsent({ ...base, retailers: ["safeway"], copy_version: "v" })).toEqual({
      ...base,
      retailers: ["safeway"],
      copy_version: "v",
    });
    expect(parseConsent({ retailers: "safeway" })).toBeNull();
  });
});
