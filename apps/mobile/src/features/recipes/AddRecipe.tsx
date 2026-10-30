import { type ImportErrorCode, type RecipeSourceType, recipeSourceDomain } from "@mp/core";
import {
  ImportError,
  importErrorMessage,
  type RecipeDraft,
  recipeErrorMessage,
  uploadRecipeImage,
  useCreateRecipe,
  useHousehold,
  useImportRecipe,
  useSupabase,
} from "@mp/db";
import { hasEnoughCaptionText, isVideoPlatformUrl } from "@mp/recipe-import/share";
import * as Crypto from "expo-crypto";
import { useRouter } from "expo-router";
import { useEffect, useState, useSyncExternalStore } from "react";
import { Pressable, Text, View } from "react-native";
import { Button } from "../../components/Button";
import { ErrorText, Section } from "../../components/Screen";
import { TextField } from "../../components/TextField";
import { draftFromNormalized, emptyForm, formFromDraft } from "./draft";
import { MultilineField } from "./MultilineField";
import { pickRecipePhoto } from "./pickRecipePhoto";
import { RecipeForm } from "./RecipeForm";
import { RecipeImage } from "./RecipeImage";
import {
  peekSharedInput,
  type SharedInput,
  subscribeSharedInput,
  takeSharedInput,
} from "./sharedInbox";

type Tab = "link" | "paste" | "photo" | "write";

const TABS: ReadonlyArray<{ id: Tab; label: string }> = [
  { id: "link", label: "Link" },
  { id: "paste", label: "Paste" },
  { id: "photo", label: "Photo" },
  { id: "write", label: "Write" },
];

/** Failures after which pasting the text or photographing the recipe is the sensible next step. */
const TRY_ANOTHER_WAY: ReadonlySet<ImportErrorCode> = new Set([
  "blocked",
  "video_platform",
  "fetch_failed",
  "not_html",
  "too_large",
  "no_recipe_found",
  "model_failed",
  "model_unavailable",
]);

interface Review {
  draft: RecipeDraft;
  sourceType: RecipeSourceType;
  sourceUrl?: string | undefined;
  note: string;
}

/**
 * The add-recipe screen body: four ways in (a link, pasted text, a photo, typing it), plus the
 * caption flow for something shared in from another app. A link or pasted text is saved straight
 * away; a photo or a caption comes back as a draft the person checks and edits first.
 */
