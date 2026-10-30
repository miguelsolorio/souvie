// Scoring for the ingredient-line golden set (WS03). Used by parse.eval.ts.
// No Node APIs here, so the helpers could run anywhere; the file reading lives in parse.eval.ts.

import type { ParsedIngredient } from "@mp/core";

export interface GoldenItem {
  qty: number | null;
  qtyMax: number | null;
  unit: string | null;
  /** Canonical ontology name, or the proposed name when `unknown` is true. */
  ingredient: string | null;
  /** The ontology lacks this ingredient: the parser must return ingredientId null. */
  unknown?: boolean;
  prep: string | null;
  optional: boolean;
}

export interface GoldenLine {
  raw: string;
  items: GoldenItem[];
}

export interface LineScore {
  raw: string;
  qtyUnit: boolean;
  ingredient: boolean;
  /** Informational: the preparation note matched exactly (case and order insensitive). */
  prep: boolean;
  optional: boolean;
  confident: boolean;
  stages: ParsedIngredient["stage"][];
  expected: GoldenItem[];
  got: ParsedIngredient[];
}

const close = (a: number | null | undefined, b: number | null | undefined): boolean => {
  if (a == null || b == null) return (a ?? null) === (b ?? null);
  return Math.abs(a - b) < 1e-3;
};

const words = (s: string | null | undefined): string =>
  (s ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9/ -]+/g, " ")
    .split(/\s+/)
    .filter((w) => w && w !== "and")
    .sort()
    .join(" ");

export function scoreLine(
  line: GoldenLine,
  got: readonly ParsedIngredient[],
  idOf: (name: string) => string,
  threshold = 0.8,
): LineScore {
  const sameCount = got.length === line.items.length;
  const pairs = line.items.map((e, i) => [e, got[i]] as const);
  const each = (fn: (e: GoldenItem, g: ParsedIngredient) => boolean): boolean =>
    sameCount && pairs.every(([e, g]) => g !== undefined && fn(e, g));
  return {
    raw: line.raw,
    qtyUnit: each(
      (e, g) =>
        close(e.qty, g.qty) && close(e.qtyMax, g.qtyMax) && (e.unit ?? null) === (g.unit ?? null),
    ),
    ingredient: each((e, g) => {
      if (e.ingredient === null) return g.ingredientId === null;
      if (e.unknown) return g.ingredientId === null && g.ingredientName === e.ingredient;
      return g.ingredientId === idOf(e.ingredient);
    }),
    prep: each((e, g) => words(e.prep) === words(g.prepNote)),
    optional: each((e, g) => e.optional === g.optional),
    confident: got.length > 0 && got.every((g) => g.confidence >= threshold),
    stages: got.map((g) => g.stage),
    expected: line.items,
    got: [...got],
  };
}

export interface Report {
  lines: number;
  qtyUnit: number;
  ingredient: number;
  prep: number;
  optional: number;
  /** Share of lines whose every item has confidence at or above the threshold. */
  confident: number;
  /** Share of lines resolved by the grammar stage alone at or above the threshold. */
  grammarConfident: number;
  stageCounts: Record<ParsedIngredient["stage"], number>;
  belowThreshold: number;
  /** Lines that are wrong on qty, unit, or ingredient yet reach 0.8 confidence: they skip the model. */
  confidentWrong: number;
}

export function summarize(scores: readonly LineScore[], threshold = 0.8): Report {
  const n = scores.length;
  const share = (pick: (s: LineScore) => boolean): number => scores.filter(pick).length / n;
  const stageCounts: Report["stageCounts"] = { grammar: 0, lookup: 0, llm: 0 };
  for (const s of scores) for (const g of s.got) stageCounts[g.stage]++;
  return {
    lines: n,
    qtyUnit: share((s) => s.qtyUnit),
    ingredient: share((s) => s.ingredient),
    prep: share((s) => s.prep),
    optional: share((s) => s.optional),
    confident: share((s) => s.confident),
    grammarConfident: share(
      (s) => s.confident && s.stages.length > 0 && s.stages.every((st) => st === "grammar"),
    ),
    stageCounts,
    belowThreshold: scores.filter((s) => s.got.some((g) => g.confidence < threshold)).length,
    confidentWrong: scores.filter((s) => s.confident && (!s.qtyUnit || !s.ingredient)).length,
  };
}

const pct = (x: number): string => `${(x * 100).toFixed(1)}%`;

export function formatReport(title: string, r: Report): string {
  return [
    `${title}`,
    `  lines                       ${r.lines}`,
    `  qty + unit exact            ${pct(r.qtyUnit)}   (threshold 95%)`,
    `  ingredientId right          ${pct(r.ingredient)}   (threshold 90%)`,
    `  confidence >= 0.8           ${pct(r.confident)}   (threshold 80%, grammar + lookup, no model)`,
    `    of which stage=grammar    ${pct(r.grammarConfident)}`,
    `  prep note exact (info)      ${pct(r.prep)}`,
    `  optional flag (info)        ${pct(r.optional)}`,
    `  stage counts (items)        grammar ${r.stageCounts.grammar}, lookup ${r.stageCounts.lookup}, llm ${r.stageCounts.llm}`,
    `  lines below 0.8 (to model)  ${r.belowThreshold}`,
    `  wrong yet confident         ${r.confidentWrong}   (errors the model would never see)`,
  ].join("\n");
}

export function describeFailure(s: LineScore): string {
  const exp = s.expected
    .map(
      (e) =>
        `${e.qty ?? "-"}${e.qtyMax ? `-${e.qtyMax}` : ""} ${e.unit ?? "-"} | ${e.unknown ? "?" : ""}${e.ingredient ?? "-"}`,
    )
    .join(" ;; ");
  const got = s.got
    .map(
      (g) =>
        `${g.qty ?? "-"}${g.qtyMax ? `-${g.qtyMax}` : ""} ${g.unit ?? "-"} | ${g.ingredientName ?? "-"}${g.ingredientId ? "" : " (no id)"} conf ${g.confidence} ${g.stage}`,
    )
    .join(" ;; ");
  return `  ${s.raw}\n      want: ${exp}\n      got:  ${got}`;
}
