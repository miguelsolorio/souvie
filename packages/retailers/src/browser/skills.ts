// Shared page skills (WS08): pure functions over a SnapshotTree that every browser adapter needs.
// No retailer knowledge lives here; site recipes (WS10) combine these with their own selectors.
//
// Matching rules, used by every function that takes a `match`:
//   string   compared after normalizeText and lower-casing; findByRole wants the whole name to
//            match, findByText wants it contained
//   RegExp   tested against the normalized name or text as is
import { type SnapshotNode, type SnapshotTree, type VisitedNode, walk } from "./snapshot.ts";

export type TextMatch = string | RegExp;

// Character classes built from code points so the source holds no invisible characters.
const cp = (...codes: number[]) => String.fromCodePoint(...codes);
const range = (from: number, to: number) =>
  cp(...Array.from({ length: to - from + 1 }, (_, i) => from + i));
const ZERO_WIDTH = new RegExp(`[${cp(0x200b, 0x200c, 0x200d, 0x2060, 0xfeff, 0xad)}]`, "g");
const SPACES = new RegExp(
  `[\\s${cp(0xa0, 0x1680)}${range(0x2000, 0x200a)}${cp(0x2028, 0x2029, 0x202f, 0x205f, 0x3000)}]+`,
  "g",
);
const SINGLE_QUOTES = new RegExp(`[${cp(0x2018, 0x2019, 0x201b, 0x2032)}]`, "g");
const DOUBLE_QUOTES = new RegExp(`[${cp(0x201c, 0x201d, 0x201f, 0x2033)}]`, "g");
const MINUS_SIGN = cp(0x2212);

/**
 * Visible text as a person reads it: Unicode-normalized (NFKC, so "ﬁ" is "fi" and full-width digits
 * are digits), zero-width characters and soft hyphens removed, curly quotes straightened, every
 * run of whitespace (no-break spaces included) one space, trimmed. Case is kept.
 */
export function normalizeText(s: string | null | undefined): string {
  if (!s) return "";
  return s
    .normalize("NFKC")
    .replace(ZERO_WIDTH, "")
    .replace(SINGLE_QUOTES, "'")
    .replace(DOUBLE_QUOTES, '"')
    .replaceAll(MINUS_SIGN, "-")
    .replace(SPACES, " ")
    .trim();
}

function fold(s: string): string {
  return normalizeText(s).toLowerCase();
}

function matches(value: string | undefined, match: TextMatch, whole: boolean): boolean {
  if (value === undefined || value === "") return false;
  if (match instanceof RegExp) {
    match.lastIndex = 0;
    return match.test(normalizeText(value));
  }
  const want = fold(match);
  if (want === "") return false;
  const have = fold(value);
  return whole ? have === want : have.includes(want);
}

/** Nodes with this role, in document order, optionally narrowed by name (whole-name match). */
export function findByRole(
  tree: SnapshotTree,
  role: string,
  nameMatch?: TextMatch,
): SnapshotNode[] {
  return walk(tree)
    .map((v) => v.node)
    .filter(
      (n) => n.role === role && (nameMatch === undefined || matches(n.name, nameMatch, true)),
    );
}

/** Nodes whose name, text or value contains the match, in document order. */
export function findByText(tree: SnapshotTree, match: TextMatch): SnapshotNode[] {
  return walk(tree)
    .map((v) => v.node)
    .filter((n) => matches(n.name, match, false) || matches(n.text, match, false));
}

interface Indexed {
  byId: Map<string, VisitedNode>;
  children: Map<string, SnapshotNode[]>;
}

function index(tree: SnapshotTree): Indexed {
  const byId = new Map<string, VisitedNode>();
  const children = new Map<string, SnapshotNode[]>();
  for (const v of walk(tree)) {
    byId.set(v.node.id, v);
    children.set(v.node.id, v.node.children ?? []);
  }
  return { byId, children };
}

function subtree(node: SnapshotNode): SnapshotNode[] {
  return walk(node).map((v) => v.node);
}

function centre(n: SnapshotNode): [number, number] {
  const [x, y, w, h] = n.bbox;
  return [x + w / 2, y + h / 2];
}

function distance(a: SnapshotNode, b: SnapshotNode): number {
  const [ax, ay] = centre(a);
  const [bx, by] = centre(b);
  return Math.hypot(ax - bx, ay - by);
}

const BUTTON_ROLES = new Set(["button"]);

/**
 * The button closest to a node in the tree: first inside the node itself, then inside each
 * ancestor in turn, so for a product title it is the Add button in the same tile, never the
 * neighbour's. Among buttons at the same level the one nearest in document order wins, then the
 * nearest on screen. `nameMatch` narrows by name (whole-name match for strings).
 */
