import { type GroceryListItem, type ItemPatch, resolveSectionOrder, sectionLabel } from "@mp/core";
import { Sheet } from "@mp/ui/primitives";
import { useEffect, useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Button } from "../../components/Button";
import {
  attentionNote,
  contributionRows,
  needSummary,
  parseQuantityInput,
  parseUnitInput,
  quantityInputText,
  roundingSentence,
} from "./logic";

/**
 * One item, opened: how its amount was worked out (every recipe that adds to it, with its
 * servings, the converted quantity, and the rounding step), and the controls to change it. A
 * person can always see the numbers and override them (risk R2); an override is kept by a rebuild.
 *
 * It is controlled by the screen that shows it: pass the item (read from the live list, so a change
 * by another member shows here too) or null to close it.
 */
export function WhyThisAmountSheet({
  item,
  sectionOrder,
  onClose,
  onSave,
  onRemove,
}: {
  item: GroceryListItem | null;
  sectionOrder: readonly string[] | null | undefined;
  onClose: () => void;
  onSave: (itemId: string, patch: ItemPatch) => void;
  onRemove: (item: GroceryListItem) => void;
}) {
  const insets = useSafeAreaInsets();
  return (
    <Sheet
      visible={item !== null}
      onClose={onClose}
      title={item?.display_name ?? "Item"}
      bottomInset={insets.bottom}
      testID="why-sheet"
    >
      {item ? (
        <SheetBody
          item={item}
          sectionOrder={sectionOrder}
          onClose={onClose}
          onSave={onSave}
          onRemove={onRemove}
        />
      ) : null}
    </Sheet>
  );
}

