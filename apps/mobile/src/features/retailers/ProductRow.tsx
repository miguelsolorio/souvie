import { BANNER_CHAIN_NAMES, type Product } from "@mp/retailers";
import { assertDisplayUnchanged, formatPrice } from "@mp/retailers/kroger/terms";
import { Image, Text, View } from "react-native";
import { Button } from "../../components/Button";
import { allergenLines, approvedForLabel, STOCK_LABEL } from "./labels";

/**
 * Banner branding (QFC, Fred Meyer) in the Add-to-Cart UI. Kroger's branding terms allow banner
 * logos only inside the Add-to-Cart experience and only while the app is not monetized (R22).
 * Before any billing, file a Kroger Partnership Request or set this to false. It is the single
 * switch: no other screen shows a banner mark, and marketing never does. No logo files ship with
 * the app today, so the banner shows as its name.
 */
export const showBannerLogos = true;

/**
 * One Kroger product in the Add-to-Cart UI, rendered exactly as returned: the whole name with no
 * truncation, Kroger's price, the image uncropped with nothing drawn over it. The terms guard runs
 * on every render; a product that drifted from what Kroger sent is not shown.
 */
export function ProductRow({
  product,
  chain,
  onAdd,
  adding = false,
  disabled = false,
}: {
  product: Product;
  /** The store's chain code, for the banner name. */
  chain?: string | null | undefined;
  onAdd?: () => void;
  adding?: boolean;
  disabled?: boolean;
}) {
  const priceText = product.price === null ? null : formatPrice(product.price);
  const promoText = product.promoPrice === null ? null : formatPrice(product.promoPrice);
  try {
    assertDisplayUnchanged(product, {
      name: product.name,
      price: priceText,
      promoPrice: promoText,
    });
  } catch (err) {
    if (__DEV__) console.warn("Kroger terms guard refused a product", (err as Error).message);
    return (
      <Text className="text-sm text-neutral-500">
        This product's details have expired or changed. Search again to see it.
      </Text>
    );
  }
  const banner = showBannerLogos && chain ? BANNER_CHAIN_NAMES[chain.toUpperCase()] : undefined;

  return (
    <View className="flex-row gap-3 rounded-xl border border-neutral-200 p-3">
      <View className="h-20 w-20 items-center justify-center rounded-lg bg-white">
        {product.imageUrl ? (
          <Image
            source={{ uri: product.imageUrl }}
            accessibilityIgnoresInvertColors
            resizeMode="contain"
            style={{ width: 80, height: 80 }}
          />
        ) : (
          <Text className="text-xs text-neutral-400">No image</Text>
        )}
      </View>
      <View className="flex-1 gap-1">
        {banner ? (
          <Text className="self-start rounded bg-neutral-100 px-1.5 py-0.5 text-xs font-semibold text-neutral-700">
            {banner}
          </Text>
        ) : null}
        <Text className="text-base text-neutral-900">{product.name}</Text>
        {product.size ? <Text className="text-sm text-neutral-600">{product.size}</Text> : null}
        <View className="flex-row flex-wrap items-baseline gap-2">
          {priceText ? (
            <Text
              className={`text-base font-semibold ${promoText ? "text-neutral-500 line-through" : "text-neutral-900"}`}
            >
              {priceText}
            </Text>
          ) : (
            <Text className="text-sm text-neutral-500">No price at this store</Text>
          )}
          {promoText ? (
            <Text className="text-base font-semibold text-brand">{promoText}</Text>
          ) : null}
          {product.soldBy === "WEIGHT" ? (
            <Text className="text-xs text-neutral-500">per lb, final price by weight</Text>
          ) : null}
        </View>
        <Text className="text-xs text-neutral-500">{STOCK_LABEL[product.stockLevel]}</Text>
        <Text className="text-xs text-neutral-500">{approvedForLabel(product.fulfillment)}</Text>
        {allergenLines(product).map((line) => (
          <Text key={line} className="text-xs text-neutral-600">
            {line}
          </Text>
        ))}
        {onAdd ? (
          <View className="mt-1 self-start">
            <Button
              label="Add"
              variant="secondary"
              loading={adding}
              disabled={disabled}
              onPress={onAdd}
              testID={`add-${product.id}`}
            />
          </View>
        ) : null}
      </View>
    </View>
  );
}
