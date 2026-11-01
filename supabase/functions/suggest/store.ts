// Database access for the suggest function (WS06), all through one SqlRunner.
//
// The function connects as the database owner (SUPABASE_DB_URL), which bypasses Row Level
// Security. So every statement here names the household and checks it explicitly, the rule for
// service-role code in docs/02-data-model.md §RLS pattern and docs/05 §Access control. Membership
// is checked once, before anything else runs, and the household id in every later query comes
// from that check, never from a second reading of the request.
//
// Tables owned by others: meal_plans, meal_plan_entries, and recipe_feedback are WS04's. The
// columns used are listed in README.md. A missing recipe_feedback degrades ranking, nothing more.
import { ProfilePreferences } from "../../../packages/core/src/index.ts";
import type { AiRunRecord } from "../../../packages/llm/src/index.ts";
import type { SqlRunner } from "./candidates.ts";
import { FilterError, type FilterErrorCode } from "./filters.ts";
import { parseVector } from "./profile-embedding.ts";

export interface MemberProfile {
  userId: string;
  preferences: ProfilePreferences;
  onboardingStep: number;
  /** pgvector text, or null before the first build. */
  tasteEmbedding: string | null;
}

export interface PlanEntry {
  id: string;
  /** YYYY-MM-DD */
  date: string;
  slot: string;
  recipeId: string;
  servings: number | null;
  status: string;
  /** The one-line reason the suggestion gave. `notes` stays the person's own. */
  why: string | null;
}

export interface ExistingPlan {
  id: string;
  entries: PlanEntry[];
}

export interface NewEntry {
  date: string;
  recipeId: string;
  servings: number;
  /** The one-line reason, stored in meal_plan_entries.why. */
  why: string;
}

export interface WritePlanInput {
  householdId: string;
  weekStart: string;
  entries: readonly NewEntry[];
  /**
   * Write only when the week has no dinners yet. A draft that lost a race to another draft
   * writes nothing and reports `wrote: false`.
   */
  onlyIfEmpty?: boolean;
  /**
   * Which still-planned dinners to remove first: the given dates, or every one of the week when
   * null. Cooked and skipped dinners are never touched. Omit to remove nothing.
   */
  replaceDates?: readonly string[] | null;
}

function listOf(value: unknown, code: FilterErrorCode, name: string): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new FilterError(code, `${name} is not a list of strings`);
  }
  return value as string[];
}

/**
 * Reads one person's stored preferences for planning, without letting one bad field hide another.
 *
 * Every field is checked on its own and a field that fails is left out (`weeknight_minutes: 0`
 * loses the time limit, nothing else). Allergies and diets are read straight from the stored JSON
 * and never dropped: an entry outside the vocabulary stays in the list so `buildFilterSpec`
 * refuses the whole request (fail closed), and a value that is not a list throws. The database
 * CHECK on `profiles.preferences` already keeps both lists to the closed vocabulary, so this is
 * the second line of defense against a row that got past it. A housemate's allergy must never
 * fall out of the household's union because some other field of theirs is invalid.
 */
export function readStoredPreferences(raw: unknown): ProfilePreferences {
  const source =
    raw !== null && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  const result: Record<string, unknown> = {};
  for (const [key, schema] of Object.entries(ProfilePreferences.shape)) {
    if (key === "allergies" || key === "diets" || !(key in source)) continue;
    const field = schema.safeParse(source[key]);
    if (field.success && field.data !== undefined) result[key] = field.data;
  }
  const allergies = listOf(source.allergies, "unknown_allergen", "allergies");
  if (allergies) result.allergies = allergies;
  const diets = listOf(source.diets, "unknown_diet", "diets");
  if (diets) result.diets = diets;
  return result as ProfilePreferences;
}

interface MemberRow {
  user_id: string;
  preferences: unknown;
  onboarding_step: number | string | null;
  taste_embedding: string | null;
}

interface EntryRow {
  id: string;
  date: string;
  slot: string;
  recipe_id: string;
  servings: number | string | null;
  status: string;
  why: string | null;
}

export class SqlSuggestStore {
  constructor(private readonly sql: SqlRunner) {}

  async isMember(householdId: string, userId: string): Promise<boolean> {
    const rows = await this.sql.query<{ ok: number }>(
      `select 1 as ok
         from public.household_members hm
         join public.households h on h.id = hm.household_id and h.deleted_at is null
        where hm.household_id = $1::uuid and hm.user_id = $2::uuid`,
      [householdId, userId],
    );
    return rows.length > 0;
  }

