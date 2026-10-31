// Eval for the suggest function (WS06). docs/03-ai-design.md §10, WS06 acceptance criterion 10.
//
//   pnpm eval suggest                       offline: the hard filters over ten households
//   EVAL_LIVE=1 ANTHROPIC_API_KEY=... VOYAGE_API_KEY=... pnpm eval suggest
//                                           also runs the cases that need a real model or real embeddings
//
// What it checks. Ten household fixtures (fixtures/household-*.json) run against one shared
// corpus of 51 recipes (fixtures/corpus.json): the household's own recipes, another household's,
// a deleted one, catalog recipes, desserts, lines the parser never resolved, and traps such as
// coconut milk (not dairy), cauliflower steaks (not meat), and Caesar dressing (egg and fish).
// Every candidate the retrieval returns is judged by `oracleViolations`, which reads the corpus's
// human-written labels and shares no code with filters.ts. One violation fails the run. Each
// household also lists recipes that must be excluded and ones that must survive, so a filter
// that is too eager fails too. Retrieval runs twice per household, once on a cold profile and
// once with a (synthetic) taste embedding, since ranking must never change what is allowed.
//
// The corpus labels and the fixtures were written by the builder agent (Claude Sonnet 5.5), not
// by a person. They are a regression net for the filters, not proof that every food is covered.
//
// Cases that need a real key are PENDING without one and are listed in the report. They never
// pass by default: set SUGGEST_EVAL_REQUIRE_LIVE=1 to count a pending case as a failure.
import {
  type Candidate,
  fetchCandidates,
  pickCalibration,
} from "../../../../supabase/functions/suggest/candidates.ts";
import {
  ComposeError,
  composeWeek,
  pickDinnerDates,
} from "../../../../supabase/functions/suggest/compose.ts";
import {
  buildFilterSpec,
  filterInputFromPreferences,
} from "../../../../supabase/functions/suggest/filters.ts";
import {
  type CorpusRecipe,
  FIXTURE_HOUSEHOLD,
  type HouseholdFixture,
  type LoadedCorpus,
  loadCorpus,
  readHouseholdFixtures,
} from "../../../../supabase/functions/suggest/testing/corpus.ts";
import {
  createTestDb,
  type TestDb,
  vectorLiteral,
} from "../../../../supabase/functions/suggest/testing/db.ts";
import { oracleViolations } from "../../../../supabase/functions/suggest/testing/oracle.ts";
import { createAnthropicClient } from "../../src/client.ts";
import { embed } from "../../src/embed.ts";

// ---------------------------------------------------------------------------------------
// Synthetic embeddings (offline): each cuisine owns an axis of a 1024 dimension space
// ---------------------------------------------------------------------------------------

function axisOf(cuisine: string | null): number {
  let hash = 7;
  for (const ch of cuisine ?? "none") hash = (hash * 31 + ch.charCodeAt(0)) % 997;
  return hash % 1024;
}

function oneHot(cuisines: readonly (string | null)[]): number[] {
  const v = new Array<number>(1024).fill(0);
  for (const cuisine of cuisines) v[axisOf(cuisine)] = (v[axisOf(cuisine)] ?? 0) + 1;
  return v;
}

// ---------------------------------------------------------------------------------------
// Hard filters
// ---------------------------------------------------------------------------------------

export interface HouseholdResult {
  name: string;
  /** Candidates on the cold run and the warm run. */
  candidates: { cold: number; warm: number };
  /** Rules a candidate broke, judged by labels. Must be empty. */
  violations: string[];
  /** Recipes the TypeScript re-check refused after the SQL let them through. Must be empty. */
  disagreements: string[];
  /** mustExclude, mustInclude, and minCandidates misses. Must be empty. */
  expectationFailures: string[];
  /** Calibration cards the household would see. */
  calibration: number;
}

export interface PendingCase {
  name: string;
  reason: string;
}

export interface LiveResult {
  name: string;
  ok: boolean;
  detail: string;
}

export interface EvalReport {
  households: HouseholdResult[];
  violations: number;
  disagreements: number;
  expectationFailures: number;
  pending: PendingCase[];
  live: LiveResult[];
}

async function retrieve(
  t: TestDb,
  fixture: HouseholdFixture,
  warm: boolean,
  extra: { limit?: number } = {},
): Promise<{ candidates: Candidate[]; dropped: { recipeId: string; reasons: string[] }[] }> {
  const spec = buildFilterSpec(filterInputFromPreferences(fixture.preferences));
  return fetchCandidates(t.runner, {
    householdId: FIXTURE_HOUSEHOLD,
    spec,
    tasteEmbedding: warm ? vectorLiteral(oneHot(fixture.preferences.cuisines ?? [])) : null,
    cuisines: fixture.preferences.cuisines ?? [],
    warn: () => {},
    ...extra,
  });
}

