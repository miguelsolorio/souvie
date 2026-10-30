// Pure rules for the onboarding flow (WS06): which screen comes next, whether a deep link may
// skip ahead, how a screen's answers are merged into profiles.preferences, and the draft a form
// starts from. No React Native imports, so Vitest runs it.
import {
  defaultPreferences,
  mergePreferences,
  nextOnboardingStep,
  ONBOARDING_STEP_COUNT,
  ONBOARDING_STEPS,
  ProfilePreferences,
} from "@mp/core";

export class OnboardingError extends Error {
  readonly code: "invalid_preferences" | "no_profile";
  constructor(code: OnboardingError["code"], message: string) {
    super(message);
    this.name = "OnboardingError";
    this.code = code;
  }
}

/** A route in the (onboarding) group. Groups are not part of the URL, so this is "/02-eaters". */
export function onboardingHref(route: string): string {
  return `/${route}`;
}

/** Where to send a person whose last completed screen is `completedStep`, or null when done. */
export function resumeHref(completedStep: number | null | undefined): string | null {
  const next = nextOnboardingStep(completedStep);
  return next ? onboardingHref(next.route) : null;
}

/** The screen number a route segment names, or null for any other segment. "03-diets-allergies" is 3. */
export function stepOfSegment(segment: string | undefined): number | null {
  const match = /^(\d{2})-/.exec(segment ?? "");
  if (!match) return null;
  const step = Number(match[1]);
  return ONBOARDING_STEPS.some((s) => s.step === step) ? step : null;
}

/**
 * Where to redirect from the screen being shown, or null to stay. Nobody may open a screen past
 * the one after their last completed screen (a typed URL cannot skip the allergy question), and
 * once onboarding is complete the group sends people home.
 *
 * The last screen is the exception: it marks onboarding complete and then plans the first week,
 * and the person has to stay to see how that went. Revisiting it later is harmless (it only offers
 * recipes not yet answered), so it is left open.
 */
export function guardOnboardingRoute(
  segment: string | undefined,
  completedStep: number | null | undefined,
  home = "/",
): string | null {
  const done = Math.min(Math.max(Math.trunc(completedStep ?? 0), 0), ONBOARDING_STEP_COUNT);
  const shown = stepOfSegment(segment);
  if (done >= ONBOARDING_STEP_COUNT) return shown === ONBOARDING_STEP_COUNT ? null : home;
  if (shown === null) return null;
  if (shown > done + 1) return resumeHref(done);
  return null;
}

/** The route before `step`, or null on the first screen. */
export function previousHref(step: number): string | null {
  const previous = ONBOARDING_STEPS.find((s) => s.step === step - 1);
  return previous ? onboardingHref(previous.route) : null;
}

/** The route after `step`, or null after the last screen. */
export function nextHref(step: number): string | null {
  const next = ONBOARDING_STEPS.find((s) => s.step === step + 1);
  return next ? onboardingHref(next.route) : null;
}

export interface StoredProfile {
  preferences: ProfilePreferences;
  onboardingStep: number;
  costcoMember: boolean | null;
}

export interface SaveStepInput {
  /** The screen number just completed. */
  step: number;
  /** The keys that screen writes. A key set to undefined is removed. */
  patch?: Partial<Record<string, unknown>>;
  /** Screen 7 only. */
  costcoMember?: boolean;
}

export interface ProfileUpdate {
  preferences: ProfilePreferences;
  onboarding_step: number;
  costco_member?: boolean;
}

/**
 * The row update for finishing a screen. Preferences are merged into what is stored, then the
 * whole object is validated, so a bad write never reaches the database. Progress never moves
 * backward: editing screen 3 from screen 5 leaves onboarding_step at 5.
 */
export function buildProfileUpdate(
  current: StoredProfile | null,
  input: SaveStepInput,
): ProfileUpdate {
  if (!current) throw new OnboardingError("no_profile", "Your profile has not loaded yet.");
  if (!Number.isInteger(input.step) || input.step < 1 || input.step > ONBOARDING_STEP_COUNT) {
    throw new OnboardingError("invalid_preferences", `step ${input.step} is not a screen`);
  }
  const merged = mergePreferences(current.preferences, input.patch ?? {});
  const parsed = ProfilePreferences.safeParse(merged);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new OnboardingError(
      "invalid_preferences",
      `${issue?.path.join(".") || "preferences"}: ${issue?.message ?? "invalid"}`,
    );
  }
  return {
    preferences: parsed.data,
    onboarding_step: Math.max(current.onboardingStep, input.step),
    ...(input.costcoMember === undefined ? {} : { costco_member: input.costcoMember }),
  };
}

/**
 * What a form starts with: the defaults, with anything the person already saved on top. It is
 * only ever used to fill fields. Saving writes the keys of one screen, never the whole draft, so a
 * default (an empty allergy list, say) is not stored as an answer.
 */
export function draftFromPreferences(
  saved: ProfilePreferences | null | undefined,
): ProfilePreferences {
  return { ...defaultPreferences(), ...(saved ?? {}) };
}

/** True when the person has answered the allergy question (an empty list counts: "no allergies"). */
export function hasAnsweredAllergies(saved: ProfilePreferences | null | undefined): boolean {
  return saved?.allergies !== undefined;
}

/**
 * The budget text box as a number. Empty means the person skipped it (null); something that is
 * not a plain amount is NaN, which the schema rejects. Up to two decimal places.
 */
export function parseBudgetText(text: string): number | null {
  const trimmed = text.trim();
  if (trimmed === "") return null;
  if (!/^\d{1,7}(\.\d{1,2})?$/.test(trimmed)) return Number.NaN;
  return Number(trimmed);
}

/** The list with `item` added, or removed if it is already there. Returns a new list. */
export function toggleItem<T>(list: readonly T[] | null | undefined, item: T): T[] {
  const current = list ?? [];
  return current.includes(item) ? current.filter((entry) => entry !== item) : [...current, item];
}
