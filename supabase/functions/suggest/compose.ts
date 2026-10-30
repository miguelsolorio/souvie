// Composition for the suggest function (WS06). docs/03-ai-design.md §3 steps 3 and 4.
//
// The model chooses among the candidates by position and fills the dates it was offered. Code
// checks every answer: an index outside the list, a repeated recipe or date, a date that was not
// offered, or the wrong number of dinners is rejected. The call is retried once with the problem
// described, and a second failure throws `ComposeError`, which the handler answers by ranking
// candidates itself (`fallbackWeek`). The recipe ids that come out are always read from the
// candidate list, never from the model, and a last assertion confirms each is in that list (R4,
// R13).
import {
  type AiRunSink,
  type ComposeCandidateView,
  ComposedWeek,
  type CostGuard,
  type ExtractResult,
  extract,
  LlmError,
  type MessagesClient,
  SUGGEST_COMPOSE_V1,
} from "../../../packages/llm/src/index.ts";
import type { Candidate } from "./candidates.ts";

// ---------------------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------------------

function parseIso(iso: string): Date {
  const [year, month, day] = iso.split("-").map(Number);
  return new Date(Date.UTC(year as number, (month as number) - 1, day as number));
}

/** True for a YYYY-MM-DD date that falls on a Monday. */
export function isMonday(iso: string): boolean {
  return parseIso(iso).getUTCDay() === 1;
}

