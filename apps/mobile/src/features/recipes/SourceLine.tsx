import { type RecipeSourceType, recipeSourceDomain } from "@mp/core";
import * as WebBrowser from "expo-web-browser";
import { Pressable, Text, View } from "react-native";

const ORIGIN_TEXT: Partial<Record<RecipeSourceType, string>> = {
  photo: "Added from a photo",
  text: "Added from pasted text",
  ai: "Suggested by the app",
};

/**
 * Where a recipe came from. An imported recipe always shows its source domain as a link back to
 * the page or post (docs/05 §Recipe content, acceptance criterion 9): there is no setting that
 * hides it. A caption import says so, because only the caption text was read.
 */
export function SourceLine({
  sourceType,
  sourceUrl,
}: {
  sourceType: RecipeSourceType;
  sourceUrl: string | null;
}) {
  const domain = recipeSourceDomain(sourceUrl);

  if (sourceUrl && /^https?:\/\//i.test(sourceUrl)) {
    return (
      <View className="flex-row flex-wrap items-center">
        <Text className="text-sm text-neutral-600">Source: </Text>
        <Pressable
          testID="recipe-source-link"
          accessibilityRole="link"
          accessibilityLabel={`Open ${domain ?? sourceUrl}`}
          onPress={() => void WebBrowser.openBrowserAsync(sourceUrl)}
          hitSlop={8}
        >
          <Text className="text-sm font-medium text-brand underline">{domain ?? sourceUrl}</Text>
        </Pressable>
        {sourceType === "video" ? (
          <Text className="text-sm text-neutral-600"> (from the post's caption)</Text>
        ) : null}
      </View>
    );
  }

  const text = ORIGIN_TEXT[sourceType];
  return text ? <Text className="text-sm text-neutral-600">{text}</Text> : null;
}