  /** Every member's preferences. Allergies and diets of all of them apply to a shared plan. */
  async loadMembers(householdId: string): Promise<MemberProfile[]> {
    const rows = await this.sql.query<MemberRow>(
      `select p.user_id, p.preferences, p.onboarding_step, p.taste_embedding::text as taste_embedding
         from public.household_members hm
         join public.profiles p on p.user_id = hm.user_id
        where hm.household_id = $1::uuid
        order by hm.created_at, hm.user_id`,
      [householdId],
    );
    return rows.map((row) => ({
      userId: row.user_id,
      preferences: readStoredPreferences(row.preferences),
      onboardingStep: Number(row.onboarding_step ?? 0),
      tasteEmbedding: row.taste_embedding,
    }));
  }

  async getPlan(householdId: string, weekStart: string): Promise<ExistingPlan | null> {
    const plans = await this.sql.query<{ id: string }>(
      `select id from public.meal_plans where household_id = $1::uuid and week_start = $2::date`,
      [householdId, weekStart],
    );
    const plan = plans[0];
    if (!plan) return null;
    const rows = await this.sql.query<EntryRow>(
      `select e.id, e.date::text as date, e.slot::text as slot, e.recipe_id,
              e.servings, e.status::text as status, e.why
         from public.meal_plan_entries e
        where e.plan_id = $1::uuid and e.household_id = $2::uuid
        order by e.date, e.position nulls last, e.id`,
      [plan.id, householdId],
    );
    return {
      id: plan.id,
      entries: rows.map((row) => ({
        id: row.id,
        date: row.date,
        slot: row.slot,
        recipeId: row.recipe_id,
        servings: row.servings === null ? null : Number(row.servings),
        status: row.status,
        why: row.why,
      })),
    };
  }

  /** Titles of the dinners in the seven days before `weekStart`. */
  async lastWeekTitles(householdId: string, weekStart: string): Promise<string[]> {
    try {
      const rows = await this.sql.query<{ title: string }>(
        `select r.title
           from public.meal_plan_entries e
           join public.recipes r on r.id = e.recipe_id
          where e.household_id = $1::uuid and e.slot = 'dinner'
            and e.date >= ($2::date - 7) and e.date < $2::date
          order by e.date, e.id`,
        [householdId, weekStart],
      );
      return rows.map((row) => row.title);
    } catch (err) {
      console.warn(`suggest: last week unavailable (${err instanceof Error ? err.message : err})`);
      return [];
    }
  }

  /** What one person liked and passed on, newest first. Empty if the feedback table is missing. */
  async feedbackOf(
    householdId: string,
    userId: string,
  ): Promise<{
    liked: { title: string; embedding: number[] | null }[];
    skipped: string[];
  }> {
    try {
      const rows = await this.sql.query<{
        title: string;
        signal: string;
        embedding: string | null;
      }>(
        `select r.title, f.signal::text as signal, r.embedding::text as embedding
           from public.recipe_feedback f
           join public.recipes r on r.id = f.recipe_id
          where f.household_id = $1::uuid and f.user_id = $2::uuid
            and f.signal in ('like', 'skipped', 'dislike')
          order by f.created_at desc, f.id
          limit 80`,
        [householdId, userId],
      );
      return {
        liked: rows
          .filter((row) => row.signal === "like")
          .map((row) => ({ title: row.title, embedding: parseVector(row.embedding) })),
        skipped: rows.filter((row) => row.signal !== "like").map((row) => row.title),
      };
    } catch (err) {
      console.warn(`suggest: feedback unavailable (${err instanceof Error ? err.message : err})`);
      return { liked: [], skipped: [] };
    }
  }

  /** Recipes the person already answered, so calibration does not ask twice. */
  async answeredRecipeIds(householdId: string, userId: string): Promise<string[]> {
    try {
      const rows = await this.sql.query<{ recipe_id: string }>(
        `select distinct f.recipe_id
           from public.recipe_feedback f
          where f.household_id = $1::uuid and f.user_id = $2::uuid
            and f.signal in ('like', 'skipped', 'dislike')`,
        [householdId, userId],
      );
      return rows.map((row) => row.recipe_id);
    } catch {
      return [];
    }
  }

  /** Writes the vector the suggest function built. Clients cannot write this column. */
  async saveTasteEmbedding(userId: string, vectorText: string): Promise<void> {
    await this.sql.query(
      `update public.profiles set taste_embedding = $1::extensions.vector where user_id = $2::uuid`,
      [vectorText, userId],
    );
  }

