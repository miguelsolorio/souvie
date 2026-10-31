import { resolveSectionOrder, sectionLabel } from "@mp/core";
import { Sheet } from "@mp/ui/primitives";
import { useEffect, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Button } from "../../components/Button";
import { moveSection } from "./logic";

/**
 * The household's aisle order for this list: the order sections appear in the list and in store
 * mode. Each move is saved at once. "Use the default order" clears it. A new list starts from the
 * order of the household's latest one.
 */
export function SectionOrderSheet({
  visible,
  sectionOrder,
  saving,
  onClose,
  onChange,
}: {
  visible: boolean;
  sectionOrder: readonly string[] | null | undefined;
  saving: boolean;
  onClose: () => void;
  /** null means the default order. */
  onChange: (order: string[] | null) => void;
}) {
  const insets = useSafeAreaInsets();
  const [order, setOrder] = useState(() => resolveSectionOrder(sectionOrder));
  const saved = (sectionOrder ?? []).join("|");

  // Start from what is saved each time the sheet opens, and follow a change from another member.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `saved` stands for sectionOrder.
  useEffect(() => {
    if (visible) setOrder(resolveSectionOrder(sectionOrder));
  }, [visible, saved]);

  const move = (section: string, direction: -1 | 1) => {
    const next = moveSection(order, section, direction);
    if (next.join("|") === order.join("|")) return;
    setOrder(next);
    onChange(next);
  };

  return (
    <Sheet
      visible={visible}
      onClose={onClose}
      title="Aisle order"
      bottomInset={insets.bottom}
      testID="section-order-sheet"
    >
      <Text className="text-sm text-neutral-600">
        Put the sections in the order you walk your store. The list and store mode follow it.
      </Text>
      <View>
        {order.map((section, index) => (
          <View
            key={section}
            testID={`order-row-${section}`}
            className="min-h-14 flex-row items-center gap-2 border-b border-neutral-100"
          >
            <Text className="w-6 text-sm text-neutral-400">{index + 1}</Text>
            <Text className="flex-1 text-base text-neutral-900">{sectionLabel(section)}</Text>
            <MoveButton
              label={`Move ${sectionLabel(section)} up`}
              glyph="↑"
              disabled={index === 0}
              testID={`order-up-${section}`}
              onPress={() => move(section, -1)}
            />
            <MoveButton
              label={`Move ${sectionLabel(section)} down`}
              glyph="↓"
              disabled={index === order.length - 1}
              testID={`order-down-${section}`}
              onPress={() => move(section, 1)}
            />
          </View>
        ))}
      </View>
      <Button
        testID="order-reset"
        label="Use the default order"
        variant="secondary"
        loading={saving}
        disabled={sectionOrder == null}
        onPress={() => {
          setOrder(resolveSectionOrder(null));
          onChange(null);
        }}
      />
    </Sheet>
  );
}

function MoveButton({
  label,
  glyph,
  disabled,
  testID,
  onPress,
}: {
  label: string;
  glyph: string;
  disabled: boolean;
  testID: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      className={`h-11 w-11 items-center justify-center rounded-xl border border-neutral-300 ${disabled ? "opacity-30" : ""}`}
    >
      <Text className="text-lg text-neutral-900">{glyph}</Text>
    </Pressable>
  );
}