export function nearestButton(
  tree: SnapshotTree,
  nodeId: string,
  nameMatch?: TextMatch,
): SnapshotNode | null {
  const { byId } = index(tree);
  const start = byId.get(nodeId);
  if (!start) return null;
  const isCandidate = (n: SnapshotNode) =>
    BUTTON_ROLES.has(n.role) &&
    n.id !== nodeId &&
    (nameMatch === undefined || matches(n.name, nameMatch, true));

  if (
    BUTTON_ROLES.has(start.node.role) &&
    (nameMatch === undefined || matches(start.node.name, nameMatch, true))
  ) {
    return start.node;
  }
  let level: VisitedNode | undefined = start;
  while (level) {
    const found = subtree(level.node).filter(isCandidate);
    if (found.length > 0) {
      const order = (n: SnapshotNode) => Math.abs((byId.get(n.id)?.order ?? 0) - start.order);
      found.sort(
        (a, b) => order(a) - order(b) || distance(a, start.node) - distance(b, start.node),
      );
      return found[0] ?? null;
    }
    level = level.parent ? byId.get(level.parent.id) : undefined;
  }
  return null;
}

// ---------------------------------------------------------------------------------------
// Prices
// ---------------------------------------------------------------------------------------

export interface ParsedPrice {
  /** USD for one unit (or per `unit` when that is set). */
  amount: number;
  /** Set for unit prices ("$0.31/oz" -> "oz", "$3.99/lb" -> "lb"). */
  unit?: string;
  /** Multi-buy offers ("2 for $5.00"): `amount` is the per-item price, this is the offer. */
  multi?: { count: number; total: number };
}

const UNIT_WORDS =
  "oz|fl ?oz|lb|lbs|ea|each|ct|count|g|kg|ml|l|liter|litre|gal|gallon|qt|quart|pt|pint|dozen|doz|sq ?ft|ft|in|item|unit|pk|pack|roll|sheet|load|serving";

// A money amount: $4.99, $1,299.00, 4.99 with a $ sign, or 99¢ / 99 cents.
const MONEY = String.raw`(?:\$\s?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?|(\d{1,3})\s?(?:¢|cents?\b))`;
const UNIT_SUFFIX = String.raw`\s?(?:\/|per\s)\s?(${UNIT_WORDS})\b`;

const OLD_PRICE =
  /\b(?:was|reg(?:ular(?:ly)?)?|orig(?:inal(?:ly)?)?|list|compare(?: at)?|msrp|before)\b\.?:?\s*$/i;
const SAVING = /\b(?:save|you save|savings|off)\b:?\s*$/i;
const CURRENT_PRICE = /\b(?:now|sale|only|today|price|your price|member price)\b:?\s*$/i;

function moneyValue(m: RegExpExecArray, offset = 1): number {
  const dollars = m[offset];
  const cents = m[offset + 1];
  const centsOnly = m[offset + 2];
  if (centsOnly !== undefined) return Number(centsOnly) / 100;
  const whole = Number((dollars ?? "0").replace(/,/g, ""));
  const fraction = cents === undefined ? 0 : Number(cents.padEnd(2, "0")) / 100;
  return Math.round((whole + fraction) * 100) / 100;
}

interface PriceHit {
  amount: number;
  unit?: string;
  index: number;
  before: string;
  after: string;
}

/**
 * Reads a shelf price from visible text. Handles "$4.99", "2 for $5.00" (and "2/$5"), unit
 * prices "$0.31/oz", cents "99¢", and sale text "Was $6.49 Now $4.99" (the current price wins:
 * an amount after "now"/"sale", else one not marked "was"/"reg"/"save"). When the text has both
 * a shelf price and a unit price ("$4.99 ($0.12/oz)") the shelf price is returned. Null when
 * there is no price.
 */
