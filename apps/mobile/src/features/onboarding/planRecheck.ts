// Re-checking the planned weeks after someone edits their allergies or diets (WS06). Pure helpers,
// so Vitest runs them; the hook that wires them to the network is in useSuggestWeek.ts.
//
// The `suggest` function already re-checks a week's planned dinners whenever `draft` finds the week
// already planned (it replaces any dinner the household's allergies or diets now rule out, or
// removes it when nothing fits). Nothing else asks, so editing food preferences does: once for the
// current week and once for the coming week.
import { type SuggestPlanResponse, shiftWeek, weekStartFor } from "@mp/core";

/** The screens whose save triggers a re-check in edit mode: 3 is diets and allergies, 4 is tastes. */
export const RECHECK_STEPS: readonly number[] = [3, 4];

/** True when finishing `step` should re-check the planned weeks: only while editing, only these. */
export function shouldRecheckPlan(step: number, editing: boolean): boolean {
  return editing && RECHECK_STEPS.includes(step);
}

/** The two Mondays to check: this week's (`weekStartFor(today)`) and the coming week's. */
export function recheckWeekStarts(now: Date): string[] {
  const thisWeek = weekStartFor(now);
  return [thisWeek, shiftWeek(thisWeek, 1)];
}

/** What the person is told: the week changed, or already fit. */
export type RecheckNotice = "updated" | "same";

const NOTICE_PARAM = new Set<string>(["updated", "same"]);

/** The notice a `notice` query parameter carries, or null for anything else. */
export function noticeFromParam(value: string | string[] | undefined): RecheckNotice | null {
  const first = Array.isArray(value) ? value[0] : value;
  return first !== undefined && NOTICE_PARAM.has(first) ? (first as RecheckNotice) : null;
}

/** One result out of two: "updated" wins, because a later "same" must not hide an earlier change. */
export function combineNotice(
  earlier: RecheckNotice | null,
  later: RecheckNotice | null,
): RecheckNotice | null {
  if (earlier === "updated" || later === "updated") return "updated";
  return later ?? earlier;
}

/** The one line shown to the person. */
export function noticeText(notice: RecheckNotice): string {
  return notice === "updated" ? "Your week was updated." : "Your plan already fits.";
}

/** `href` with a `notice` query parameter, or `href` unchanged without one. */
export function withNotice(href: string, notice: RecheckNotice | null): string {
  if (!notice) return href;
  return `${href}${href.includes("?") ? "&" : "?"}notice=${notice}`;
}

export interface RecheckDeps {
  /** True when the week already has dinners planned. A week with none is left alone. */
  hasDinners(weekStart: string): Promise<boolean>;
  /** Calls `suggest` with mode "draft" for the week. */
  draft(weekStart: string): Promise<SuggestPlanResponse>;
}

export interface RecheckResult {
  notice: RecheckNotice;
  /** The weeks `draft` was called for. */
  checked: string[];
  replaced: number;
  removed: number;
}

/**
 * Re-checks this week and the coming week, one after the other. A week with no dinners is skipped:
 * `draft` on an empty week would compose a whole new plan, and editing a preference should not
 * plan weeks nobody asked for. A failure stops the run and is thrown, so the person can retry;
 * running it again is harmless because a week that already fits is not touched.
 */
export async function recheckPlans(deps: RecheckDeps, now: Date): Promise<RecheckResult> {
  const checked: string[] = [];
  let replaced = 0;
  let removed = 0;
  for (const weekStart of recheckWeekStarts(now)) {
    if (!(await deps.hasDinners(weekStart))) continue;
    const response = await deps.draft(weekStart);
    checked.push(weekStart);
    replaced += response.repaired?.replaced ?? 0;
    removed += response.repaired?.removed ?? 0;
  }
  return { notice: replaced + removed > 0 ? "updated" : "same", checked, replaced, removed };
}
