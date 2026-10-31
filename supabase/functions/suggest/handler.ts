// suggest request handling (WS06). No Deno globals and no database driver here: the handler takes a
// `Runtime`, so Vitest drives it with PGlite and fakes (handler.test.ts) and index.ts builds the
// real one. Request and response shapes are in @mp/core (preferences.ts) and README.md.
//
// The order of work for a plan, and why:
//   1. Authenticate, validate, and check the caller belongs to the household. Everything later
//      uses the household id from that check.
//   2. Refuse to plan for someone who never answered the allergy question.
//   3. Refresh embeddings if a Voyage key exists, so ranking can use them. Best effort.
//   4. Retrieve candidates: SQL hard filters first, a TypeScript re-check second (candidates.ts).
//   5. Compose with Sonnet, or rank when the model cannot be used (compose.ts).
//   6. Write the plan in one transaction.
import {
  CALIBRATION_CARD_COUNT,
  type CalibrationCard,
  SUGGEST_ERROR_MESSAGES,
  type SuggestEntry,
  type SuggestErrorCode,
  SuggestRequest,
} from "../../../packages/core/src/index.ts";
import {
  type AiRunSink,
  createDailyCapGuard,
  embed,
  formatVector,
  type MessagesClient,
  SUGGEST_COMPOSE_V1,
} from "../../../packages/llm/src/index.ts";
import {
  type Candidate,
  fetchCandidates,
  findFailingRecipes,
  MAX_CANDIDATES,
  pickCalibration,
  type SqlRunner,
  toCalibrationCard,
} from "./candidates.ts";
import {
  type ComposedEntry,
  ComposeError,
  type ComposeProfile,
  composeWeek,
  fallbackWeek,
  isMonday,
  pickDinnerDates,
  rankedWhy,
  weekDates,
} from "./compose.ts";
import { buildFilterSpec, FilterError, filterInputFromPreferences } from "./filters.ts";
import { buildTasteEmbedding, type EmbedFn, embedMissingRecipes } from "./profile-embedding.ts";
import { type ExistingPlan, type MemberProfile, SqlSuggestStore } from "./store.ts";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

/** Largest request body accepted, in bytes. A swap with 200 recipe ids to avoid is about 8,000. */
export const MAX_BODY_BYTES = 16_000;
/** Recipes embedded per call before ranking, so a first plan stays quick. */
export const EMBED_BATCH = 40;
/** Recipes embedded per backfill call. */
export const BACKFILL_BATCH = 50;

export interface Runtime {
  authenticate(authHeader: string): Promise<{ userId: string } | null>;
  /** The database, connected as its owner. See store.ts for why every query names the household. */
  sql: SqlRunner;
  now(): Date;
  /** The Anthropic client; absent when ANTHROPIC_API_KEY is not set. */
  anthropic?: () => Promise<MessagesClient>;
  /** The Voyage key; absent when VOYAGE_API_KEY is not set. */
  voyageKey?: string | undefined;
  /** Replaces fetch for the Voyage call, for tests. */
  fetch?: typeof fetch;
  /** Signed URLs for image paths in the recipe-images bucket. Paths it cannot sign are left out. */
  signImagePaths(paths: readonly string[]): Promise<Map<string, string>>;
  /** USD per household per UTC day for model and embedding calls. */
  dailyCapUsd: number;
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { ...CORS_HEADERS, "Cache-Control": "no-store" } });
}

function fail(error: SuggestErrorCode, status: number, message?: string): Response {
  return json({ ok: false, error, message: message ?? SUGGEST_ERROR_MESSAGES[error] }, status);
}

function startOfUtcDay(now: Date): string {
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  ).toISOString();
}

/** The reason shown on a dinner that replaced one the household's allergies or diets ruled out. */
export const CHANGED_WHY =
  "Changed because the earlier pick no longer fits your household's allergies or diets.";

/** People to cook for: the saved headcount, else adults plus kids, else two. */
export function defaultServings(member: MemberProfile): number {
  const prefs = member.preferences;
  const n =
    prefs.portions ??
    (prefs.household_size ? prefs.household_size.adults + prefs.household_size.kids : 2);
  return Math.min(Math.max(Math.round(n), 1), 24);
}