function judge(
  fixture: HouseholdFixture,
  corpus: LoadedCorpus,
  run: { candidates: Candidate[]; dropped: { recipeId: string; reasons: string[] }[] },
  label: string,
  result: HouseholdResult,
): void {
  const keys = new Set<string>();
  for (const candidate of run.candidates) {
    const recipe = corpus.byId.get(candidate.id);
    if (!recipe) {
      result.violations.push(`${label}: unknown recipe ${candidate.id}`);
      continue;
    }
    keys.add(recipe.key);
    for (const reason of oracleViolations(fixture.preferences, recipe)) {
      result.violations.push(`${label}: ${recipe.key} ${reason}`);
    }
  }
  for (const dropped of run.dropped) {
    const key = corpus.byId.get(dropped.recipeId)?.key ?? dropped.recipeId;
    result.disagreements.push(`${label}: ${key} (${dropped.reasons[0] ?? "?"})`);
  }
  for (const key of fixture.expect.mustExclude) {
    if (keys.has(key)) result.expectationFailures.push(`${label}: ${key} should be excluded`);
  }
  for (const key of fixture.expect.mustInclude) {
    if (!keys.has(key)) result.expectationFailures.push(`${label}: ${key} should be a candidate`);
  }
  if (run.candidates.length < fixture.expect.minCandidates) {
    result.expectationFailures.push(
      `${label}: ${run.candidates.length} candidates, expected at least ${fixture.expect.minCandidates}`,
    );
  }
}

/** Runs the ten households offline. */
export async function runHardFilterEval(): Promise<{
  households: HouseholdResult[];
  t: TestDb;
  corpus: LoadedCorpus;
}> {
  const t = await createTestDb();
  const corpus = await loadCorpus(t, { embeddings: (recipe) => oneHot([recipe.cuisine]) });
  const results: HouseholdResult[] = [];
  for (const fixture of readHouseholdFixtures()) {
    const cold = await retrieve(t, fixture, false);
    const warm = await retrieve(t, fixture, true);
    const result: HouseholdResult = {
      name: fixture.name,
      candidates: { cold: cold.candidates.length, warm: warm.candidates.length },
      violations: [],
      disagreements: [],
      expectationFailures: [],
      calibration: 0,
    };
    judge(fixture, corpus, cold, "cold", result);
    judge(fixture, corpus, warm, "warm", result);
    // The calibration cards come from the same candidates, so they inherit the filters. Check them
    // anyway: a card is the first thing a new user sees.
    const cards = pickCalibration(cold.candidates, 12);
    result.calibration = cards.length;
    for (const card of cards) {
      const recipe = corpus.byId.get(card.id);
      if (!recipe) continue;
      for (const reason of oracleViolations(fixture.preferences, recipe)) {
        result.violations.push(`calibration: ${recipe.key} ${reason}`);
      }
    }
    // Warm and cold must allow exactly the same recipes when both can show them all.
    if (cold.candidates.length < 60 && cold.candidates.length !== warm.candidates.length) {
      result.expectationFailures.push(
        `cold and warm ranking allowed different numbers of recipes (${cold.candidates.length} vs ${warm.candidates.length})`,
      );
    }
    results.push(result);
  }
  return { households: results, t, corpus };
}

// ---------------------------------------------------------------------------------------
// Cases that need a key
// ---------------------------------------------------------------------------------------

const LIVE_HOUSEHOLDS = [
  "household-01-shellfish",
  "household-04-vegetarian",
  "household-06-gluten-free-dairy-free",
];

async function runLiveCompose(
  t: TestDb,
  corpus: LoadedCorpus,
  apiKey: string,
): Promise<LiveResult[]> {
  const client = await createAnthropicClient({ apiKey });
  const out: LiveResult[] = [];
  const fixtures = readHouseholdFixtures().filter((f) => LIVE_HOUSEHOLDS.includes(f.name));
  for (const fixture of fixtures) {
    const { candidates } = await retrieve(t, fixture, false);
    const dates = pickDinnerDates("2026-11-02", fixture.preferences.dinners_per_week ?? 5);
    try {
      const composed = await composeWeek(
        {
          weekStart: "2026-11-02",
          dates,
          candidates,
          profile: {
            portions: fixture.preferences.portions ?? 3,
            cuisines: fixture.preferences.cuisines ?? [],
            diets: fixture.preferences.diets ?? [],
            equipment: [],
            weeknightMinutes: fixture.preferences.weeknight_minutes ?? null,
          },
          lastWeek: [],
        },
        { client, householdId: null },
      );
      const bad: string[] = [];
      for (const entry of composed.entries) {
        const recipe: CorpusRecipe | undefined = corpus.byId.get(entry.recipeId);
        if (!recipe) bad.push(`unknown recipe ${entry.recipeId}`);
        else
          for (const reason of oracleViolations(fixture.preferences, recipe))
            bad.push(`${recipe.key} ${reason}`);
        if (entry.why.length >= 140) bad.push("why is 140 characters or more");
      }
      const distinctRecipes = new Set(composed.entries.map((e) => e.recipeId)).size;
      const distinctDates = new Set(composed.entries.map((e) => e.date)).size;
      const ok =
        bad.length === 0 &&
        composed.entries.length === dates.length &&
        distinctRecipes === dates.length &&
        distinctDates === dates.length;
      out.push({
        name: `live compose: ${fixture.name}`,
        ok,
        detail: ok
          ? `${composed.entries.length} dinners, ${composed.attempts} attempt(s), $${composed.costUsd.toFixed(4)}`
          : `${bad.join("; ") || "wrong shape"}`,
      });
    } catch (err) {
      out.push({
        name: `live compose: ${fixture.name}`,
        ok: false,
        detail: err instanceof ComposeError ? `${err.code}: ${err.message}` : String(err),
      });
    }
  }
  return out;
}

