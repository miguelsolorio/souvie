// One-time drafting script for the starter catalog (WS16).
//
//   pnpm --filter @mp/recipe-import draft-catalog -- --count 60 --max-usd 5
//   pnpm --filter @mp/recipe-import draft-catalog -- --count 2 --max-usd 0.25 --out "$TMPDIR/catalog-smoke"
//
// For each slot of the plan in supabase/seed/catalog/spec.ts it asks claude-sonnet-5-5 for an
// original dinner recipe (prompt catalog-draft.v1), checks the answer, parses every ingredient
// line with @mp/ingredient-parser (grammar, ontology lookup, Haiku fallback), decides the diet
// tags with the deterministic checks in spec.ts, and writes one JSON file per recipe.
//
// Rules the script keeps:
//   - Resumable. A slug whose file exists is skipped and costs nothing.
//   - `--count N` is the number of plan slugs that should have a file when the run ends. A
//     rejected draft moves on to the next slot of the plan.
//   - `--max-usd` is a hard stop: no model call starts once the spend reaches it.
//   - Refuses to run when `CI` is set. The key comes from ANTHROPIC_API_KEY in the environment.
//   - No web access. The model gets only the spec; nothing is fetched.
//   - No database. Cost goes to stdout, into each file's `draft` block, and into draft-log.json
//     (read by supabase/seed/catalog/load.ts for the review sheet).
//
// The checks that decide a recipe is acceptable are listed in `problemsFor` below.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  instructionsToJson,
  isUnitCode,
  NormalizedRecipe,
  RECIPE_LIMITS,
  RecipeInstructions,
} from "@mp/core";
import {
  createAnthropicParseClient,
  DEFAULT_CONFIDENCE_THRESHOLD,
  estimateCostUsd as haikuCostUsd,
  InMemoryOntology,
  InMemoryParseCache,
  type ParserDeps,
  parseLinesGrouped,
} from "@mp/ingredient-parser";
import {
  type AiRunRecord,
  CATALOG_DRAFT_V1,
  CatalogDraftOutput,
  type CostGuard,
  createAnthropicClient,
  extract,
  LlmError,
  type MessagesClient,
  MODELS,
} from "@mp/llm";
import {
  analyzeRecipe,
  buildTags,
  type CatalogIngredient,
  type CatalogRecipe,
  COVERAGE,
  freshLineCount,
  type LineInput,
  NON_MEAT_PROTEIN_TAGS,
  offendingLines,
  PANTRY_MAX_FRESH_LINES,
  PLAN,
  proteinPresent,
  recipeId,
  type Slot,
  shapeProblems,
  strayFlesh,
  textProblems,
} from "../../../supabase/seed/catalog/spec.ts";
import { readSeed } from "../../../supabase/seed/load.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const CATALOG_DIR = resolve(HERE, "../../../supabase/seed/catalog");
export const DEFAULT_OUT_DIR = join(CATALOG_DIR, "recipes");
export const DEFAULT_LOG_PATH = join(CATALOG_DIR, "draft-log.json");

/** Attempts per slot. Each attempt may spend one extra call inside `extract` on a failed check. */
const MAX_ATTEMPTS = 2;
/** Output ceiling per call. A recipe is about 1,500 tokens; the rest is room to think. */
const MAX_TOKENS = 12_000;

export interface DraftOptions {
  /** Plan slugs that should have a file when the run ends. */
  count: number;
  /** Hard stop: no call starts at or above this spend. */
  maxUsd: number;
  outDir: string;
  logPath: string;
  /** Slots drafted at once. */
  concurrency: number;
  /** Draft only these slugs (still skips the ones that exist). */
  only?: readonly string[];
}

export interface DraftDeps {
  client: MessagesClient;
  now?: () => Date;
  say?: (line: string) => void;
}

export interface Rejection {
  slug: string;
  attempt: number;
  problems: string[];
}

export interface RunRecord {
  at: string;
  model: string;
  promptVersion: string;
  requested: number;
  written: string[];
  skipped: string[];
  /** Every draft that failed a check, including ones a retry later fixed. */
  rejected: Rejection[];
  /** Slugs given up on after the last attempt. */
  abandoned: string[];
  costUsd: number;
  stoppedByCostCap: boolean;
}

export interface DraftLog {
  runs: RunRecord[];
}

const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;