function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

export async function handleSuggest(req: Request, runtime: Runtime): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (req.method !== "POST") {
    return Response.json(
      { ok: false, error: "method_not_allowed" },
      { status: 405, headers: { ...CORS_HEADERS, Allow: "POST, OPTIONS" } },
    );
  }

  const authHeader = req.headers.get("authorization");
  if (!authHeader || !/^Bearer\s+\S+/i.test(authHeader)) return fail("unauthorized", 401);
  let user: { userId: string } | null = null;
  try {
    user = await runtime.authenticate(authHeader);
  } catch (err) {
    console.error("suggest: auth check failed", err);
  }
  if (!user) return fail("unauthorized", 401);

  let raw: unknown;
  try {
    const text = await req.text();
    if (text.length > MAX_BODY_BYTES) {
      return fail("invalid_request", 413, "The request is too large.");
    }
    raw = JSON.parse(text);
  } catch {
    return fail("invalid_request", 400, "The request body is not valid JSON.");
  }
  const parsed = SuggestRequest.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return fail(
      "invalid_request",
      400,
      `${issue?.path.join(".") || "request"}: ${issue?.message ?? "invalid"}`,
    );
  }
  const request = parsed.data;
  if (!isMonday(request.weekStart)) return fail("week_not_monday", 400);
  if (request.date && !weekDates(request.weekStart).includes(request.date)) {
    return fail("invalid_request", 400, "date: must fall inside the week");
  }

  try {
    const store = new SqlSuggestStore(runtime.sql);
    if (!(await store.isMember(request.householdId, user.userId))) {
      return fail("not_a_member", 403);
    }
    return await runSuggest(request, user.userId, runtime, store);
  } catch (err) {
    console.error("suggest failed", err instanceof FilterError ? err.message : err);
    return fail("internal_error", 500);
  }
}