export function AddRecipe() {
  const router = useRouter();
  const client = useSupabase();
  const household = useHousehold();
  const householdId = household.data?.id;
  const importRecipe = useImportRecipe();
  const createRecipe = useCreateRecipe();

  const [tab, setTab] = useState<Tab>("link");
  const [url, setUrl] = useState("");
  const [pasted, setPasted] = useState("");
  const [review, setReview] = useState<Review | null>(null);
  const [reviewKey, setReviewKey] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<ImportErrorCode | null>(null);
  const [working, setWorking] = useState<string | null>(null);

  // Something shared in from another app: a caption to read, or a link to import.
  const [shared, setShared] = useState<SharedInput | null>(null);
  const [caption, setCaption] = useState("");
  const waiting = useSyncExternalStore(subscribeSharedInput, peekSharedInput, peekSharedInput);
  useEffect(() => {
    if (!waiting) return;
    const taken = takeSharedInput();
    if (!taken) return;
    if (taken.url && !isVideoPlatformUrl(taken.url)) {
      // An ordinary page: the link tab handles it.
      setTab("link");
      setUrl(taken.url);
      setShared(null);
    } else {
      setShared(taken);
      setCaption(taken.text);
    }
    setError(null);
    setErrorCode(null);
    setReview(null);
  }, [waiting]);

  const busy = importRecipe.isPending || createRecipe.isPending || working !== null;

  function fail(cause: unknown) {
    setError(
      cause instanceof ImportError
        ? importErrorMessage(cause)
        : cause instanceof Error && cause.message
          ? cause.message
          : importErrorMessage(cause),
    );
    setErrorCode(cause instanceof ImportError ? cause.code : null);
  }

  function clearError() {
    setError(null);
    setErrorCode(null);
  }

  function openRecipe(id: string | undefined) {
    if (!id) {
      fail(new ImportError("internal_error"));
      return;
    }
    router.replace(`/recipes/${id}`);
  }

  function switchTab(next: Tab) {
    clearError();
    setTab(next);
  }

  // --- link and paste: saved straight away -------------------------------------------------

  function importLink() {
    clearError();
    importRecipe.mutate(
      { kind: "url", input: url.trim(), ...(householdId ? { householdId } : {}) },
      { onSuccess: (result) => openRecipe(result.recipeId), onError: fail },
    );
  }

  function importPasted() {
    clearError();
    importRecipe.mutate(
      { kind: "text", input: pasted.trim(), ...(householdId ? { householdId } : {}) },
      { onSuccess: (result) => openRecipe(result.recipeId), onError: fail },
    );
  }

  // --- photo: a draft to check -------------------------------------------------------------

  async function importPhoto(source: "camera" | "library") {
    clearError();
    try {
      setWorking("Getting the photo ready");
      const photo = await pickRecipePhoto(source);
      if (!photo) return;
      if (!householdId) throw new Error("Create or join a household first.");
      setWorking("Uploading the photo");
      const path = await uploadRecipeImage(client, {
        householdId,
        fileId: Crypto.randomUUID(),
        bytes: photo.bytes,
        contentType: photo.contentType,
      });
      setWorking("Reading the recipe");
      const result = await importRecipe.mutateAsync({
        kind: "image",
        input: { path },
        save: false,
        householdId,
      });
      if (!result.draft) throw new ImportError("internal_error");
      showReview({
        draft: draftFromNormalized(result.draft),
        sourceType: "photo",
        note: "Here is what we read from the photo. Check the ingredients and steps, fix anything that is off, then save.",
      });
    } catch (cause) {
      fail(cause);
    } finally {
      setWorking(null);
    }
  }

  // --- caption: a draft to check -----------------------------------------------------------

  function readCaption() {
    if (!shared) return;
    clearError();
    importRecipe.mutate(
      {
        kind: "caption",
        input: caption.trim(),
        save: false,
        ...(shared.url ? { sourceUrl: shared.url } : {}),
        ...(householdId ? { householdId } : {}),
      },
      {
        onSuccess: (result) => {
          if (!result.draft) return fail(new ImportError("internal_error"));
          showReview({
            draft: draftFromNormalized(result.draft),
            sourceType: shared.url ? "video" : "text",
            sourceUrl: shared.url ?? undefined,
            note: "Here is what we read from the caption. Captions often skip steps or amounts, so check it before you save.",
          });
        },
        onError: fail,
      },
    );
  }

  // --- review and write --------------------------------------------------------------------

  function showReview(next: Review) {
    setReviewKey((k) => k + 1);
    setReview(next);
  }

  function save(draft: RecipeDraft, sourceType: RecipeSourceType, sourceUrl?: string) {
    if (!householdId) return;
    clearError();
    createRecipe.mutate(
      { householdId, draft, sourceType, ...(sourceUrl ? { sourceUrl } : {}) },
      {
        onSuccess: (id) => router.replace(`/recipes/${id}`),
        onError: (cause) => setError(recipeErrorMessage(cause)),
      },
    );
  }

  if (review) {
    return (
      <Section title="Check the recipe">
        <Text className="text-base text-neutral-700">{review.note}</Text>
        {review.draft.imageUrl && review.sourceType === "photo" ? (
          <RecipeImage
            imageUrl={review.draft.imageUrl}
            title={review.draft.title}
            width={160}
            height={120}
          />
        ) : null}
        <RecipeForm
          key={reviewKey}
          initial={formFromDraft(review.draft)}
          submitLabel="Save recipe"
          submitting={createRecipe.isPending}
          error={error}
          cancelLabel="Start over"
          onCancel={() => {
            setReview(null);
            clearError();
          }}
          onSubmit={(draft) => save(draft, review.sourceType, review.sourceUrl)}
        />
      </Section>
    );
  }

  const urlIsVideo = isVideoPlatformUrl(url);
  const captionEnough = hasEnoughCaptionText(caption);
  const sharedDomain = recipeSourceDomain(shared?.url);

  if (shared) {
    return (
      <Section title="Shared with Souvie">
        {sharedDomain ? (
          <Text className="text-sm text-neutral-600">From {sharedDomain}</Text>
        ) : null}
        <MultilineField
          label="Caption"
          value={caption}
          onChangeText={setCaption}
          lines={6}
          maxLength={10000}
          editable={!busy}
          testID="shared-caption"
        />
        {captionEnough ? (
          <Button
            testID="read-caption"
            label="Read the recipe"
            loading={importRecipe.isPending}
            disabled={busy}
            onPress={readCaption}
          />
        ) : (
          <View
            testID="caption-not-enough"
            accessibilityRole="alert"
            className="gap-3 rounded-xl border border-amber-300 bg-amber-50 p-4"
          >
            <Text className="text-base font-semibold text-neutral-900">
              Not enough text in the caption
            </Text>
            <Text className="text-sm text-neutral-700">
              A recipe needs at least two ingredient lines, and this caption has fewer than that.
              Videos are never downloaded, so take a photo of the recipe or paste it instead.
            </Text>
            <Button
              testID="shared-take-photo"
              label="Take a photo"
              variant="secondary"
              onPress={() => {
                setShared(null);
                switchTab("photo");
              }}
            />
            <Button
              testID="shared-paste"
              label="Paste the recipe"
              variant="secondary"
              onPress={() => {
                setPasted(caption);
                setShared(null);
                switchTab("paste");
              }}
            />
          </View>
        )}
        <Button
          label="Dismiss"
          variant="ghost"
          disabled={busy}
          onPress={() => {
            setShared(null);
            clearError();
          }}
        />
        <ErrorText>{error}</ErrorText>
      </Section>
    );
  }

  return (
    <View className="gap-6">
      <View accessibilityRole="tablist" className="flex-row border-b border-neutral-200">
        {TABS.map((item) => {
          const selected = item.id === tab;
          return (
            <Pressable
              key={item.id}
              testID={`tab-${item.id}`}
              accessibilityRole="tab"
              accessibilityState={{ selected }}
              onPress={() => switchTab(item.id)}
              className={`flex-1 items-center border-b-2 py-3 ${
                selected ? "border-brand" : "border-transparent"
              }`}
            >
              <Text
                className={`text-base ${selected ? "font-semibold text-brand" : "text-neutral-600"}`}
              >
                {item.label}
              </Text>
            </Pressable>
          );
        })}
      </View>

      {tab === "link" ? (
        <View className="gap-3">
          <TextField
            label="Recipe link"
            value={url}
            onChangeText={setUrl}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            placeholder="https://"
            editable={!busy}
            helper="We read the page's recipe and keep a link back to it."
            testID="import-url-input"
          />
          {urlIsVideo ? (
            <Text accessibilityRole="alert" className="text-sm text-amber-800">
              We do not download videos. Share the post into this app to import its caption, or
              paste the recipe text.
            </Text>
          ) : null}
          <Button
            testID="import-url"
            label="Import recipe"
            loading={importRecipe.isPending}
            disabled={busy || urlIsVideo || url.trim().length < 8}
            onPress={importLink}
          />
        </View>
      ) : null}

      {tab === "paste" ? (
        <View className="gap-3">
          <MultilineField
            label="Recipe text"
            value={pasted}
            onChangeText={setPasted}
            lines={10}
            maxLength={30000}
            editable={!busy}
            placeholder="Paste the recipe here: a title, the ingredients, and the steps."
            testID="import-text-input"
          />
          <Button
            testID="import-text"
            label="Import recipe"
            loading={importRecipe.isPending}
            disabled={busy || pasted.trim().length < 20}
            onPress={importPasted}
          />
        </View>
      ) : null}

      {tab === "photo" ? (
        <View className="gap-3">
          <Text className="text-base text-neutral-700">
            Photograph a recipe card or a cookbook page. You will check what we read before it is
            saved.
          </Text>
          <Button
            testID="photo-camera"
            label="Take a photo"
            loading={working !== null}
            disabled={busy}
            onPress={() => void importPhoto("camera")}
          />
          <Button
            testID="photo-library"
            label="Choose a photo"
            variant="secondary"
            disabled={busy}
            onPress={() => void importPhoto("library")}
          />
          {working ? <Text className="text-sm text-neutral-600">{working}...</Text> : null}
        </View>
      ) : null}

      {tab === "write" ? (
        <RecipeForm
          initial={emptyForm()}
          submitLabel="Save recipe"
          submitting={createRecipe.isPending}
          error={error}
          onSubmit={(draft) => save(draft, "manual")}
        />
      ) : null}

      {tab !== "write" ? <ErrorText>{error}</ErrorText> : null}

      {errorCode && TRY_ANOTHER_WAY.has(errorCode) && tab !== "write" ? (
        <View className="gap-2">
          <Text className="text-sm text-neutral-600">Another way in:</Text>
          {tab !== "paste" ? (
            <Button
              label="Paste the recipe text"
              variant="secondary"
              onPress={() => switchTab("paste")}
            />
          ) : null}
          {tab !== "photo" ? (
            <Button
              label="Take a photo of it"
              variant="secondary"
              onPress={() => switchTab("photo")}
            />
          ) : null}
          <Button label="Type it in" variant="secondary" onPress={() => switchTab("write")} />
        </View>
      ) : null}
    </View>
  );
}