/** Straight quotes and ASCII dashes, so the text checks see what a reader sees. */
export function tidy(text: string): string {
  return text
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/…/g, "...")
    .replace(/–/g, "-")
    .replace(/ /g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Checks on the model's answer that need no parsing. Returns a short list of problems; the first
 * check failure inside `extract` is retried once with this text.
 */
export function draftTextProblems(draft: CatalogDraftOutput, slot: Slot): string[] {
  const out: string[] = [];
  const title = tidy(draft.title);
  if (title.length < 3 || title.length > 80) out.push("title must be 3 to 80 characters");
  for (const p of textProblems(title)) out.push(`title ${p}`);
  const description = tidy(draft.description);
  if (description.length < 20 || description.length > 260) {
    out.push("description must be 20 to 260 characters");
  }
  for (const p of textProblems(description)) out.push(`description ${p}`);

  const prep = Math.round(draft.prep_minutes);
  const cook = Math.round(draft.cook_minutes);
  if (prep < 0 || cook < 0) out.push("minutes cannot be negative");
  if (prep + cook < 5) out.push("prep plus cook must be at least 5 minutes");
  if (prep + cook > slot.maxMinutes) {
    out.push(`prep plus cook is ${prep + cook} minutes but the maximum is ${slot.maxMinutes}`);
  }

  const lines = draft.ingredients;
  if (lines.length < COVERAGE.minIngredientLines || lines.length > COVERAGE.maxIngredientLines) {
    out.push(
      `use ${COVERAGE.minIngredientLines} to ${COVERAGE.maxIngredientLines} ingredient lines, not ${lines.length}`,
    );
  }
  lines.forEach((line, i) => {
    const text = tidy(line.text);
    const where = `ingredient line ${i + 1} ("${text}")`;
    if (text.length === 0 || text.length > RECIPE_LIMITS.ingredientText) {
      out.push(`${where} must be 1 to ${RECIPE_LIMITS.ingredientText} characters`);
    }
    if (!/^\d/.test(text)) out.push(`${where} must start with a quantity`);
    if (/\bor\b/i.test(text)) out.push(`${where} offers a choice with "or"; pick one`);
    if (/\b(?:salt|pepper)\s+and\s+(?:salt|pepper)\b/i.test(text)) {
      out.push(`${where} holds two ingredients; give each its own line`);
    }
    for (const p of textProblems(text)) out.push(`${where} ${p}`);
    if (line.group !== null) for (const p of textProblems(line.group)) out.push(`group ${p}`);
  });

  const steps = draft.steps;
  if (steps.length < COVERAGE.minSteps || steps.length > COVERAGE.maxSteps) {
    out.push(`use ${COVERAGE.minSteps} to ${COVERAGE.maxSteps} steps, not ${steps.length}`);
  }
  steps.forEach((step, i) => {
    const text = tidy(step);
    if (text.length === 0 || text.length > RECIPE_LIMITS.instructionText) {
      out.push(`step ${i + 1} must be 1 to ${RECIPE_LIMITS.instructionText} characters`);
    }
    if (/^(?:step\s*)?\d+[.)]/i.test(text)) out.push(`step ${i + 1} must not be numbered`);
    for (const p of textProblems(text)) out.push(`step ${i + 1} ${p}`);
  });
  return out;
}

interface Resources {
  ontology: InMemoryOntology;
  categoryOf: (name: string) => string | undefined;
  cache: InMemoryParseCache;
}

function loadResources(): Resources {
  const seed = readSeed();
  const categories = new Map(seed.ingredients.map((i) => [i.name, i.category]));
  return {
    ontology: new InMemoryOntology({
      ingredients: seed.ingredients.map((i) => ({
        ingredientId: i.id,
        name: i.name,
        category: i.category,
        plural: i.plural,
      })),
      aliases: seed.aliases,
    }),
    categoryOf: (name) => categories.get(name),
    cache: new InMemoryParseCache(),
  };
}

