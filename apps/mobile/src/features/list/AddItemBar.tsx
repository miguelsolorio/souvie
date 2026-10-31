import { LIST_LIMITS } from "@mp/core";
import { useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";

/**
 * A single line for adding something that is not from a recipe ("paper towels"). It adds on the
 * return key or the button, keeps the keyboard up for the next one, and shows the item at once.
 * Section and amount can be set afterwards in the item's sheet.
 */
export function AddItemBar({ onAdd }: { onAdd: (name: string) => void }) {
  const [text, setText] = useState("");
  const name = text.trim();

  const submit = () => {
    if (!name) return;
    onAdd(name.slice(0, LIST_LIMITS.displayName));
    setText("");
  };

  return (
    <View className="flex-row items-center gap-2" testID="add-item-bar">
      <TextInput
        testID="add-item-input"
        value={text}
        onChangeText={setText}
        placeholder="Add an item"
        placeholderTextColor="#9ca3af"
        accessibilityLabel="Add an item to the list"
        returnKeyType="done"
        blurOnSubmit={false}
        maxLength={LIST_LIMITS.displayName}
        onSubmitEditing={submit}
        className="min-h-12 flex-1 rounded-xl border border-neutral-300 bg-white px-4 text-base text-neutral-900"
      />
      <Pressable
        testID="add-item-button"
        accessibilityRole="button"
        accessibilityLabel="Add item"
        accessibilityState={{ disabled: !name }}
        disabled={!name}
        onPress={submit}
        className={`min-h-12 justify-center rounded-xl bg-brand px-5 ${name ? "" : "opacity-50"}`}
      >
        <Text className="text-base font-semibold text-white">Add</Text>
      </Pressable>
    </View>
  );
}
