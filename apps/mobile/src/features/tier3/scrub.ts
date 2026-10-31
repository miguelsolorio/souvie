// Personal data out of a snapshot before it becomes a fixture (WS08 dev snapshot tool). WS10 commits
// fixtures captured on real retailer pages, signed in as a real person, so emails, names,
// addresses, phone numbers, card fragments, order numbers, form values and URL query strings are
// found, listed for review, and replaced with obvious stand-ins. The person reviewing can keep any
// replacement off; nothing is saved until they choose to share.
import type { SnapshotNode, SnapshotTree } from "@mp/retailers";

export type ScrubKind =
  | "email"
  | "phone"
  | "card"
  | "order"
  | "address"
  | "name"
  | "form_value"
  | "url_query";

export interface Replacement {
  /** Stable within one scan, for the review list. */
  index: number;
  nodeId: string;
  field: "name" | "text" | "value" | "href" | "title" | "url";
  kinds: ScrubKind[];
  original: string;
  replacement: string;
}

interface Rule {
  kind: ScrubKind;
  pattern: RegExp;
  replace: string | ((match: string, ...groups: string[]) => string);
}

const STREET =
  "(?:St|Street|Ave|Avenue|Rd|Road|Blvd|Boulevard|Ln|Lane|Dr|Drive|Way|Ct|Court|Pl|Place|Pkwy|Parkway|Hwy|Highway|Ter|Terrace|Cir|Circle)";

// Order matters: card and order numbers before phone numbers, which would match their digits.
const RULES: Rule[] = [
  {
    kind: "email",
    pattern: /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi,
    replace: "shopper@example.test",
  },
  {
    kind: "card",
    pattern:
      /\b(?:visa|mastercard|master card|amex|american express|discover|debit|credit)\b[^0-9\n]{0,16}\d{4}\b|(?:ending in|ends in|card ending|[x*•]{2,}[\s-]?)\s*\d{4}\b/gi,
    replace: "card ending 0000",
  },
  {
    kind: "order",
    // The number must hold a digit, so "Order history" is left alone.
    pattern:
      /\b(?:order|confirmation|receipt)\s*(?:#|no\.?|number)?\s*:?\s*#?\s*(?=[A-Z0-9-]*\d)[A-Z0-9][A-Z0-9-]{4,}\b/gi,
    replace: "Order #00000000",
  },
  {
    kind: "address",
    pattern: new RegExp(`\\b\\d{1,6}\\s+(?:[A-Z0-9][A-Za-z0-9.'-]*\\s+){1,4}${STREET}\\b\\.?`, "g"),
    replace: "100 Example St",
  },
  {
    kind: "phone",
    pattern: /(?:\+?1[\s.-]?)?(?:\(\d{3}\)|\b\d{3})[\s.-]?\d{3}[\s.-]?\d{4}\b/g,
    replace: "555-0100",
  },
  {
    kind: "name",
    pattern:
      /\b(Hi|Hello|Welcome(?: back)?|Signed in as|Account for|Thanks|Thank you)(,?\s+)([A-Z][a-z'-]+(?:\s+[A-Z][a-z'-]+)?)/g,
    replace: (_m: string, greeting: string, gap: string) => `${greeting}${gap}Test Shopper`,
  },
];

const PERSONAL_FIELD =
  /name|address|street|city|zip|postal|phone|mobile|email|card|cvv|birth|code|pass|pwd/i;

function scrubText(s: string): { text: string; kinds: ScrubKind[] } {
  let text = s;
  const kinds: ScrubKind[] = [];
  for (const rule of RULES) {
    rule.pattern.lastIndex = 0;
    if (rule.pattern.test(text)) {
      rule.pattern.lastIndex = 0;
      text = text.replace(rule.pattern, rule.replace as never);
      kinds.push(rule.kind);
    }
  }
  return { text, kinds };
}

function scrubUrl(url: string): { text: string; kinds: ScrubKind[] } {
  try {
    const u = new URL(url);
    if (!u.search && !u.hash) return { text: url, kinds: [] };
    u.search = "";
    u.hash = "";
    return { text: u.toString(), kinds: ["url_query"] };
  } catch {
    return { text: url, kinds: [] };
  }
}

function walkNodes(node: SnapshotNode, visit: (n: SnapshotNode) => void) {
  visit(node);
  for (const child of node.children ?? []) walkNodes(child, visit);
}

/** Everything that looks personal, as a reviewable list. */
export function findPersonalData(tree: SnapshotTree): Replacement[] {
  const out: Replacement[] = [];
  const push = (r: Omit<Replacement, "index">) => out.push({ ...r, index: out.length });

  const title = scrubText(tree.title);
  if (title.kinds.length) {
    push({
      nodeId: "",
      field: "title",
      kinds: title.kinds,
      original: tree.title,
      replacement: title.text,
    });
  }
  const url = scrubUrl(tree.url);
  if (url.kinds.length) {
    push({ nodeId: "", field: "url", kinds: url.kinds, original: tree.url, replacement: url.text });
  }

  walkNodes(tree.root, (n) => {
    for (const field of ["name", "text"] as const) {
      const value = n[field];
      if (!value) continue;
      const s = scrubText(value);
      if (s.kinds.length) {
        push({ nodeId: n.id, field, kinds: s.kinds, original: value, replacement: s.text });
      }
    }
    if (n.value) {
      const isForm = n.role === "textbox" || n.role === "searchbox" || n.role === "combobox";
      if (isForm && PERSONAL_FIELD.test(n.name)) {
        push({
          nodeId: n.id,
          field: "value",
          kinds: ["form_value"],
          original: n.value,
          replacement: "",
        });
      } else {
        const s = scrubText(n.value);
        if (s.kinds.length) {
          push({
            nodeId: n.id,
            field: "value",
            kinds: s.kinds,
            original: n.value,
            replacement: s.text,
          });
        }
      }
    }
    if (n.href) {
      const s = scrubUrl(n.href);
      if (s.kinds.length) {
        push({
          nodeId: n.id,
          field: "href",
          kinds: s.kinds,
          original: n.href,
          replacement: s.text,
        });
      }
    }
  });
  return out;
}

/** A copy of the tree with the accepted replacements applied. The input is not changed. */
export function applyReplacements(
  tree: SnapshotTree,
  replacements: readonly Replacement[],
  accepted: ReadonlySet<number>,
): SnapshotTree {
  const copy = JSON.parse(JSON.stringify(tree)) as SnapshotTree;
  const byNode = new Map<string, Replacement[]>();
  for (const r of replacements) {
    if (!accepted.has(r.index)) continue;
    if (r.field === "title") copy.title = r.replacement;
    else if (r.field === "url") copy.url = r.replacement;
    else byNode.set(r.nodeId, [...(byNode.get(r.nodeId) ?? []), r]);
  }
  walkNodes(copy.root, (n) => {
    for (const r of byNode.get(n.id) ?? []) {
      if (r.field === "name") n.name = r.replacement;
      else if (r.field === "text") n.text = r.replacement;
      else if (r.field === "value") n.value = r.replacement;
      else if (r.field === "href") n.href = r.replacement;
    }
  });
  return copy;
}

/** "www.example.test-20261031-1800.snapshot.json" */
export function snapshotFileName(tree: SnapshotTree): string {
  let host = "page";
  try {
    host = new URL(tree.url).host.replace(/[^A-Za-z0-9.-]/g, "-") || "page";
  } catch {
    // keep "page"
  }
  const stamp = tree.capturedAt.replace(/[-:]/g, "").replace("T", "-").slice(0, 13);
  return `${host}-${stamp}.snapshot.json`;
}