/** Why a parsed draft is not acceptable. Empty means it is. */
export function problemsFor(
  slot: Slot,
  draft: CatalogDraftOutput,
  ingredients: readonly CatalogIngredient[],
  tags: readonly string[],
  categoryOf: (name: string) => string | undefined,
  usedTitles: ReadonlySet<string>,
): string[] {
  const out: string[] = [];
  const inputs: readonly LineInput[] = ingredients;
  const facts = analyzeRecipe(inputs, categoryOf);

  const title = tidy(draft.title).toLowerCase();
  if ([...usedTitles].some((used) => used.toLowerCase() === title)) {
    out.push(`the title "${tidy(draft.title)}" is already used; choose another`);
  }

  if (!proteinPresent(slot.protein, ingredients, facts)) {
    out.push(
      `the main protein must be ${slot.protein.replace("_", " ")}, but the lines do not hold it`,
    );
  }
  const stray = strayFlesh(slot.protein, facts);
  if (stray.length > 0) {
    out.push(
      `it also contains ${stray.join(", ")}; use only ${slot.protein} as the meat or fish (no other meat, fish, or shellfish)`,
    );
  }
  const nonMeat = (NON_MEAT_PROTEIN_TAGS as readonly string[]).includes(slot.protein);
  const goals = new Set<"vegetarian" | "vegan" | "dairy_free" | "gluten_free">();
  if (nonMeat) goals.add("vegetarian");
  for (const d of slot.diets) goals.add(d);
  for (const goal of goals) {
    if (!facts.diets.includes(goal)) {
      const lines = offendingLines(goal, inputs, categoryOf);
      out.push(
        `it must be ${goal.replace("_", " ")}${lines.length > 0 ? `: ${lines.join("; ")}` : ""}`,
      );
    }
  }
  if (slot.allergenFree && !facts.allergenFree) {
    const lines = offendingLines("allergen_free", inputs, categoryOf);
    out.push(
      `it must contain none of peanuts, tree nuts, milk, eggs, wheat, soy, fish, shellfish, sesame${lines.length > 0 ? `: ${lines.join("; ")}` : ""}`,
    );
  }

  const unresolved = ingredients.filter((l) => l.ingredientId === null);
  const allowed = ingredients.length <= 10 ? 1 : 2;
  if (unresolved.length > allowed) {
    out.push(
      `these lines are not common grocery ingredients, so replace or rename them: ${unresolved
        .map((l) => `"${l.rawText}"`)
        .join("; ")}`,
    );
  }
  if (slot.audience.includes("pantry")) {
    const fresh = freshLineCount(inputs, categoryOf);
    if (fresh > PANTRY_MAX_FRESH_LINES) {
      out.push(
        `a pantry recipe may have at most ${PANTRY_MAX_FRESH_LINES} fresh ingredients (produce, meat, dairy, eggs, bread) besides onion, garlic, potatoes, carrots, and citrus; this one has ${fresh}`,
      );
    }
  }

  const normalized = NormalizedRecipe.safeParse({
    title: tidy(draft.title),
    description: tidy(draft.description),
    servings: COVERAGE.servings,
    prepMin: Math.round(draft.prep_minutes),
    cookMin: Math.round(draft.cook_minutes),
    ingredients: ingredients.map((l) => ({
      rawText: l.rawText,
      ...(l.groupName ? { groupName: l.groupName } : {}),
    })),
    instructions: draft.steps.map(tidy),
    tags: [...tags],
    cuisine: slot.cuisine,
  });
  if (!normalized.success) {
    out.push(`it is not a valid recipe: ${normalized.error.issues[0]?.message ?? "unknown"}`);
  }
  if (!RecipeInstructions.safeParse(instructionsToJson(draft.steps.map(tidy))).success) {
    out.push("the steps are not valid instructions");
  }
  return out;
}

class Ledger {
  spent = 0;
  readonly capUsd: number;
  constructor(capUsd: number) {
    this.capUsd = capUsd;
  }
  add(usd: number): void {
    this.spent += usd;
  }
  get exhausted(): boolean {
    return this.spent >= this.capUsd;
  }
}

type SlotResult =
  | { ok: true; recipe: CatalogRecipe }
  | { ok: false; abandoned: true; stopped?: false }
  | { ok: false; abandoned: false; stopped: true };

interface RunContext {
  client: MessagesClient;
  resources: Resources;
  ledger: Ledger;
  guard: CostGuard;
  options: DraftOptions;
  now: () => Date;
  say: (line: string) => void;
  usedTitles: Set<string>;
  rejected: Rejection[];
}

