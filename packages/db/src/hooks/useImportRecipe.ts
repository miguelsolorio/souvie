import {
  IMPORT_ERROR_CODES,
  IMPORT_ERROR_MESSAGES,
  type ImportErrorCode,
  type ImportRecipeRequest,
  ImportRecipeResponse,
  type ImportRecipeSuccess,
} from "@mp/core";
import { FunctionsHttpError } from "@supabase/supabase-js";
import { type QueryClient, useMutation, useQueryClient } from "@tanstack/react-query";
import type { MpClient } from "../client";
import { useSupabase } from "../context";
import { type DuplicateMatch, parseAfterWrite, RECIPE_IMAGE_BUCKET } from "./useRecipe";

const KNOWN_FAILURES: readonly string[] = IMPORT_ERROR_CODES;

/** A failed import, with the code the recipe-import Edge Function returned. */
export class ImportError extends Error {
  readonly code: ImportErrorCode;
  readonly jobId: string | undefined;
  /** For `duplicate`: the household's existing recipe and how it was recognised. */
  readonly existing: { recipeId: string; matchedBy: DuplicateMatch } | undefined;

  constructor(
    code: ImportErrorCode,
    message?: string,
    jobId?: string,
    existing?: { recipeId: string; matchedBy: DuplicateMatch },
  ) {
    super(message ?? IMPORT_ERROR_MESSAGES[code]);
    this.name = "ImportError";
    this.code = code;
    this.jobId = jobId;
    this.existing = existing;
  }
}

/**
 * Text for the person using the app: the function's own message for the failure (it is written for
 * them and is more specific than the table, for example "That address uses an unusual port."), or
 * the table's text for the code when the function sent none. Unknown errors get the generic line.
 */
export function importErrorMessage(error: unknown): string {
  if (error instanceof ImportError) return error.message || IMPORT_ERROR_MESSAGES[error.code];
  return IMPORT_ERROR_MESSAGES.internal_error;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** The failure a response body describes, or null when the body is not a recipe-import failure. */
function failureFromBody(body: unknown): ImportError | null {
  const record = asRecord(body);
  if (record?.ok !== false || typeof record.error !== "string") return null;
  const message = typeof record.message === "string" && record.message ? record.message : undefined;
  const jobId = typeof record.jobId === "string" ? record.jobId : undefined;
  if (!KNOWN_FAILURES.includes(record.error)) {
    return new ImportError("internal_error", message, jobId);
  }
  const code = record.error as ImportErrorCode;
  const existing =
    code === "duplicate" && typeof record.recipeId === "string"
      ? {
          recipeId: record.recipeId,
          matchedBy: (record.matchedBy === "url" ? "url" : "title") as DuplicateMatch,
        }
      : undefined;
  return new ImportError(code, message, jobId, existing);
}

/**
 * What an HTTP error that carried no recipe-import body means. The gateway answers a missing or
 * expired token itself, before the function runs, with its own JSON.
 */
function failureFromStatus(status: number | undefined, body: unknown): ImportError {
  const detail = asRecord(body);
  const message =
    typeof detail?.message === "string" && detail.message ? detail.message : undefined;
  if (status === 401) return new ImportError("unauthorized");
  if (status === 413) return new ImportError("invalid_request", "The request is too large.");
  if (status === 429) return new ImportError("rate_limited");
  return new ImportError("internal_error", message);
}

/**
 * Calls the recipe-import Edge Function. Resolves with the success body, or throws an
 * `ImportError` carrying the function's error code and message (the function answers HTTP 200 for
 * most failures, and HTTP 4xx/5xx with the same JSON body for problems with the request itself).
 */
export async function importRecipe(
  client: MpClient,
  request: ImportRecipeRequest,
): Promise<ImportRecipeSuccess> {
  const { data, error } = await client.functions.invoke("recipe-import", { body: request });

  let body: unknown = data;
  let status: number | undefined;
  if (error) {
    if (error instanceof FunctionsHttpError) {
      status = (error.context as { status?: number }).status;
      body = await error.context.json().catch(() => null);
    } else {
      throw new ImportError(
        "internal_error",
        "We could not reach the server. Check your connection.",
      );
    }
  }

  const failure = failureFromBody(body);
  if (failure) throw failure;
  if (error) throw failureFromStatus(status, body);

  const parsed = ImportRecipeResponse.safeParse(body);
  if (!parsed.success || !parsed.data.ok) throw new ImportError("internal_error");
  return parsed.data;
}

/**
 * Imports, and for a saved recipe waits for its ingredient lines to be matched (see
 * `parseAfterWrite` in useRecipe.ts) so the recipe opens matched. A draft (`save: false`) has no
 * recipe yet and is matched when the person saves it.
 */
export async function importRecipeAndMatch(
  client: MpClient,
  queryClient: QueryClient,
  request: ImportRecipeRequest,
): Promise<ImportRecipeSuccess> {
  const result = await importRecipe(client, request);
  if (result.recipeId) await parseAfterWrite(client, queryClient, result.recipeId);
  return result;
}

export function useImportRecipe() {
  const client = useSupabase();
  const queryClient = useQueryClient();

  return useMutation<ImportRecipeSuccess, ImportError, ImportRecipeRequest>({
    mutationFn: (request) => importRecipeAndMatch(client, queryClient, request),
    onSuccess: async (result) => {
      // Only a saved recipe changes the list. A draft is saved later, by createRecipe.
      if (result.recipeId) await queryClient.invalidateQueries({ queryKey: ["recipes"] });
    },
  });
}

// ---------------------------------------------------------------------------------------
// Photos
// ---------------------------------------------------------------------------------------

export const RECIPE_IMAGE_MAX_BYTES = 5 * 1024 * 1024;

export type RecipeImageContentType = "image/jpeg" | "image/png" | "image/webp";

const EXTENSION: Record<RecipeImageContentType, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

/** `<household_id>/<file_id>.<ext>`, the only place a household's recipe-images policy allows. */
export function recipeImagePath(
  householdId: string,
  fileId: string,
  contentType: RecipeImageContentType,
): string {
  return `${householdId}/${fileId}.${EXTENSION[contentType]}`;
}

/**
 * Uploads a photo of a recipe card to the household's folder and returns the stored path, which
 * is what `importRecipe({ kind: "image", input: { path } })` and a saved photo recipe use.
 */
export async function uploadRecipeImage(
  client: MpClient,
  args: {
    householdId: string;
    fileId: string;
    bytes: ArrayBuffer | Uint8Array;
    contentType: RecipeImageContentType;
  },
): Promise<string> {
  const size = args.bytes.byteLength;
  if (size === 0 || size > RECIPE_IMAGE_MAX_BYTES) {
    throw new Error("Pick a photo under 5 MB.");
  }
  const path = recipeImagePath(args.householdId, args.fileId, args.contentType);
  const { error } = await client.storage
    .from(RECIPE_IMAGE_BUCKET)
    .upload(path, args.bytes, { contentType: args.contentType, upsert: false });
  if (error) throw new Error(error.message);
  return path;
}