  /**
   * Writes a week's dinners in one transaction. A concurrent call for the same household and
   * week waits on an advisory lock, so two drafts cannot both insert. Returns the plan id.
   */
  async writePlan(input: WritePlanInput): Promise<{ planId: string; wrote: boolean }> {
    return this.sql.transaction(async (tx) => {
      await tx.query(`select pg_advisory_xact_lock(hashtextextended($1::text, 0))`, [
        `suggest:${input.householdId}:${input.weekStart}`,
      ]);
      const plans = await tx.query<{ id: string }>(
        `insert into public.meal_plans (household_id, week_start)
         values ($1::uuid, $2::date)
         on conflict (household_id, week_start) do update set week_start = excluded.week_start
         returning id`,
        [input.householdId, input.weekStart],
      );
      const planId = plans[0]?.id;
      if (!planId) throw new Error("meal_plans insert returned no row");

      if (input.onlyIfEmpty) {
        const existing = await tx.query<{ n: number | string }>(
          `select count(*)::int as n from public.meal_plan_entries
            where plan_id = $1::uuid and household_id = $2::uuid and slot = 'dinner'`,
          [planId, input.householdId],
        );
        if (Number(existing[0]?.n ?? 0) > 0) return { planId, wrote: false };
      }
      if (input.replaceDates !== undefined) {
        await tx.query(
          `delete from public.meal_plan_entries
            where plan_id = $1::uuid and household_id = $2::uuid
              and slot = 'dinner' and status = 'planned'
              and ($3::date[] is null or date = any($3::date[]))`,
          [planId, input.householdId, input.replaceDates === null ? null : [...input.replaceDates]],
        );
      }
      if (input.entries.length > 0) {
        await tx.query(
          `insert into public.meal_plan_entries
             (plan_id, household_id, date, slot, recipe_id, servings, status, why, position)
           select $1::uuid, $2::uuid, t.d, 'dinner', t.r, t.s, 'planned', t.w, 0
             from unnest($3::date[], $4::uuid[], $5::int[], $6::text[]) as t(d, r, s, w)`,
          [
            planId,
            input.householdId,
            input.entries.map((e) => e.date),
            input.entries.map((e) => e.recipeId),
            input.entries.map((e) => Math.max(1, Math.round(e.servings))),
            input.entries.map((e) => e.why),
          ],
        );
      }
      return { planId, wrote: true };
    });
  }

  /**
   * Changes planned dinners that no longer fit the household, in one transaction: each `change`
   * puts a new recipe, servings, and reason on an existing entry (its date, position, and notes
   * stay), and each id in `remove` is deleted because nothing could take its place. Only entries
   * of this household that are still `planned` are touched; cooked and skipped dinners are history.
   */
  async changeEntries(input: {
    householdId: string;
    changes: readonly { entryId: string; recipeId: string; servings: number; why: string }[];
    remove: readonly string[];
  }): Promise<void> {
    if (input.changes.length === 0 && input.remove.length === 0) return;
    await this.sql.transaction(async (tx) => {
      if (input.changes.length > 0) {
        await tx.query(
          `update public.meal_plan_entries e
              set recipe_id = t.r, servings = t.s, why = t.w
             from unnest($2::uuid[], $3::uuid[], $4::int[], $5::text[]) as t(id, r, s, w)
            where e.id = t.id and e.household_id = $1::uuid and e.status = 'planned'`,
          [
            input.householdId,
            input.changes.map((c) => c.entryId),
            input.changes.map((c) => c.recipeId),
            input.changes.map((c) => Math.max(1, Math.round(c.servings))),
            input.changes.map((c) => c.why),
          ],
        );
      }
      if (input.remove.length > 0) {
        await tx.query(
          `delete from public.meal_plan_entries
            where id = any($2::uuid[]) and household_id = $1::uuid and status = 'planned'`,
          [input.householdId, [...input.remove]],
        );
      }
    });
  }

  /** Model and embedding spend recorded for the household since `sinceIso`, in USD. */
  async spentSince(householdId: string, sinceIso: string): Promise<number> {
    const rows = await this.sql.query<{ spent: number | string }>(
      `select coalesce(sum(cost_usd), 0) as spent
         from public.ai_runs
        where household_id = $1::uuid and created_at >= $2::timestamptz`,
      [householdId, sinceIso],
    );
    return Number(rows[0]?.spent ?? 0);
  }

  /** The household's own daily cap (WS15), or null when the row is not there. Throws without the column. */
  async householdCapUsd(householdId: string): Promise<number | null> {
    const rows = await this.sql.query<{ cap: number | string | null }>(
      `select ai_daily_cap_usd as cap from public.households where id = $1::uuid`,
      [householdId],
    );
    const cap = rows[0]?.cap;
    return cap === null || cap === undefined ? null : Number(cap);
  }

  async logAiRun(record: AiRunRecord): Promise<void> {
    await this.sql.query(
      `insert into public.ai_runs
         (household_id, kind, model, prompt_version, input_tokens, output_tokens,
          cache_read_tokens, cost_usd, latency_ms, ok, error)
       values ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        record.householdId,
        record.kind,
        record.model,
        record.promptVersion,
        record.inputTokens,
        record.outputTokens,
        record.cacheReadTokens,
        record.costUsd,
        Math.round(record.latencyMs),
        record.ok,
        // Error text can echo model output; keep the row small.
        record.error ? record.error.slice(0, 500) : null,
      ],
    );
  }
}