function SheetBody({
  item,
  sectionOrder,
  onClose,
  onSave,
  onRemove,
}: {
  item: GroceryListItem;
  sectionOrder: readonly string[] | null | undefined;
  onClose: () => void;
  onSave: (itemId: string, patch: ItemPatch) => void;
  onRemove: (item: GroceryListItem) => void;
}) {
  const rows = contributionRows(item);
  const rounding = roundingSentence(item);
  const attention = attentionNote(item);
  const sections = resolveSectionOrder(sectionOrder);
  if (!sections.includes(item.section)) sections.push(item.section);

  const [qty, setQty] = useState(quantityInputText(item.qty));
  const [unit, setUnit] = useState(item.unit ?? "");
  const [section, setSection] = useState(item.section);
  const itemId = item.id;

  // Each time a different item opens, start from its numbers.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset when the item id changes.
  useEffect(() => {
    setQty(quantityInputText(item.qty));
    setUnit(item.unit ?? "");
    setSection(item.section);
  }, [itemId]);

  const parsedQty = parseQuantityInput(qty);
  const parsedUnit = parseUnitInput(unit);
  const invalid = parsedQty === "invalid" || parsedUnit === "invalid";
  const patch: ItemPatch = {};
  if (parsedQty !== "invalid" && parsedQty !== item.qty) patch.qty = parsedQty;
  if (parsedUnit !== "invalid" && parsedUnit !== item.unit) patch.unit = parsedUnit;
  if (section !== item.section) patch.section = section;
  const changed = Object.keys(patch).length > 0;

  return (
    <View className="gap-5">
      <View className="gap-1">
        <Text testID="why-summary" className="text-lg font-semibold text-neutral-900">
          {needSummary(item)}
        </Text>
        {item.qualifiers.length > 0 ? (
          <Text className="text-sm text-neutral-600">
            The recipe asks for: {item.qualifiers.join(", ")}.
          </Text>
        ) : null}
        {item.edited ? (
          <Text className="text-sm text-neutral-600">
            You changed this. Rebuilding the list keeps your change.
          </Text>
        ) : null}
      </View>

      {attention ? (
        <Text testID="why-attention" className="rounded-xl bg-amber-50 p-3 text-sm text-amber-900">
          {attention}
        </Text>
      ) : null}

      {item.is_manual ? (
        <Text className="text-sm text-neutral-600">
          You added this item. It is not from a recipe.
        </Text>
      ) : (
        <View className="gap-3">
          <Text accessibilityRole="header" className="text-base font-bold text-neutral-900">
            Why this amount
          </Text>
          {rows.length === 0 ? (
            <Text className="text-sm text-neutral-600">No recipe adds to this item any more.</Text>
          ) : (
            rows.map((row) => (
              <View
                key={row.key}
                testID="why-contribution"
                className="gap-0.5 rounded-xl border border-neutral-200 p-3"
              >
                <View className="flex-row items-baseline justify-between gap-3">
                  <Text className="flex-1 text-base font-semibold text-neutral-900">
                    {row.recipe}
                    {row.optional ? " (optional)" : ""}
                  </Text>
                  <Text className="text-base font-semibold text-neutral-900">{row.amount}</Text>
                </View>
                <Text className="text-sm text-neutral-600">{row.servings}</Text>
                {row.lines.map((line) => (
                  <Text key={line} className="text-sm italic text-neutral-500">
                    {line}
                  </Text>
                ))}
                {row.note ? <Text className="text-xs text-amber-800">{row.note}</Text> : null}
              </View>
            ))
          )}
          {rounding ? (
            <Text testID="why-rounding" className="text-sm text-neutral-700">
              {rounding}
            </Text>
          ) : null}
        </View>
      )}

      <View className="gap-3">
        <Text accessibilityRole="header" className="text-base font-bold text-neutral-900">
          Change this item
        </Text>
        <View className="flex-row gap-3">
          <View className="flex-1 gap-1.5">
            <Text className="text-sm font-medium text-neutral-800">Amount</Text>
            <TextInput
              testID="why-qty"
              value={qty}
              onChangeText={setQty}
              keyboardType="numbers-and-punctuation"
              placeholder="2"
              placeholderTextColor="#9ca3af"
              accessibilityLabel="Amount"
              className={`min-h-12 rounded-xl border px-4 text-base text-neutral-900 ${
                parsedQty === "invalid" ? "border-red-400" : "border-neutral-300"
              }`}
            />
          </View>
          <View className="flex-1 gap-1.5">
            <Text className="text-sm font-medium text-neutral-800">Unit</Text>
            <TextInput
              testID="why-unit"
              value={unit}
              onChangeText={setUnit}
              autoCapitalize="none"
              placeholder="lb, cup, can"
              placeholderTextColor="#9ca3af"
              accessibilityLabel="Unit"
              className={`min-h-12 rounded-xl border px-4 text-base text-neutral-900 ${
                parsedUnit === "invalid" ? "border-red-400" : "border-neutral-300"
              }`}
            />
          </View>
        </View>
        {invalid ? (
          <Text accessibilityRole="alert" className="text-sm text-red-700">
            Use a number such as 2, 1.5 or 1 1/2, and a unit made of letters.
          </Text>
        ) : null}
        <View className="gap-1.5">
          <Text className="text-sm font-medium text-neutral-800">Section</Text>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            keyboardShouldPersistTaps="handled"
          >
            <View className="flex-row gap-2 py-1">
              {sections.map((name) => (
                <Pressable
                  key={name}
                  testID={`why-section-${name}`}
                  accessibilityRole="button"
                  accessibilityState={{ selected: section === name }}
                  accessibilityLabel={`Section: ${sectionLabel(name)}`}
                  onPress={() => setSection(name)}
                  className={`min-h-11 justify-center rounded-full border px-4 ${
                    section === name ? "border-brand bg-brand" : "border-neutral-300 bg-white"
                  }`}
                >
                  <Text
                    className={`text-sm font-semibold ${section === name ? "text-white" : "text-neutral-800"}`}
                  >
                    {sectionLabel(name)}
                  </Text>
                </Pressable>
              ))}
            </View>
          </ScrollView>
        </View>
        <Button
          testID="why-save"
          label="Save changes"
          disabled={!changed || invalid}
          onPress={() => {
            onSave(item.id, patch);
            onClose();
          }}
        />
        <Button
          testID="why-remove"
          label={item.is_manual ? "Delete item" : "Remove from list"}
          variant="danger"
          onPress={() => {
            onRemove(item);
            onClose();
          }}
        />
      </View>
    </View>
  );
}