export function addDays(iso: string, days: number): string {
  const date = parseIso(iso);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** The seven dates of the week that starts on `weekStart`, Monday first. */
export function weekDates(weekStart: string): string[] {
  return Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
}

/**
 * The dates to plan: the first `count` days of the week, Monday first, skipping nights that are
 * taken. Five dinners are Monday to Friday, which is also when the weeknight time limit applies.
 */
export function pickDinnerDates(
  weekStart: string,
  count: number,
  taken: ReadonlySet<string> = new Set(),
): string[] {
  return weekDates(weekStart)
    .filter((date) => !taken.has(date))
    .slice(0, Math.min(Math.max(count, 0), 7));
}

export type ComposeErrorCode = "invalid_output" | "cost_cap" | "not_configured" | "model_failed";

/** The typed error `composeWeek` throws. The handler maps it to the ranked fallback. */
export class ComposeError extends Error {
  readonly code: ComposeErrorCode;
  constructor(code: ComposeErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ComposeError";
    this.code = code;
  }
}

export interface ComposeProfile {
  /** People to cook for. */
  portions: number;
  skill?: string | undefined;
  weeknightMinutes?: number | null | undefined;
  leftovers?: string | undefined;
  cuisines: readonly string[];
  diets: readonly string[];
  equipment: readonly string[];
  budgetPerWeekUsd?: number | null | undefined;
  notes?: string | undefined;
  tasteSummary?: string | undefined;
}

export interface ComposeInput {
  weekStart: string;
  /** The dates to fill, one dinner each, in the order the week reads. */
  dates: readonly string[];
  /** Best first. The index a model answers with is a position in this list. */
  candidates: readonly Candidate[];
  profile: ComposeProfile;
  /** Titles of last week's dinners. */
  lastWeek: readonly string[];
}

export interface ComposedEntry {
  recipeId: string;
  date: string;
  servings: number;
  why: string;
}

export interface ComposeResult {
  entries: ComposedEntry[];
  notes: string;
  /** Model calls made: 1, or 2 after a retry. */
  attempts: number;
  costUsd: number;
}

export interface ComposeDeps {
  client?: MessagesClient;
  apiKey?: string | undefined;
  log?: AiRunSink;
  guard?: CostGuard;
  householdId: string | null;
}

/**
 * What is wrong with a composed week, or null when it is acceptable. `extract` calls this as its
 * `check`, so a problem here triggers the one retry with the message shown to the model.
 */
export function checkComposed(
  week: ComposedWeek,
  context: { candidateCount: number; dates: readonly string[] },
): string | null {
  if (week.entries.length !== context.dates.length) {
    return `you returned ${week.entries.length} dinners but ${context.dates.length} were requested`;
  }
  const offered = new Set(context.dates);
  const usedDates = new Set<string>();
  const usedRecipes = new Set<number>();
  for (const entry of week.entries) {
    if (entry.recipeIndex >= context.candidateCount) {
      return `recipeIndex ${entry.recipeIndex} is out of range; use 0 to ${context.candidateCount - 1}`;
    }
    if (!offered.has(entry.date)) {
      return `${entry.date} is not one of the dates offered`;
    }
    if (usedDates.has(entry.date)) return `the date ${entry.date} is used twice`;
    usedDates.add(entry.date);
    if (usedRecipes.has(entry.recipeIndex)) {
      return `recipeIndex ${entry.recipeIndex} is used twice`;
    }
    usedRecipes.add(entry.recipeIndex);
  }
  return null;
}

function viewOf(candidate: Candidate): ComposeCandidateView {
  return {
    title: candidate.title,
    cuisine: candidate.cuisine,
    totalMin: candidate.totalMin,
    tags: candidate.tags,
    mainIngredients: candidate.mainIngredients,
  };
}

/**
 * Asks the model for a week and returns it with real recipe ids. Throws `ComposeError`.
 *
 * With 1 to 7 dates and at least that many candidates. Fewer candidates than dates is a caller
 * bug (the handler checks first), reported as `invalid_output`.
 */
export async function composeWeek(input: ComposeInput, deps: ComposeDeps): Promise<ComposeResult> {
  const { candidates, dates } = input;
  if (dates.length === 0 || dates.length > 7) {
    throw new ComposeError("invalid_output", "between 1 and 7 dinners can be composed");
  }
  if (candidates.length < dates.length) {
    throw new ComposeError(
      "invalid_output",
      `${candidates.length} candidates cannot fill ${dates.length} dinners`,
    );
  }

  let result: ExtractResult<ComposedWeek>;
  try {
    result = await extract(
      ComposedWeek,
      {
        system: SUGGEST_COMPOSE_V1.system(),
        user: SUGGEST_COMPOSE_V1.user({
          weekStart: input.weekStart,
          dates,
          household: input.profile,
          lastWeek: input.lastWeek,
          candidates: candidates.map(viewOf),
        }),
        model: SUGGEST_COMPOSE_V1.model,
        kind: SUGGEST_COMPOSE_V1.kind,
        promptVersion: SUGGEST_COMPOSE_V1.id,
        householdId: deps.householdId,
        effort: "medium",
        maxTokens: 4000,
        check: (week) => checkComposed(week, { candidateCount: candidates.length, dates }),
      },
      {
        ...(deps.client ? { client: deps.client } : {}),
        ...(deps.apiKey ? { apiKey: deps.apiKey } : {}),
        ...(deps.log ? { log: deps.log } : {}),
        ...(deps.guard ? { guard: deps.guard } : {}),
      },
    );
  } catch (err) {
    if (err instanceof LlmError) {
      const code: ComposeErrorCode =
        err.code === "invalid"
          ? "invalid_output"
          : err.code === "cost_cap"
            ? "cost_cap"
            : err.code === "not_configured"
              ? "not_configured"
              : "model_failed";
      throw new ComposeError(code, err.message, { cause: err });
    }
    throw err;
  }

  const ids = new Set(candidates.map((candidate) => candidate.id));
  const entries: ComposedEntry[] = [];
  for (const entry of result.value.entries) {
    const candidate = candidates[entry.recipeIndex];
    // Defense in depth: checkComposed already refused an index outside the list, and the id comes
    // from the list. This confirms it, so a change to either check cannot let a stranger through.
    if (!candidate || !ids.has(candidate.id)) {
      throw new ComposeError(
        "invalid_output",
        `recipeIndex ${entry.recipeIndex} is not a candidate`,
      );
    }
    entries.push({
      recipeId: candidate.id,
      date: entry.date,
      servings: entry.servings,
      why: entry.why,
    });
  }
  // Read in date order, the way the week is shown.
  entries.sort((a, b) => a.date.localeCompare(b.date));
  return {
    entries,
    notes: result.value.notes.trim(),
    attempts: result.attempts,
    costUsd: result.costUsd,
  };
}

// ---------------------------------------------------------------------------------------
// Fallback
// ---------------------------------------------------------------------------------------

/** A reason the person can read, built from facts we hold, not from a model. */
function fallbackWhy(candidate: Candidate, cuisinePreferred: boolean): string {
  const parts: string[] = [];
  if (candidate.totalMin) parts.push(`ready in about ${candidate.totalMin} minutes`);
  if (cuisinePreferred && candidate.cuisine)
    parts.push(`${candidate.cuisine} is one of your favorites`);
  if (parts.length === 0) parts.push("a good match for your tastes");
  const text = `${parts.join(", ")}.`;
  return (text.charAt(0).toUpperCase() + text.slice(1)).slice(0, 139);
}

/**
 * The week when the model cannot be used: the best-ranked candidates, spread over cuisines, one
 * per date, quickest on the earliest dates. Deterministic, so a repeat gives the same plan.
 * (docs/03 §3 step 4: invalid output is retried once, then falls back to top-N by score.)
 */
export function fallbackWeek(
  candidates: readonly Candidate[],
  dates: readonly string[],
  options: { servings: number; cuisines: readonly string[] },
): ComposedEntry[] {
  const wanted = new Set(options.cuisines.map((c) => c.trim().toLowerCase()));
  const chosen: Candidate[] = [];
  const perCuisine = new Map<string, number>();
  // First pass: at most two of a cuisine. Second pass: fill what is left in rank order.
  for (const pass of [2, 7]) {
    for (const candidate of candidates) {
      if (chosen.length === dates.length) break;
      if (chosen.includes(candidate)) continue;
      const key = candidate.cuisine?.trim().toLowerCase() ?? "";
      if (pass === 2 && key && (perCuisine.get(key) ?? 0) >= pass) continue;
      chosen.push(candidate);
      perCuisine.set(key, (perCuisine.get(key) ?? 0) + 1);
    }
  }
  const ordered = [...chosen].sort(
    (a, b) => (a.totalMin ?? Number.POSITIVE_INFINITY) - (b.totalMin ?? Number.POSITIVE_INFINITY),
  );
  return ordered.slice(0, dates.length).map((candidate, i) => ({
    recipeId: candidate.id,
    date: dates[i] as string,
    servings: Math.min(Math.max(Math.round(options.servings), 1), 24),
    why: fallbackWhy(
      candidate,
      candidate.cuisine ? wanted.has(candidate.cuisine.trim().toLowerCase()) : false,
    ),
  }));
}
