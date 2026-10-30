import {
  IMPORT_ERROR_MESSAGES,
  type ImportErrorCode,
  type ImportRecipeRequest,
  ImportRecipeResponse,
  type ImportRecipeSuccess,
} from "@mp/core";
import { FunctionsHttpError } from "@supabase/supabase-js";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { MpClient } from "../client";
import { useSupabase } from "../context";
import { RECIPE_IMAGE_BUCKET } from "./useRecipe";

/** A failed import, with the code the recipe-import Edge Function returned. */
export class ImportError extends Error {
  readonly code: ImportErrorCode;
  readonly jobId: string | undefined;

  constructor(code: ImportErrorCode, message?: string, jobId?: string) {
    super(message ?? IMPORT_ERROR_MESSAGES[code]);
    this.name = "ImportError";
    this.code = code;
    this.jobId = jobId;
  }
}

/** Text for the person using the app. Unknown errors get the generic line. */
export function importErrorMessage(error: unknown): string {
  if (error instanceof ImportError) return IMPORT_ERROR_MESSAGES[error.code];
  return IMPORT_ERROR_MESSAGES.internal_error;
}

/**
 * Calls the recipe-import Edge Function. Resolves with the success body, or throws an
 * `ImportError` carrying the function's error code (the function answers HTTP 200 for most
 * failures, and HTTP 4xx/5xx with the same JSON body for problems with the request itself).
 */
export async function importRecipe(
  client: MpClient,
  request: ImportRecipeRequest,
): Promise<ImportRecipeSuccess> {
  const { data, error } = await client.functions.invoke("recipe-import", { body: request });

  let body: unknown = data;
  if (error) {
    if (error instanceof FunctionsHttpError) {
      body = await error.context.json().catch(() => null);
    } else {
      throw new ImportError(
        "internal_error",
        "We could not reach the server. Check your connection.",
      );
    }
  }

  const parsed = ImportRecipeResponse.safeParse(body);
  if (!parsed.success) throw new ImportError("internal_error");
  if (!parsed.data.ok) {
    throw new ImportError(parsed.data.error, parsed.data.message, parsed.data.jobId);
  }
  return parsed.data;
}

export function useImportRecipe() {
  const client = useSupabase();
  const queryClient = useQueryClient();

  return useMutation<ImportRecipeSuccess, ImportError, ImportRecipeRequest>({
    mutationFn: (request) => importRecipe(client, request),
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