async function runSuggest(
  request: SuggestRequest,
  userId: string,
  runtime: Runtime,
  store: SqlSuggestStore,
): Promise<Response> {
  const { householdId, weekStart } = request;
  const now = runtime.now();
  const warn = (message: string) => console.warn(message);

  // Logging and the daily cap, shared by every model and embedding call below.
  const log: AiRunSink = async (record) => {
    try {
      await store.logAiRun(record);
    } catch (err) {
      console.warn(`ai_runs insert failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  const guard = createDailyCapGuard({
    capUsd: runtime.dailyCapUsd,
    spentTodayUsd: (id) => store.spentSince(id, startOfUtcDay(now)),
  });
  const embedFn: EmbedFn | undefined = runtime.voyageKey
    ? (texts, inputType) =>
        embed(texts, {
          apiKey: runtime.voyageKey,
          inputType,
          kind: "suggest.embed",
          householdId,
          log,
          guard,
          ...(runtime.fetch ? { fetch: runtime.fetch } : {}),
        })
    : undefined;

  if (request.mode === "backfill") {
    if (!embedFn) return fail("embedding_unavailable", 200);
    const result = await embedMissingRecipes(runtime.sql, {
      householdId,
      limit: BACKFILL_BATCH,
      embed: embedFn,
    });
    return json({ ok: true, ...result });
  }

  const members = await store.loadMembers(householdId);
  const me = members.find((member) => member.userId === userId);
  // A missing `allergies` key means the question was never answered. An empty list means "none".
  if (!me || me.preferences.allergies === undefined) return fail("allergies_not_set", 200);
  const others = members.filter((member) => member.userId !== userId);

  const filterInput = filterInputFromPreferences(
    me.preferences,
    others.map((member) => member.preferences),
  );
  const spec = buildFilterSpec({
    ...filterInput,
    // A swap for a breakfast or lunch slot may return a recipe tagged breakfast or lunch.
    dinnerOnly: request.mode === "swap" ? request.slot === "dinner" : true,
  });
  const cuisines = me.preferences.cuisines ?? [];

  // --- swap -------------------------------------------------------------------------------------
  // One recipe for one slot, for the planner's "swap with a suggestion". Same filters and ranking
  // as a draft, but nothing is written (no plan, no entry, no feedback, no embedding refresh) and no
  // model is called: the planner applies the answer through its own upsert, and the reason is built
  // from facts. The week's own recipes and the ones the planner lists are left out.
  if (request.mode === "swap" && request.date && request.slot) {
    const plan = await store.getPlan(householdId, weekStart);
    const exclude = [
      ...new Set([
        ...(request.excludeRecipeIds ?? []),
        ...(plan?.entries ?? []).map((e) => e.recipeId),
      ]),
    ];
    const { candidates } = await fetchCandidates(runtime.sql, {
      householdId,
      spec,
      tasteEmbedding: me.tasteEmbedding,
      cuisines,
      excludeIds: exclude,
      now,
      limit: 3,
      warn,
    });
    const pick = candidates[0];
    if (!pick) return fail("no_candidates", 200);
    const favorite = pick.cuisine
      ? cuisines.some((c) => c.trim().toLowerCase() === pick.cuisine?.trim().toLowerCase())
      : false;
    return json({
      ok: true,
      ...(plan ? { planId: plan.id } : {}),
      entries: [
        {
          date: request.date,
          slot: request.slot,
          recipeId: pick.id,
          servings: defaultServings(me),
          why: rankedWhy(pick, favorite),
        },
      ],
    });
  }

  // --- calibration ------------------------------------------------------------------------------
  if (request.mode === "calibration") {
    const answered = await store.answeredRecipeIds(householdId, userId);
    const { candidates } = await fetchCandidates(runtime.sql, {
      householdId,
      spec,
      tasteEmbedding: me.tasteEmbedding,
      cuisines,
      excludeIds: answered,
      now,
      warn,
    });
    const picked = pickCalibration(candidates, CALIBRATION_CARD_COUNT);
    const cards = await cardsFor(picked, householdId, runtime);
    return json({ ok: true, recipeIds: picked.map((c) => c.id), cards });
  }

  // --- draft and replace ------------------------------------------------------------------------
  const existing = await store.getPlan(householdId, weekStart);
  const dinnersThisWeek = (existing?.entries ?? []).filter((e) => e.slot === "dinner");

  // A draft for a week that already has dinners returns them. A plan can be older than the
  // household's allergies: a member may have added one since. So the dinners still planned are
  // checked against the household's allergies and diets first, and any that fail are replaced
  // from the ranked list (no model call) or, with nothing to replace them, removed.
  const existingPlanResponse = async (plan: ExistingPlan): Promise<Response> => {
    const planned = plan.entries.filter((e) => e.slot === "dinner" && e.status === "planned");
    // Tastes (never-foods, minutes, dinner tags) belong to whoever asks, so they are not applied
    // to a plan someone else may have built or edited by hand. Safety applies to everyone.
    const safety = buildFilterSpec({
      ...filterInput,
      dislikes: [],
      weeknightMinutes: null,
      dinnerOnly: false,
    });
    const failing = await findFailingRecipes(runtime.sql, {
      householdId,
      spec: safety,
      recipeIds: planned.map((e) => e.recipeId),
    });
    const bad = planned.filter((e) => failing.has(e.recipeId));
    let current = plan;
    if (bad.length > 0) {
      const { candidates } = await fetchCandidates(runtime.sql, {
        householdId,
        spec,
        tasteEmbedding: me.tasteEmbedding,
        cuisines,
        excludeIds: plan.entries.map((e) => e.recipeId),
        now,
        limit: MAX_CANDIDATES,
        warn,
      });
      const picks = fallbackWeek(
        candidates,
        bad.slice(0, candidates.length).map((e) => e.date),
        { servings: defaultServings(me), cuisines },
      );
      const changes = picks.map((pick, i) => ({
        entryId: (bad[i] as { id: string }).id,
        recipeId: pick.recipeId,
        servings: bad[i]?.servings ?? defaultServings(me),
        why: CHANGED_WHY,
      }));
      const remove = bad.slice(picks.length).map((e) => e.id);
      await store.changeEntries({ householdId, changes, remove });
      warn(
        `suggest: household ${householdId} week ${weekStart}: replaced ${changes.length} and removed ${remove.length} planned dinner(s) that no longer pass the allergy and diet filters: ${bad
          .map((e) => `${e.recipeId} (${failing.get(e.recipeId)?.[0] ?? "filtered"})`)
          .join("; ")}`,
      );
      current = (await store.getPlan(householdId, weekStart)) ?? { id: plan.id, entries: [] };
    }
    return json({
      ok: true,
      planId: current.id,
      entries: current.entries
        .filter((e) => e.slot === "dinner")
        .map((e) => entryFrom(e, defaultServings(me))),
      composedBy: "existing",
    });
  };

  if (request.mode === "draft" && dinnersThisWeek.length > 0 && existing) {
    return existingPlanResponse(existing);
  }

  const locked = dinnersThisWeek.filter((e) => e.status !== "planned");
  const replaceable = dinnersThisWeek.filter((e) => e.status === "planned");
  let occupied = new Set(locked.map((e) => e.date));
  let replaceDates: string[] | null | undefined;
  let removedRecipeIds: string[] = [];

  if (request.mode === "replace" && request.date) {
    if (occupied.has(request.date)) {
      return fail("invalid_request", 400, "That night is already cooked or skipped.");
    }
    occupied = new Set(dinnersThisWeek.filter((e) => e.date !== request.date).map((e) => e.date));
    replaceDates = [request.date];
    removedRecipeIds = replaceable.filter((e) => e.date === request.date).map((e) => e.recipeId);
  } else if (request.mode === "replace") {
    replaceDates = null;
    removedRecipeIds = replaceable.map((e) => e.recipeId);
  }

  // The week should end with `dinners` dinners in it. Cooked and skipped ones already count, so a
  // replace only fills what is left.
  const target = request.dinners ?? me.preferences.dinners_per_week ?? 5;
  const wanted = request.date ? 1 : Math.max(target - locked.length, 0);
  const dates = request.date ? [request.date] : pickDinnerDates(weekStart, wanted, occupied);
  if (dates.length === 0) {
    return fail("invalid_request", 400, "Every night of that week is already cooked or skipped.");
  }

  // Recipes the plan keeps must not be picked again.
  const keptRecipeIds = dinnersThisWeek
    .filter(
      (e) => !(replaceDates === null ? e.status === "planned" : replaceDates?.includes(e.date)),
    )
    .map((e) => e.recipeId);

  // Refresh embeddings first so ranking can use them. Failures here only cost ranking quality.
  let tasteEmbedding = me.tasteEmbedding;
  const client = runtime.anthropic ? await runtime.anthropic().catch(() => undefined) : undefined;
  if (embedFn) {
    try {
      await embedMissingRecipes(runtime.sql, { householdId, limit: EMBED_BATCH, embed: embedFn });
      const feedback = await store.feedbackOf(householdId, userId);
      const built = await buildTasteEmbedding(
        { preferences: me.preferences, liked: feedback.liked, skipped: feedback.skipped },
        { embed: embedFn, client, log, guard, householdId },
        warn,
      );
      if (built) {
        tasteEmbedding = formatVector(built.vector);
        await store.saveTasteEmbedding(userId, tasteEmbedding);
      }
    } catch (err) {
      warn(`suggest: embeddings skipped (${err instanceof Error ? err.message : String(err)})`);
    }
  }

  const retrieve = (exclude: readonly string[]) =>
    fetchCandidates(runtime.sql, {
      householdId,
      spec,
      tasteEmbedding,
      cuisines,
      excludeIds: exclude,
      now,
      limit: MAX_CANDIDATES,
      warn,
    });
  // A replace prefers recipes it has not just removed, but would rather repeat one than come up short.
  let { candidates } = await retrieve([...keptRecipeIds, ...removedRecipeIds]);
  if (candidates.length < dates.length && removedRecipeIds.length > 0) {
    ({ candidates } = await retrieve(keptRecipeIds));
  }
  if (candidates.length === 0) return fail("no_candidates", 200);

  const shortBy = Math.max(dates.length - candidates.length, 0);
  const useDates = shortBy > 0 ? dates.slice(0, candidates.length) : dates;

  const composeProfile = composeProfileOf(me, spec.diets);
  const lastWeek = await store.lastWeekTitles(householdId, weekStart);
  let entries: ComposedEntry[];
  let composedBy: "model" | "fallback" = "fallback";
  let notes = "";

  const noCall = async (reason: string) => {
    // extract() throws before it logs when there is no key or no budget. Record the attempt, so
    // every plan leaves a row saying what happened to its model call.
    await log({
      householdId,
      kind: SUGGEST_COMPOSE_V1.kind,
      model: SUGGEST_COMPOSE_V1.model,
      promptVersion: SUGGEST_COMPOSE_V1.id,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      costUsd: 0,
      latencyMs: 0,
      ok: false,
      error: reason,
    });
  };

  if (!client) {
    await noCall("not_configured");
    entries = fallbackWeek(candidates, useDates, {
      servings: defaultServings(me),
      cuisines,
    });
  } else {
    try {
      const composed = await composeWeek(
        { weekStart, dates: useDates, candidates, profile: composeProfile, lastWeek },
        { client, log, guard, householdId },
      );
      entries = composed.entries;
      notes = composed.notes;
      composedBy = "model";
    } catch (err) {
      if (!(err instanceof ComposeError)) throw err;
      if (err.code === "cost_cap" || err.code === "not_configured") await noCall(err.code);
      warn(`suggest: composing fell back to ranking (${err.code})`);
      entries = fallbackWeek(candidates, useDates, {
        servings: defaultServings(me),
        cuisines,
      });
    }
  }

  const { planId, wrote } = await store.writePlan({
    householdId,
    weekStart,
    entries: entries.map((e) => ({
      date: e.date,
      recipeId: e.recipeId,
      servings: e.servings,
      why: e.why,
    })),
    ...(request.mode === "draft" ? { onlyIfEmpty: true } : { replaceDates }),
  });

  if (!wrote) {
    // Another draft for the same week finished first. Return what it wrote, checked the same way.
    const plan = await store.getPlan(householdId, weekStart);
    return existingPlanResponse(plan ?? { id: planId, entries: [] });
  }

  const response: Record<string, unknown> = {
    ok: true,
    planId,
    entries: entries.map(
      (e): SuggestEntry => ({
        date: e.date,
        slot: "dinner",
        recipeId: e.recipeId,
        servings: e.servings,
        why: e.why,
      }),
    ),
    composedBy,
  };
  if (notes) response.notes = notes;
  if (shortBy > 0) response.shortBy = shortBy;
  return json(response);
}

function entryFrom(
  entry: { date: string; recipeId: string; servings: number | null; why: string | null },
  fallbackServings: number,
): SuggestEntry {
  return {
    date: entry.date,
    slot: "dinner",
    recipeId: entry.recipeId,
    servings: Math.max(entry.servings ?? fallbackServings, 1),
    why: (entry.why ?? "").slice(0, 139),
  };
}

function composeProfileOf(member: MemberProfile, diets: readonly string[]): ComposeProfile {
  const p = member.preferences;
  return {
    portions: defaultServings(member),
    skill: p.skill,
    weeknightMinutes: p.weeknight_minutes ?? null,
    leftovers: p.leftovers,
    cuisines: p.cuisines ?? [],
    // The diets that steer taste but are not filters (keto, paleo, low carb) matter to the model.
    diets: [...new Set([...(p.diets ?? []), ...diets])],
    equipment: p.equipment ?? [],
    budgetPerWeekUsd: p.budget_per_week_usd ?? null,
    notes: p.notes,
  };
}

async function cardsFor(
  picked: readonly Candidate[],
  householdId: string,
  runtime: Runtime,
): Promise<CalibrationCard[]> {
  // Only this household's own folder is ever signed.
  const paths = picked
    .map((c) => c.imageUrl)
    .filter((url): url is string => Boolean(url) && !isHttpUrl(url as string))
    .filter((path) => path.startsWith(`${householdId}/`) && !path.includes(".."));
  const signed = paths.length > 0 ? await runtime.signImagePaths(paths) : new Map<string, string>();
  return picked.map((candidate) => {
    const url = candidate.imageUrl;
    const imageUrl = !url ? null : isHttpUrl(url) ? url : (signed.get(url) ?? null);
    return toCalibrationCard(candidate, imageUrl);
  });
}
