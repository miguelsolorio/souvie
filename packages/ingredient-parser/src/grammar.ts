// Grammar stage (WS03): quantity, unit, noun phrase, preparation, qualifiers.
// Deterministic, no I/O. The lookup stage decides which ontology entry the noun phrase names.

import {
  convert,
  MAX_UNIT_ALIAS_WORDS,
  normalizeUnit,
  type UnitCode,
  unitDimension,
} from "@mp/core";
import {
  DROP_WORDS,
  PREP_ADVERBS,
  PREP_WORDS,
  QUALIFIER_SUFFIXES,
  TRAILING_PREP,
  WORD_NUMBERS,
} from "./lexicon.ts";
import { cleanPhrase, normalizeLine } from "./normalize.ts";

export interface GrammarParse {
  /** The line as given. */
  rawText: string;
  /** The normalized line the grammar worked on. */
  text: string;
  qty: number | null;
  qtyMax: number | null;
  /** Canonical code. "each" when a count was written with no unit; null when there is no qty. */
  unit: UnitCode | null;
  /** True when a unit word was written ("2 cups"), false when it was implied. */
  unitWritten: boolean;
  /** Lowercase noun phrase with qualifiers and trailing preparation removed. May be empty. */
  noun: string;
  /** Preparation and qualifier notes found by the grammar, in reading order. */
  prep: string[];
  optional: boolean;
  /** Quantity came from a package size, as in "1 (14 oz) can". */
  packageSize: boolean;
  /** The container word that went with the amount ("can", "jar"), if any. */
  container: UnitCode | null;
  /** "1 teaspoon each salt and pepper": the amount applies to every ingredient named. */
  distribute: boolean;
  /** Digits followed by a unit are still in the noun phrase: something did not parse. */
  strayQuantity: boolean;
  /** The line is a section header ("For the sauce:"). */
  header: boolean;
}

// ---------------------------------------------------------------------------
// Quantities
// ---------------------------------------------------------------------------

const NUM = String.raw`(?:\d+\.\d+|\.\d+|\d+)`;
const FRAC = String.raw`\d+\s*/\s*\d+`;
const MIXED = String.raw`\d+(?:\s+|-)\d+\s*/\s*\d+`;
const ONE = `(?:${MIXED}|${FRAC}|${NUM})`;
const QTY_RE = new RegExp(String.raw`^(${ONE})(?:\s*(?:-|to|or)\s*(${ONE})(?![\d/]))?`, "i");
const WORD_QTY_RE = new RegExp(
  String.raw`^(${Object.keys(WORD_NUMBERS).join("|")})\b(?:\s+(?:and a half|and a quarter))?`,
  "i",
);

function evalQty(token: string): number {
  const t = token.trim();
  const mixed = t.match(/^(\d+)(?:\s+|-)(\d+)\s*\/\s*(\d+)$/);
  if (mixed) return Number(mixed[1]) + Number(mixed[2]) / Number(mixed[3]);
  const frac = t.match(/^(\d+)\s*\/\s*(\d+)$/);
  if (frac) return Number(frac[1]) / Number(frac[2]);
  return Number(t);
}

function round(n: number): number {
  return Math.round(n * 10000) / 10000;
}

interface QtyRead {
  qty: number;
  qtyMax: number | null;
  rest: string;
  fromWord: boolean;
}