async function draftSlot(slot: Slot, ctx: RunContext): Promise<SlotResult> {
  let problems: string[] = [];
  let slotCost = 0;
  const bill = (usd: number): void => {
    slotCost += usd;
    ctx.ledger.add(usd);
  };

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const vars = {
      dish: slot.dish,
      cuisine: slot.cuisine,
      protein: slot.protein,
      methods: slot.methods,
      maxMinutes: slot.maxMinutes,
      diets: slot.diets,
      allergenFree: slot.allergenFree === true,
      audience: slot.audience,
      usedTitles: [...ctx.usedTitles].slice(0, 80),
      ...(problems.length > 0 ? { problems } : {}),
    };

    let draft: CatalogDraftOutput;
    try {
      const result = await extract(
        CatalogDraftOutput,
        {
          system: CATALOG_DRAFT_V1.system(),
          user: CATALOG_DRAFT_V1.user(vars),
          model: MODELS.sonnet,
          maxTokens: MAX_TOKENS,
          effort: "low",
          kind: CATALOG_DRAFT_V1.kind,
          promptVersion: CATALOG_DRAFT_V1.id,
          check: (value) => {
            const found = draftTextProblems(value, slot);
            return found.length > 0 ? `rule: ${found.slice(0, 6).join("; ")}` : null;
          },
        },
        {
          client: ctx.client,
          guard: ctx.guard,
          log: (record: AiRunRecord) => {
            bill(record.costUsd);
            if (!record.ok && /^(?:rule:|the answer did not match)/.test(record.error ?? "")) {
              ctx.rejected.push({
                slug: slot.slug,
                attempt,
                problems: [(record.error ?? "").replace(/^rule: /, "")],
              });
            }
          },
        },
      );
      draft = result.value;
    } catch (err) {
      if (err instanceof LlmError && err.code === "cost_cap") {
        return { ok: false, abandoned: false, stopped: true };
      }
      const message = err instanceof Error ? err.message : String(err);
      problems = [message.replace(/^rule: /, "")];
      ctx.say(`  ${slot.slug}: attempt ${attempt} failed: ${message.slice(0, 200)}`);
      continue;
    }

    // Parse every line: grammar, ontology lookup, Haiku for the unsure ones.
    const raws = draft.ingredients.map((l) => tidy(l.text));
    const parserDeps: ParserDeps = {
      ontology: ctx.resources.ontology,
      cache: ctx.resources.cache,
      llm: createAnthropicParseClient({ client: ctx.client }),
      confidenceThreshold: DEFAULT_CONFIDENCE_THRESHOLD,
      onLlmRun: (usage) => bill(haikuCostUsd(usage)),
      onLlmError: (error) =>
        ctx.say(`  ${slot.slug}: parser fallback failed: ${String(error).slice(0, 120)}`),
      onWarning: () => undefined,
    };
    const parsed = await parseLinesGrouped(raws, parserDeps);

    const lineProblems: string[] = [];
    const ingredients: CatalogIngredient[] = [];
    parsed.forEach((items, i) => {
      const raw = raws[i] ?? "";
      const item = items[0];
      if (items.length !== 1 || !item) {
        lineProblems.push(
          `line ${i + 1} ("${raw}") names ${items.length} ingredients; write exactly one ingredient per line`,
        );
        return;
      }
      const sure = item.ingredientId !== null && item.confidence >= COVERAGE.resolvedConfidence;
      const qty = item.qty === null ? null : round4(item.qty);
      const qtyMax =
        qty !== null && item.qtyMax != null && item.qtyMax > qty ? round4(item.qtyMax) : null;
      if (item.unit !== null && !isUnitCode(item.unit)) {
        lineProblems.push(`line ${i + 1} ("${raw}") has a unit we do not know: ${item.unit}`);
      }
      const group = draft.ingredients[i]?.group;
      ingredients.push({
        position: i,
        groupName: group ? tidy(group) : null,
        rawText: raw,
        qty,
        qtyMax,
        unit: item.unit,
        ingredientName: item.ingredientName,
        ingredientId: sure ? item.ingredientId : null,
        prepNote: item.prepNote ?? null,
        optional: item.optional,
        parseConfidence: round4(item.confidence),
      });
    });

    const facts = analyzeRecipe(ingredients, ctx.resources.categoryOf);
    const tags = buildTags({
      protein: slot.protein,
      diets: facts.diets,
      methods: slot.methods,
      audience: slot.audience,
    });
    const found =
      lineProblems.length > 0
        ? lineProblems
        : problemsFor(slot, draft, ingredients, tags, ctx.resources.categoryOf, ctx.usedTitles);

    const recipe: CatalogRecipe = {
      id: recipeId(slot.slug),
      slug: slot.slug,
      title: tidy(draft.title),
      description: tidy(draft.description),
      servings: COVERAGE.servings,
      prepMin: Math.round(draft.prep_minutes),
      cookMin: Math.round(draft.cook_minutes),
      cuisine: slot.cuisine,
      tags,
      ingredients,
      instructions: draft.steps.map(tidy),
      draft: {
        model: MODELS.sonnet,
        promptVersion: CATALOG_DRAFT_V1.id,
        draftedAt: ctx.now().toISOString(),
        costUsd: 0,
      },
    };
    if (found.length === 0) {
      // The shared shape check is the last gate before a file is written.
      found.push(...shapeProblems(recipe));
    }
    if (found.length === 0) {
      recipe.draft.costUsd = round4(slotCost);
      return { ok: true, recipe };
    }

    ctx.rejected.push({ slug: slot.slug, attempt, problems: found });
    problems = found;
    ctx.say(`  ${slot.slug}: attempt ${attempt} rejected (${found.length} problem(s))`);
    for (const p of found.slice(0, 4)) ctx.say(`    - ${p.slice(0, 220)}`);
  }
  return { ok: false, abandoned: true };
}

