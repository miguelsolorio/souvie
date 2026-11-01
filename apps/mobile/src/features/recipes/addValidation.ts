// What the add-recipe screen checks before it sends anything, and how it words what comes back
// (WS02 follow-up, 2026-10-31). Pure, so it is unit-tested; AddRecipe.tsx only draws the results.

import { HttpUrl, IMPORT_LIMITS } from "@mp/core";
import {
  type DuplicateMatch,
  ImportError,
  importErrorMessage,
  RecipeError,
  recipeErrorMessage,
} from "@mp/db";
import { normalizeSourceUrl, normalizeTitle, titleSearchPattern } from "@mp/recipe-import/dedupe";

/** Shown under the link box for anything that is not an http or https address. */
export const NOT_A_WEB_ADDRESS = "That is not a web address";

/**
 * Why the link box is wrong, or null when it is empty (nothing to say yet) or a web address. The
 * same `HttpUrl` check the recipe-import function applies, so a link that passes here is not
 * turned away as `invalid_request` there.
 */
export function linkProblem(raw: string): string | null {
  const text = raw.trim();
  if (text === "") return null;
  return HttpUrl.safeParse(text).success ? null : NOT_A_WEB_ADDRESS;
}

export interface PasteStatus {
  /** Whether the text is long enough to import. */
  ready: boolean;
  /** Why the button is off, or null when it is on. */
  hint: string | null;
}

/** The paste box keeps the function's minimum, and says what it is waiting for. */
export function pasteStatus(raw: string): PasteStatus {
  const min = IMPORT_LIMITS.textMin;
  const have = raw.trim().length;
  if (have >= min) return { ready: true, hint: null };
  if (have === 0) {
    return {
      ready: false,
      hint: `Paste at least ${min} characters: a title, the ingredients, and the steps.`,
    };
  }
  const missing = min - have;
  return {
    ready: false,
    hint: `${missing} more ${missing === 1 ? "character" : "characters"} needed. A recipe takes at least ${min}.`,
  };
}

/**
 * The text to show for a failure. A function error carries its own message, written for the
 * person (for example "That address uses an unusual port."); it is shown as it came, never
 * swapped for a generic line. Only an error with no message at all gets the generic one.
 */
export function describeFailure(cause: unknown): string {
  if (cause instanceof ImportError) return importErrorMessage(cause);
  if (cause instanceof RecipeError) return recipeErrorMessage(cause);
  if (cause instanceof Error && cause.message) return cause.message;
  return importErrorMessage(cause);
}

export interface ExistingRecipe {
  recipeId: string;
  matchedBy: DuplicateMatch;
}

/** The recipe the household already has, when a failure says so (an import or a save). */
export function duplicateOf(cause: unknown): ExistingRecipe | null {
  if (cause instanceof ImportError && cause.code === "duplicate") return cause.existing ?? null;
  if (cause instanceof RecipeError && cause.code === "duplicate") return cause.existing ?? null;
  return null;
}

/**
 * What identifies the recipe a save is about to make, for the household's duplicate check: its
 * link when it has one, else its title. Built from the same functions the recipe-import function
 * uses.
 */
export function duplicateCheckFor(title: string, sourceUrl?: string) {
  const key = sourceUrl ? normalizeSourceUrl(sourceUrl) : null;
  if (key) return { sourceUrlNormalized: key };
  const wanted = normalizeTitle(title);
  return {
    title: {
      pattern: titleSearchPattern(title),
      isSame: (candidate: string) => normalizeTitle(candidate) === wanted,
    },
  };
}