function readQuantity(s: string): QtyRead | null {
  const m = s.match(QTY_RE);
  if (m?.[1]) {
    const lo = evalQty(m[1]);
    const hi = m[2] ? evalQty(m[2]) : null;
    // "1-0" style noise, or a "range" that goes down, is not a range: keep the first number.
    const range = hi != null && hi > lo ? hi : null;
    const consumed = range != null ? m[0].length : m[1].length;
    return {
      qty: round(lo),
      qtyMax: range != null ? round(range) : null,
      rest: s.slice(consumed),
      fromWord: false,
    };
  }
  const w = s.match(WORD_QTY_RE);
  if (w?.[1]) {
    const key = w[1].toLowerCase();
    const base = WORD_NUMBERS[key] ?? 1;
    const bonus = /and a half/i.test(w[0]) ? 0.5 : /and a quarter/i.test(w[0]) ? 0.25 : 0;
    return { qty: base + bonus, qtyMax: null, rest: s.slice(w[0].length), fromWord: true };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Package sizes: "1 (14 oz) can", "two 15-ounce cans", "1 14-oz can"
// ---------------------------------------------------------------------------

const SIZE_RE = new RegExp(
  String.raw`^(?:about |approx\.? |approximately |roughly )?(${ONE})(?:\s*(?:-|to)\s*(${ONE}))?\s*-?\s*([a-z.]+(?: [a-z.]+)?)\.?$`,
  "i",
);
const INLINE_SIZE_RE = new RegExp(String.raw`^(${ONE})\s*-?\s*([a-z]+)\b\.?`, "i");
const LENGTH_RE = /^\d+(?:\.\d+)?(?:\s*-\s*\d+(?:\.\d+)?)?\s*-?\s*(?:inch|inches|in|cm|mm|")$/i;
const CONTAINER_UNITS: ReadonlySet<UnitCode> = new Set<UnitCode>([
  "can",
  "package",
  "packet",
  "jar",
  "bottle",
  "box",
  "bag",
  "block",
  "carton",
  "tub",
  "tube",
  "container",
]);

interface Size {
  qty: number;
  qtyMax: number | null;
  unit: UnitCode;
}

function sizeFrom(content: string): Size | null {
  const m = content.trim().match(SIZE_RE);
  if (!m?.[1] || !m[3]) return null;
  const unit = normalizeUnit(m[3].replace(/\.$/, ""));
  if (!unit || unitDimension(unit) === "count") return null;
  const lo = evalQty(m[1]);
  const hi = m[2] ? evalQty(m[2]) : null;
  return { qty: round(lo), qtyMax: hi != null && hi > lo ? round(hi) : null, unit };
}

const PIECE_WORDS = /^(?:pieces?|portions?|fillets?|filets?|steaks?)\b\s*/i;

function skipContainer(s: string): { rest: string; container: UnitCode | null } {
  const tokens = s.split(" ");
  const first = tokens[0]?.replace(/[.,]+$/, "") ?? "";
  const code = normalizeUnit(first);
  if (code && CONTAINER_UNITS.has(code)) {
    const after = tokens.slice(1);
    if (after[0]?.toLowerCase() === "of") after.shift();
    return { rest: after.join(" "), container: code };
  }
  // "4 (4-ounce) pieces cod": the portion word is not part of the name.
  const piece = s.match(PIECE_WORDS);
  if (piece && s.slice(piece[0].length).trim())
    return { rest: s.slice(piece[0].length), container: null };
  return { rest: s, container: null };
}

// ---------------------------------------------------------------------------
// Units
// ---------------------------------------------------------------------------

interface UnitRead {
  unit: UnitCode;
  rest: string;
}

function readUnit(s: string): UnitRead | null {
  const tokens = s.split(" ");
  for (let n = Math.min(MAX_UNIT_ALIAS_WORDS, tokens.length); n >= 1; n--) {
    const candidate = tokens
      .slice(0, n)
      .join(" ")
      .replace(/[.,]+$/, "");
    const raw = n === 1 ? candidate : candidate.toLowerCase();
    // "inch" is how recipes size a piece of ginger: "1-inch piece".
    if (n === 1 && /^inch(?:es)?$/i.test(raw)) {
      const after = tokens.slice(1);
      if (/^(?:piece|pieces|knob|chunk|stick)$/i.test(after[0] ?? "")) after.shift();
      if (after[0]?.toLowerCase() === "of") after.shift();
      return { unit: "piece", rest: after.join(" ") };
    }
    const code = normalizeUnit(raw);
    if (code) {
      let after = tokens.slice(n);
      if (after[0]?.toLowerCase() === "of") after = after.slice(1);
      return { unit: code, rest: after.join(" ") };
    }
  }
  return null;
}

const SIZE_WORDS: ReadonlySet<UnitCode> = new Set<UnitCode>(["small", "medium", "large"]);

// ---------------------------------------------------------------------------
// Qualifiers and preparation
// ---------------------------------------------------------------------------

function isModifierWord(w: string): boolean {
  return DROP_WORDS.has(w) || PREP_WORDS.has(w) || PREP_ADVERBS.has(w);
}

/** "boneless, skinless chicken" and "peeled, chopped tomatoes": a comma between modifiers is not a split. */
function mergeModifierCommas(s: string): string {
  let out = s;
  for (let i = 0; i < 4; i++) {
    const comma = out.indexOf(",");
    if (comma < 0) break;
    const head = out.slice(0, comma).trim().toLowerCase();
    const words = head.split(" ").filter(Boolean);
    if (words.length === 0 || !words.every(isModifierWord)) break;
    out = `${out.slice(0, comma)} ${out.slice(comma + 1)}`;
  }
  return out.replace(/\s+/g, " ");
}

interface Notes {
  prep: string[];
  optional: boolean;
}

function classifyParen(content: string, notes: Notes): void {
  const c = content.trim();
  if (!c) return;
  if (/optional/i.test(c)) {
    notes.optional = true;
    return;
  }
  if (LENGTH_RE.test(c)) return;
  if (/^see\b/i.test(c)) return;
  // An alternate measure: "(about 2 cups)", "(250 g)", "(1 stick)".
  if (sizeFrom(c) || /^\d/.test(c)) return;
  notes.prep.push(c.toLowerCase());
}

function stripSuffixQualifiers(s: string, notes: Notes): string {
  let work = s.trim();
  for (let guard = 0; guard < 6; guard++) {
    let changed = false;
    for (const q of QUALIFIER_SUFFIXES) {
      const m = work.match(q.re);
      if (m && m.index !== undefined && m.index + m[0].length === work.length) {
        if (q.optional) notes.optional = true;
        const note = typeof q.note === "function" ? q.note(m[0]) : q.note;
        if (note) notes.prep.unshift(note);
        work = work.slice(0, m.index).replace(/[,\s]+$/, "");
        changed = true;
        break;
      }
    }
    if (!changed) break;
  }
  return work;
}

function popTrailingPrep(head: string): { head: string; prep: string[] } {
  const words = head.split(" ");
  const popped: string[] = [];
  while (words.length > 1) {
    const last = (words[words.length - 1] ?? "").toLowerCase().replace(/[.,]+$/, "");
    if (!TRAILING_PREP.has(last)) break;
    popped.unshift(last);
    words.pop();
    // Adverbs and connectors that belong with the verb: "finely chopped", "seeded and chopped".
    while (words.length > 1) {
      const prev = (words[words.length - 1] ?? "").toLowerCase();
      if (PREP_ADVERBS.has(prev) || prev === "and" || prev === "&") {
        popped.unshift(prev);
        words.pop();
      } else break;
    }
  }
  const phrase = popped
    .join(" ")
    .replace(/\b(?:and|&)\b\s*$/, "")
    .trim();
  return { head: words.join(" "), prep: phrase ? [phrase] : [] };
}

// ---------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------

const JUICE_RE =
  /^(?:(?:the|grated|finely grated|fresh|freshly squeezed)\s+)*(juice|zest|rind|peel)(?:\s+(?:and|&)\s+(juice|zest|rind|peel))?\s+(?:of|from)\s+(.+)$/i;

export function parseGrammar(rawText: string): GrammarParse {
  const text = normalizeLine(rawText);
  const out: GrammarParse = {
    rawText,
    text,
    qty: null,
    qtyMax: null,
    unit: null,
    unitWritten: false,
    noun: "",
    prep: [],
    optional: false,
    packageSize: false,
    container: null,
    distribute: false,
    strayQuantity: false,
    header: false,
  };
  if (!text) return out;
  if (/:$/.test(text) || /^for the\b/i.test(text)) {
    out.header = true;
    return out;
  }

  let rest = text.replace(/(?<=[a-z\d)])\.$/i, "").trim();
  const notes: Notes = { prep: [], optional: false };

  // "Optional: 1/4 cup walnuts", "Garnish: fresh parsley".
  const label = rest.match(
    /^(optional|garnish|for garnish|to serve|for serving|topping|toppings)\s*:\s*(.+)$/i,
  );
  if (label?.[1] && label[2]) {
    if (/^optional$/i.test(label[1])) notes.optional = true;
    else notes.prep.push(label[1].toLowerCase());
    rest = label[2].trim();
  }

  const juice = rest.match(JUICE_RE);
  if (juice?.[1] && juice[3]) {
    notes.prep.push(
      juice[2] ? `${juice[1].toLowerCase()} and ${juice[2].toLowerCase()}` : juice[1].toLowerCase(),
    );
    rest = juice[3].trim();
  }

  // "About 1 cup", "approximately 2 cups": a hedge, not part of the name.
  rest = rest.replace(
    /^(?:about|approximately|approx\.?|roughly|around|~)\s*(?=[\d¼½¾.]|an?\b|one\b)/i,
    "",
  );

  let q = readQuantity(rest);
  // "pinch of salt", "handful of basil": a measure word with the amount implied.
  if (!q) {
    const lead = rest.match(/^(pinch(?:es)?|dash(?:es)?|handfuls?)\b\s*(.*)$/i);
    if (lead?.[1] && lead[2] !== undefined) {
      q = { qty: 1, qtyMax: null, rest: `${lead[1]} ${lead[2]}`, fromWord: false };
    }
  }
  let size: Size | null = null;
  if (q) {
    out.qty = q.qty;
    out.qtyMax = q.qtyMax;
    rest = q.rest.trimStart().replace(/^-\s*/, "");
    if (q.fromWord) rest = rest.replace(/^(?:an?|of)\s+/i, "");
    // "2 x 400g tins", "1/2 of a small onion", "2 heaping tablespoons".
    rest = rest.replace(/^[x×]\s*(?=\d)/i, "").replace(/^of\s+(?:an?\s+|the\s+)?/i, "");
    const measure = rest.match(/^(heaping|heaped|scant|level|rounded|generous|full)\s+/i);
    if (measure?.[1]) {
      notes.prep.push(measure[1].toLowerCase());
      rest = rest.slice(measure[0].length);
    }
    // "3 whole cloves garlic": "whole" before a unit just emphasizes it.
    const whole = rest.match(/^whole\s+/i);
    const afterWhole = whole ? readUnit(rest.slice(whole[0].length)) : null;
    if (whole && afterWhole && afterWhole.rest.trim() !== "") rest = rest.slice(whole[0].length);
    // "225g/8oz": keep the first measure, drop the alternate.
    rest = rest.replace(/^([a-z]+\.?)\/(?=\d)/i, "$1 /");

    // Package size: "(14 oz)" or "14-ounce", then an optional container word.
    const paren = rest.match(/^\(([^()]*)\)\s*/);
    if (paren?.[1] !== undefined) {
      size = sizeFrom(paren[1]);
      if (size || LENGTH_RE.test(paren[1].trim())) {
        rest = rest.slice(paren[0].length);
        if (size) {
          const skipped = skipContainer(rest);
          rest = skipped.rest;
          out.container = skipped.container;
        }
      }
    } else {
      const inline = rest.match(INLINE_SIZE_RE);
      if (inline?.[1] && inline[2]) {
        const candidate = sizeFrom(`${inline[1]} ${inline[2]}`);
        if (candidate) {
          size = candidate;
          const skipped = skipContainer(rest.slice(inline[0].length).trimStart());
          rest = skipped.rest;
          out.container = skipped.container;
        }
      }
    }
  }

  if (q && !size) {
    const u = readUnit(rest);
    if (u) {
      let { unit } = u;
      let after = u.rest;
      // "1 large head garlic": the size word modifies the real unit.
      if (SIZE_WORDS.has(unit)) {
        const next = readUnit(after);
        if (
          next &&
          unitDimension(next.unit) === "count" &&
          !SIZE_WORDS.has(next.unit) &&
          next.unit !== "each"
        ) {
          unit = next.unit;
          after = next.rest;
        }
      }
      out.unit = unit;
      out.unitWritten = true;
      rest = after;
      if (CONTAINER_UNITS.has(unit)) {
        out.container = unit;
        // "1 can (15 oz) beans": the size in parentheses is the amount.
        const sized = rest.match(/^\(([^()]*)\)\s*/);
        const parenSize = sized?.[1] !== undefined ? sizeFrom(sized[1]) : null;
        if (sized && parenSize) {
          size = parenSize;
          rest = rest.slice(sized[0].length);
        }
      } else if (unitDimension(unit) !== "count") {
        // "14 oz can tomatoes", "16 ounce package pasta": the container word follows the size.
        const skipped = skipContainer(rest);
        if (skipped.container) {
          rest = skipped.rest;
          out.container = skipped.container;
        }
        // "225g/8oz butter": drop the alternate measure.
        rest = rest.replace(/^\/\s*\d+(?:\.\d+)?\s*[a-z]+\.?\s*/i, "");
        // "1 tablespoon plus 1 teaspoon", "1 Tbsp. + 1 tsp.": add the two amounts.
        const more = rest.match(
          new RegExp(`^(?:\\+|plus|and)\\s+(${ONE})\\s*([a-zA-Z]+)\\.?\\s*(.*)$`, "i"),
        );
        const second = more?.[1] && more[2] ? normalizeUnit(more[2]) : null;
        if (
          more?.[1] &&
          second &&
          unitDimension(second) === unitDimension(unit) &&
          second !== unit
        ) {
          const biggerFirst = (convert(1, unit, second) ?? 0) > 1;
          const target = biggerFirst ? second : unit;
          const a = convert(q.qty, unit, target);
          if (a != null) {
            out.unit = target;
            q.qty = round(a + evalQty(more[1]));
            rest = more[3] ?? "";
          }
        }
      }
      // "1 teaspoon each salt and pepper"
      const each = rest.match(/^each\s+/i);
      if (each) {
        out.distribute = true;
        rest = rest.slice(each[0].length);
      }
    } else {
      out.unit = "each";
    }
  }

  if (q && !size) out.qty = q.qty;
  if (q && size) {
    out.packageSize = true;
    out.qty = round(q.qty * size.qty);
    const hi = size.qtyMax != null ? size.qtyMax : size.qty;
    out.qtyMax =
      size.qtyMax != null
        ? round(q.qty * hi)
        : q.qtyMax != null
          ? round(q.qtyMax * size.qty)
          : null;
    out.unit = size.unit;
    out.unitWritten = true;
  }

  // Parentheticals and brackets.
  rest = rest.replace(/[([]([^()[\]]*)[)\]]/g, (_m, content: string) => {
    classifyParen(content, notes);
    return " ";
  });
  rest = rest
    .replace(/[;]/g, ",")
    .replace(/\s+/g, " ")
    .replace(/\s+,/g, ",")
    .replace(/^[-,:\s]+/, "")
    .trim();

  rest = stripSuffixQualifiers(rest, notes);
  rest = mergeModifierCommas(rest);

  // Split off the comma tail: ", finely chopped", ", divided", ", or margarine".
  const commaParts = rest
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
  let head = commaParts.shift() ?? "";
  for (const part of commaParts) {
    let frag = part;
    const probe: Notes = { prep: [], optional: false };
    frag = stripSuffixQualifiers(frag, probe);
    if (probe.optional) notes.optional = true;
    notes.prep.push(...probe.prep);
    frag = frag.replace(/^(?:and|then)\s+/i, "").trim();
    if (!frag) continue;
    if (/^or\s+/i.test(frag)) {
      head = `${head} ${frag}`;
      continue;
    }
    if (/^optional$/i.test(frag)) {
      notes.optional = true;
      continue;
    }
    notes.prep.push(frag.toLowerCase());
  }

  head = stripSuffixQualifiers(head, notes);
  const popped = popTrailingPrep(head);
  head = popped.head;
  notes.prep.push(...popped.prep);

  out.noun = cleanPhrase(head);
  out.prep = notes.prep.map((p) => p.trim()).filter(Boolean);
  out.optional = notes.optional;
  out.strayQuantity =
    /\b\d+(?:\.\d+)?\s*(?:cups?|tbsp|tsp|oz|ounces?|g|grams?|lbs?|pounds?|ml|cloves?|tablespoons?|teaspoons?)\b/i.test(
      out.noun,
    );
  return out;
}