function readLog(path: string): DraftLog {
  if (!existsSync(path)) return { runs: [] };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as DraftLog;
    return Array.isArray(parsed.runs) ? parsed : { runs: [] };
  } catch {
    return { runs: [] };
  }
}

export interface DraftSummary extends RunRecord {
  /** Plan slugs with a file at the end of the run. */
  have: number;
}

/** The whole run. Exported so the test can drive it with a fake client. */
export async function draftCatalog(options: DraftOptions, deps: DraftDeps): Promise<DraftSummary> {
  const now = deps.now ?? (() => new Date());
  const say = deps.say ?? ((line: string) => console.log(line));
  const ledger = new Ledger(options.maxUsd);
  const guard: CostGuard = {
    async check() {
      if (ledger.exhausted) throw new LlmError("cost_cap", "the --max-usd cap is reached");
    },
  };
  mkdirSync(options.outDir, { recursive: true });
  const resources = loadResources();

  const pathOf = (slug: string): string => join(options.outDir, `${slug}.json`);
  const plan = options.only ? PLAN.filter((s) => options.only?.includes(s.slug)) : PLAN;
  const unknownOnly = (options.only ?? []).filter((slug) => !PLAN.some((s) => s.slug === slug));
  if (unknownOnly.length > 0) throw new Error(`not in the plan: ${unknownOnly.join(", ")}`);

  // Titles already in the out dir, so the model does not repeat them.
  const usedTitles = new Set<string>();
  for (const s of PLAN) {
    if (!existsSync(pathOf(s.slug))) continue;
    const file = JSON.parse(readFileSync(pathOf(s.slug), "utf8")) as CatalogRecipe;
    usedTitles.add(file.title);
  }

  const written: string[] = [];
  const skipped: string[] = [];
  const rejected: Rejection[] = [];
  const abandoned: string[] = [];
  let stoppedByCostCap = false;
  let have = 0;
  let cursor = 0;

  const ctx: RunContext = {
    client: deps.client,
    resources,
    ledger,
    guard,
    options,
    now,
    say,
    usedTitles,
    rejected,
  };

  while (have < options.count && cursor < plan.length && !stoppedByCostCap) {
    // Fill a round: skip what exists, draft the rest, up to `concurrency` at a time.
    const round: Slot[] = [];
    while (cursor < plan.length && have + round.length < options.count) {
      const slot = plan[cursor++] as Slot;
      if (existsSync(pathOf(slot.slug))) {
        skipped.push(slot.slug);
        have++;
        say(`skip ${slot.slug} (already drafted)`);
        continue;
      }
      round.push(slot);
      if (round.length >= options.concurrency) break;
    }
    if (round.length === 0) continue;
    if (ledger.exhausted) {
      stoppedByCostCap = true;
      break;
    }
    const results = await Promise.all(round.map((slot) => draftSlot(slot, ctx)));
    results.forEach((result, i) => {
      const slot = round[i] as Slot;
      if (result.ok) {
        writeFileSync(pathOf(slot.slug), `${JSON.stringify(result.recipe, null, 2)}\n`);
        usedTitles.add(result.recipe.title);
        written.push(slot.slug);
        have++;
        const resolved = result.recipe.ingredients.filter((l) => l.ingredientId !== null).length;
        say(
          `wrote ${slot.slug}.json  $${result.recipe.draft.costUsd.toFixed(4)}  "${result.recipe.title}"  ${resolved}/${result.recipe.ingredients.length} lines resolved  [${result.recipe.tags.join(", ")}]`,
        );
      } else if (result.stopped) {
        stoppedByCostCap = true;
      } else {
        abandoned.push(slot.slug);
        say(`gave up on ${slot.slug} after ${MAX_ATTEMPTS} attempts`);
      }
    });
    if (ledger.exhausted && have < options.count) stoppedByCostCap = true;
  }

  const record: RunRecord = {
    at: now().toISOString(),
    model: MODELS.sonnet,
    promptVersion: CATALOG_DRAFT_V1.id,
    requested: options.count,
    written,
    skipped,
    rejected,
    abandoned,
    costUsd: round4(ledger.spent),
    stoppedByCostCap,
  };
  // A run that changed nothing and spent nothing is not worth a line in the log.
  if (written.length > 0 || rejected.length > 0 || ledger.spent > 0) {
    const log = readLog(options.logPath);
    log.runs.push(record);
    mkdirSync(dirname(options.logPath), { recursive: true });
    writeFileSync(options.logPath, `${JSON.stringify(log, null, 2)}\n`);
  }
  return { ...record, have };
}

