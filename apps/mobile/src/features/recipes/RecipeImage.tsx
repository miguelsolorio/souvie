import { useRecipeImageUrl } from "@mp/db";
import { Image, Text, View } from "react-native";

/**
 * A recipe's picture. An external link is shown as is; a path in the private recipe-images bucket
 * becomes a short-lived signed URL. With no picture, or while the URL loads, it shows the first
 * letter of the title.
 */
export function RecipeImage({
  imageUrl,
  title,
  width,
  height,
}: {
  imageUrl: string | null | undefined;
  title: string;
  width: number;
  height: number;
}) {
  const url = useRecipeImageUrl(imageUrl);
  const box = { width, height, borderRadius: 12 };

  if (url) {
    return (
      <Image
        source={{ uri: url }}
        style={box}
        resizeMode="cover"
        accessibilityLabel={`Picture of ${title}`}
      />
    );
  }
  return (
    <View
      style={box}
      className="items-center justify-center bg-brand/10"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      <Text
        className="font-semibold text-brand"
        style={{ fontSize: Math.min(width, height) * 0.4 }}
      >
        {title.trim().charAt(0).toUpperCase() || "R"}
      </Text>
    </View>
  );
}