export function parsePrice(text: string | null | undefined): ParsedPrice | null {
  const s = normalizeText(text);
  if (!s) return null;

  // Multi-buy first: "2 for $5.00", "2/$5", "3 for 10".
  const multi = new RegExp(String.raw`\b(\d{1,2})\s?(?:for|\/)\s?${MONEY}`, "i").exec(s);
  if (multi) {
    const count = Number(multi[1]);
    const total = moneyValue(multi, 2);
    if (count >= 2 && total > 0) {
      return { amount: Math.round((total / count) * 100) / 100, multi: { count, total } };
    }
  }

  const hits: PriceHit[] = [];
  const re = new RegExp(`${MONEY}(?:${UNIT_SUFFIX})?`, "gi");
  for (let m = re.exec(s); m !== null; m = re.exec(s)) {
    const amount = moneyValue(m);
    const unitRaw = m[4];
    hits.push({
      amount,
      ...(unitRaw ? { unit: unitRaw.toLowerCase().replace(/\s/g, "") } : {}),
      index: m.index,
      before: s.slice(Math.max(0, m.index - 24), m.index),
      after: s.slice(m.index + m[0].length, m.index + m[0].length + 8),
    });
  }
  if (hits.length === 0) return null;

  const shelf = hits.filter((h) => h.unit === undefined);
  const pool = shelf.length > 0 ? shelf : hits;
  const current = pool.find((h) => CURRENT_PRICE.test(h.before));
  const pick =
    current ??
    pool.find(
      (h) => !OLD_PRICE.test(h.before) && !SAVING.test(h.before) && !/^\s?off\b/i.test(h.after),
    ) ??
    pool[pool.length - 1];
  if (!pick) return null;
  return pick.unit ? { amount: pick.amount, unit: pick.unit } : { amount: pick.amount };
}

// ---------------------------------------------------------------------------------------
// Quantity steppers
// ---------------------------------------------------------------------------------------

export interface Stepper {
  minus: SnapshotNode;
  plus: SnapshotNode;
  /** The node that shows the count: a spinbutton or textbox, else the number between the buttons. */
  count: SnapshotNode;
  /** The count as a number, when it reads as one. */
  quantity: number | null;
}

// normalizeText already turned the minus sign into "-". En and em dashes count too.
const MINUS_SYMBOL = new RegExp(`^[-${cp(0x2013, 0x2014)}]$`);
const MINUS_WORDS =
  /^(?:minus|decrease|decrement|subtract|remove one|less|fewer|reduce)\b|\b(?:decrease|decrement|reduce) (?:quantity|qty|amount)\b/i;
const PLUS_WORDS =
  /^(?:plus|increase|increment|add one|more)\b|\b(?:increase|increment) (?:quantity|qty|amount)\b/i;
const COUNT_ROLES = new Set(["spinbutton", "textbox", "text", "status", "generic"]);
/** A stepper search never climbs into these: past them it would find another item's stepper. */
const BOUNDARY_ROLES = new Set([
  "document",
  "main",
  "region",
  "list",
  "grid",
  "table",
  "dialog",
  "form",
  "search",
  "navigation",
  "banner",
  "contentinfo",
  "complementary",
]);

function labels(n: SnapshotNode): string[] {
  return [normalizeText(n.name), normalizeText(n.text)].filter((s) => s !== "");
}

function isMinus(n: SnapshotNode): boolean {
  return n.role === "button" && labels(n).some((s) => MINUS_SYMBOL.test(s) || MINUS_WORDS.test(s));
}

function isPlus(n: SnapshotNode): boolean {
  return n.role === "button" && labels(n).some((s) => s === "+" || PLUS_WORDS.test(s));
}

function readInt(n: SnapshotNode): number | null {
  const raw = normalizeText(n.value ?? (n.role === "text" ? n.name : (n.text ?? n.name)));
  const m = /^(?:qty:?\s*|quantity:?\s*)?(\d{1,3})(?:\s?(?:in cart|items?))?$/i.exec(raw);
  return m ? Number(m[1]) : null;
}

/**
 * The quantity stepper at or around a node: a minus button, a plus button, and the count between
 * them. Looks inside the node, then inside each ancestor up to (not into) the nearest landmark,
 * list or form, and takes the first level that has all three. So from a product tile or a cart
 * line it finds that item's stepper, never another item's. Null when there is none.
 */
export function findStepper(tree: SnapshotTree, nodeId: string): Stepper | null {
  const { byId } = index(tree);
  let level: VisitedNode | undefined = byId.get(nodeId);
  let first = true;
  while (level) {
    if (!first && BOUNDARY_ROLES.has(level.node.role)) return null;
    first = false;
    const nodes = subtree(level.node);
    const order = (n: SnapshotNode) => byId.get(n.id)?.order ?? 0;
    const minus = nodes.find(isMinus);
    const plus = nodes.find(isPlus);
    if (minus && plus) {
      const lo = Math.min(order(minus), order(plus));
      const hi = Math.max(order(minus), order(plus));
      const candidates = nodes.filter(
        (n) =>
          n.id !== minus.id && n.id !== plus.id && COUNT_ROLES.has(n.role) && readInt(n) !== null,
      );
      const count =
        candidates.find((n) => n.role === "spinbutton") ??
        candidates.find((n) => order(n) > lo && order(n) < hi) ??
        candidates[0];
      if (count) return { minus, plus, count, quantity: readInt(count) };
    }
    level = level.parent ? byId.get(level.parent.id) : undefined;
  }
  return null;
}