async function runLiveEmbeddings(
  t: TestDb,
  corpus: LoadedCorpus,
  apiKey: string,
): Promise<LiveResult[]> {
  const rows = await t.query<{ id: string; title: string; cuisine: string | null; tags: string[] }>(
    `select id, title, cuisine, tags from public.recipes where household_id = $1 and deleted_at is null`,
    [FIXTURE_HOUSEHOLD],
  );
  const texts = rows.map(
    (r) => `${r.title} | cuisine: ${r.cuisine ?? ""} | tags: ${r.tags.join(", ")}`,
  );
  const vectors = await embed(texts, { apiKey, inputType: "document" });
  for (const [i, row] of rows.entries()) {
    await t.query("update public.recipes set embedding = $1::extensions.vector where id = $2", [
      vectorLiteral(vectors[i] ?? []),
      row.id,
    ]);
  }
  const [taste] = await embed(
    ["Thai noodles with peanuts, lime, and rice noodles; quick weeknight stir fries"],
    {
      apiKey,
      inputType: "query",
    },
  );
  const spec = buildFilterSpec({ allergies: [], diets: [], dislikes: [] });
  const { candidates } = await fetchCandidates(t.runner, {
    householdId: FIXTURE_HOUSEHOLD,
    spec,
    tasteEmbedding: vectorLiteral(taste ?? []),
    cuisines: [],
    warn: () => {},
  });
  const top = candidates.slice(0, 5).map((c) => corpus.byId.get(c.id)?.key ?? c.id);
  const asian = top.filter((key) =>
    [
      "pad-thai",
      "tofu-peanut-noodles",
      "tahini-noodles",
      "veggie-stir-fry",
      "egg-fried-rice",
      "beef-broccoli",
    ].includes(key),
  );
  return [
    {
      name: "live embeddings: a Thai noodle taste ranks noodle and stir fry recipes first",
      ok: asian.length >= 2,
      detail: `top five: ${top.join(", ")}`,
    },
  ];
}

export interface RunOptions {
  live: boolean;
  anthropicKey?: string | undefined;
  voyageKey?: string | undefined;
}

export async function runSuggestEval(options: RunOptions): Promise<EvalReport> {
  const { households, t, corpus } = await runHardFilterEval();
  const pending: PendingCase[] = [];
  const live: LiveResult[] = [];
  try {
    if (!options.live) {
      pending.push({ name: "live compose (Sonnet)", reason: "EVAL_LIVE=1 not set" });
      pending.push({ name: "live embeddings (Voyage voyage-3)", reason: "EVAL_LIVE=1 not set" });
    } else {
      if (options.anthropicKey)
        live.push(...(await runLiveCompose(t, corpus, options.anthropicKey)));
      else pending.push({ name: "live compose (Sonnet)", reason: "ANTHROPIC_API_KEY not set" });
      if (options.voyageKey) live.push(...(await runLiveEmbeddings(t, corpus, options.voyageKey)));
      else
        pending.push({
          name: "live embeddings (Voyage voyage-3)",
          reason: "VOYAGE_API_KEY not set",
        });
    }
  } finally {
    await t.close();
  }
  return {
    households,
    violations: households.reduce((n, h) => n + h.violations.length, 0),
    disagreements: households.reduce((n, h) => n + h.disagreements.length, 0),
    expectationFailures: households.reduce((n, h) => n + h.expectationFailures.length, 0),
    pending,
    live,
  };
}

export function formatReport(report: EvalReport): string {
  const lines: string[] = [
    "suggest eval: hard filters over ten households (cold and warm retrieval)",
  ];
  for (const h of report.households) {
    const bad = h.violations.length + h.disagreements.length + h.expectationFailures.length;
    lines.push(
      `  ${bad === 0 ? "PASS" : "FAIL"}  ${h.name}  candidates ${h.candidates.cold}/${h.candidates.warm}, calibration cards ${h.calibration}`,
    );
    for (const problem of [...h.violations, ...h.disagreements, ...h.expectationFailures]) {
      lines.push(`        ${problem}`);
    }
  }
  for (const result of report.live) {
    lines.push(`  ${result.ok ? "PASS" : "FAIL"}  ${result.name}: ${result.detail}`);
  }
  for (const item of report.pending) lines.push(`  PEND  ${item.name}: ${item.reason}`);
  lines.push(`hard-filter violations: ${report.violations}`);
  lines.push(`sql and typescript filter disagreements: ${report.disagreements}`);
  lines.push(`expectation failures: ${report.expectationFailures}`);
  lines.push(`pending: ${report.pending.length}`);
  return lines.join("\n");
}
