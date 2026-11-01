// Dev-only preview of the shopping review screen (WS09): the proposed cart with sample lines, so
// the layout can be checked in a browser with no backend. The products are MockRetailer's
// fictional catalog, typed out here; no adapter is bundled. Reach it at /run-preview in a
// development build. Release builds redirect home.
import { Redirect } from "expo-router";
import { useMemo, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Button } from "../../src/components/Button";
import { preview, type ReviewDraft, type RunItem } from "../../src/features/shopping/logic";
import { ProposedCart } from "../../src/features/shopping/ProposedCart";
import { TranscriptView } from "../../src/features/shopping/TranscriptView";

function sample(
  position: number,
  section: string,
  display: string,
  product: [string, string, number, number] | null,
  extra: Partial<RunItem> = {},
): RunItem {
  const [name, size, price, qty] = product ?? ["", "", 0, 0];
  return {
    id: `preview-${position}`,
    run_id: "preview",
    position,
    display_name: display,
    section,
    product_id: product ? `00990${position}` : null,
    upc: null,
    product_name: product ? name : null,
    size: product ? size : null,
    qty: product ? qty : null,
    unit_price_usd: product ? price : null,
    line_total_usd: product ? Math.round(price * qty * 100) / 100 : null,
    status: product ? "matched" : "unmatched",
    alternatives: null,
    user_decision: null,
    flags: [],
    reason: null,
    cart_qty: 0,
    delta_result: null,
    ...extra,
  };
}

const ITEMS: RunItem[] = [
  sample(0, "produce", "Yellow onions", ["Harbor Fields Yellow Onions", "3 lb bag", 3.63, 1]),
  sample(1, "produce", "Garlic", ["Garlic", "3 ct", 1.93, 1]),
  sample(2, "meat", "Boneless skinless chicken thighs", [
    "Mock Market Boneless Skinless Chicken Thighs",
    "1 lb",
    3.42,
    2,
  ]),
  sample(3, "dairy", "Whole milk", ["Northfork Creamery Whole Milk", "1 gal", 4.43, 1], {
    alternatives: [
      {
        product_id: "0099020000004",
        upc: null,
        name: "Northfork Creamery Organic Whole Milk",
        size: "1/2 gal",
        price: 5.16,
        qty: 2,
      },
    ],
  }),
  sample(4, "pantry", "Chicken broth", ["Puget Pantry Chicken Broth", "32 fl oz", 2.26, 1], {
    alternatives: [
      {
        product_id: "0099040000027",
        upc: null,
        name: "Larkspur Kitchen Low Sodium Chicken Broth",
        size: "32 fl oz",
        price: 2.41,
        qty: 1,
      },
    ],
  }),
  sample(5, "pantry", "Penne (gluten-free)", null, {
    flags: [
      {
        kind: "qualifier",
        detail: "No product here says gluten-free. Pick one yourself or leave it out.",
      },
    ],
    alternatives: [
      {
        product_id: "0099040000019",
        upc: null,
        name: "Mock Market Penne Rigate",
        size: "16 oz",
        price: 1.52,
        qty: 1,
      },
    ],
  }),
  sample(
    6,
    "seafood",
    "Salmon fillets",
    ["Puget Butcher Co. Atlantic Salmon Fillet", "1 lb", 9.77, 2],
    {
      flags: [
        {
          kind: "over_item_ceiling",
          detail: "This line is $19.54, over the $15.00 limit for one item.",
        },
      ],
    },
  ),
  sample(
    7,
    "frozen",
    "vanilla ice cream for dessert",
    ["Puget Pantry Vanilla Ice Cream", "48 fl oz", 3.95, 1],
    {
      flags: [
        {
          kind: "needs_attention",
          detail: "This list line was hard to read, so check the product matches what you meant.",
        },
      ],
    },
  ),
];

function RunPreview() {
  const [draft, setDraft] = useState<ReviewDraft>({});
  const review = useMemo(() => preview(ITEMS, draft), [draft]);
  return (
    <SafeAreaView className="flex-1 bg-white">
      <ScrollView contentContainerClassName="mx-auto w-full max-w-2xl gap-5 px-4 py-4">
        <View className="gap-2 rounded-xl bg-neutral-50 p-4">
          <Text accessibilityRole="header" className="text-xl font-bold text-neutral-900">
            Ready for your review
          </Text>
          <Text className="text-base text-neutral-700">
            Check the cart, change anything you like, then approve. Nothing is in your store cart
            yet.
          </Text>
          <Text className="text-sm text-neutral-500">Mock QFC Duvall</Text>
        </View>
        <Text testID="run-subtotal" className="text-lg font-semibold text-neutral-900">
          {review.cartLines} items, ${review.subtotalUsd.toFixed(2)}
        </Text>
        <Button testID="run-approve" label="Approve and fill cart" onPress={() => setDraft({})} />
        <ProposedCart items={ITEMS} draft={draft} preview={review} editable onDraft={setDraft} />
        <TranscriptView
          entries={[
            {
              ts: "2026-10-31T16:00:01.000Z",
              tool: "search_products",
              by: "host",
              output_summary: "2 results, 2 candidates.",
              ok: true,
            },
            {
              ts: "2026-10-31T16:00:03.000Z",
              tool: "choose_product",
              by: "model",
              output_summary: "Chose candidate 0, 1 unit.",
              ok: true,
            },
          ]}
        />
      </ScrollView>
    </SafeAreaView>
  );
}

export default function RunPreviewScreen() {
  if (!__DEV__) return <Redirect href="/" />;
  return <RunPreview />;
}