// ---------------------------------------------------------------------------------------
// Command line
// ---------------------------------------------------------------------------------------

const USAGE = `usage: draft-catalog [--count N] [--max-usd USD] [--out DIR] [--log FILE]
                     [--concurrency N] [--only slug,slug]

  --count N         plan slugs that should have a file when the run ends (default 60)
  --max-usd USD     hard stop on model spend (default 5)
  --out DIR         where the JSON files go (default supabase/seed/catalog/recipes)
  --log FILE        run log (default supabase/seed/catalog/draft-log.json, or DIR/draft-log.json
                    when --out is given)
  --concurrency N   recipes drafted at once (default 3)
  --only a,b        draft only these slugs

The key is read from ANTHROPIC_API_KEY in the environment. The script refuses to run when CI is set.`;

export function parseArgs(argv: readonly string[]): DraftOptions | "help" {
  const args = argv.filter((a) => a !== "--");
  const value = (flag: string): string | undefined => {
    const i = args.indexOf(flag);
    if (i === -1) return undefined;
    const v = args[i + 1];
    if (v === undefined || v.startsWith("--")) throw new Error(`${flag} needs a value`);
    return v;
  };
  const known = new Set([
    "--count",
    "--max-usd",
    "--out",
    "--log",
    "--concurrency",
    "--only",
    "--help",
  ]);
  for (const a of args) {
    if (a.startsWith("--") && !known.has(a)) throw new Error(`unknown option ${a}`);
  }
  if (args.includes("--help")) return "help";
  const positive = (flag: string, fallback: number): number => {
    const raw = value(flag);
    if (raw === undefined) return fallback;
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) throw new Error(`${flag} must be a positive number`);
    return n;
  };
  const only = value("--only")
    ?.split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const out = value("--out");
  const outDir = out ? resolve(out) : DEFAULT_OUT_DIR;
  const log = value("--log");
  const count = Math.floor(positive("--count", only ? only.length : 60));
  return {
    count,
    maxUsd: positive("--max-usd", 5),
    outDir,
    logPath: log ? resolve(log) : out ? join(outDir, "draft-log.json") : DEFAULT_LOG_PATH,
    concurrency: Math.max(1, Math.floor(positive("--concurrency", 3))),
    ...(only ? { only } : {}),
  };
}

async function main(): Promise<void> {
  if (process.env.CI) {
    console.error("draft-catalog is a one-time local script and refuses to run when CI is set.");
    process.exit(2);
  }
  let options: DraftOptions | "help";
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    console.error(USAGE);
    process.exit(2);
  }
  if (options === "help") {
    console.log(USAGE);
    return;
  }
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error("ANTHROPIC_API_KEY is not set. Export it from .env.local into this process.");
    process.exit(2);
  }
  const client = await createAnthropicClient({ apiKey });
  console.log(
    `drafting up to ${options.count} recipes into ${options.outDir} (cap $${options.maxUsd.toFixed(2)}, ${options.concurrency} at a time)`,
  );
  const summary = await draftCatalog(options, { client });
  console.log(
    `done: wrote ${summary.written.length}, skipped ${summary.skipped.length}, rejected ${summary.rejected.length} draft(s), gave up on ${summary.abandoned.length}; ${summary.have} of ${options.count} slugs have a file`,
  );
  console.log(`cost: $${summary.costUsd.toFixed(4)} of the $${options.maxUsd.toFixed(2)} cap`);
  if (summary.stoppedByCostCap) console.log("stopped: the cost cap was reached");
  if (summary.have < options.count) process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
