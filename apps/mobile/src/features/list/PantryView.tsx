import type { PantryStatus } from "@mp/core";
import { listErrorMessage, type PantryRow, useIngredientSearch, usePantry } from "@mp/db";
import { SegmentedControl } from "@mp/ui/primitives";
import { useEffect, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Button } from "../../components/Button";
import "./queueStorage";

const STATUS_OPTIONS = [
  { value: "have", label: "Have" },
  { value: "low", label: "Low" },
  { value: "out", label: "Out" },
] as const;

function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return debounced;
}

/** What a status means for the next list, in a line. */
export function statusHint(row: Pick<PantryRow, "status" | "isDefault">): string {
  if (row.isDefault) return "Have (default). Stays off your list.";
  if (row.status === "have") return "Stays off your list.";
  if (row.status === "low") return "On your list, so you restock it.";
  return "On your list.";
}

/**
 * The pantry: what the household keeps on hand. An ingredient marked Have stays off the grocery
 * list (it shows under "Already have"); Low and Out put it on. Staples such as salt and oil count as
 * Have until the household says otherwise, and a row is saved only when something is changed.
 */
export function PantryView() {
  const pantry = usePantry();
  const [term, setTerm] = useState("");
  const debounced = useDebounced(term, 250);
  const search = useIngredientSearch(debounced);

  const known = new Set(pantry.rows.map((row) => row.ingredientId));
  const found = (search.data ?? []).filter((ingredient) => !known.has(ingredient.id));
  const staples = pantry.rows.filter((row) => row.isStaple);
  const added = pantry.rows.filter((row) => !row.isStaple);

  return (
    <SafeAreaView className="flex-1 bg-white" edges={["bottom"]}>
      <ScrollView
        testID="pantry-scroll"
        keyboardShouldPersistTaps="handled"
        contentContainerClassName="mx-auto w-full max-w-2xl gap-5 px-4 py-4"
      >
        <Text className="text-base text-neutral-600">
          Mark what you keep on hand. What you have stays off your grocery list; mark it Low or Out
          and it comes back on the next list.
        </Text>

        {pantry.writeError ? (
          <Text accessibilityRole="alert" className="rounded-xl bg-red-50 p-3 text-sm text-red-800">
            {listErrorMessage(pantry.writeError)}
          </Text>
        ) : null}

        <View className="gap-2">
          <TextInput
            testID="pantry-search"
            value={term}
            onChangeText={setTerm}
            placeholder="Add something you keep, like rice"
            placeholderTextColor="#9ca3af"
            accessibilityLabel="Search ingredients to add to the pantry"
            autoCapitalize="none"
            autoCorrect={false}
            className="min-h-12 rounded-xl border border-neutral-300 bg-white px-4 text-base text-neutral-900"
          />
          {search.isFetching ? <ActivityIndicator color="#2F6B4F" /> : null}
          {found.map((ingredient) => (
            <View
              key={ingredient.id}
              testID={`pantry-result-${ingredient.name}`}
              className="min-h-14 flex-row items-center justify-between gap-3 border-b border-neutral-100"
            >
              <Text className="flex-1 text-base text-neutral-900">{ingredient.name}</Text>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Add ${ingredient.name} to the pantry as have`}
                onPress={() => {
                  pantry.setStatus({ ingredientId: ingredient.id, status: "have" });
                  setTerm("");
                }}
                className="min-h-11 justify-center rounded-xl border border-neutral-300 px-4"
              >
                <Text className="text-sm font-semibold text-neutral-900">I have it</Text>
              </Pressable>
            </View>
          ))}
          {debounced.trim().length >= 2 && !search.isFetching && found.length === 0 ? (
            <Text className="text-sm text-neutral-500">
              Nothing new matches "{debounced.trim()}".
            </Text>
          ) : null}
        </View>

        {pantry.isPending ? (
          <View className="items-center py-10">
            <ActivityIndicator color="#2F6B4F" />
          </View>
        ) : null}

        {pantry.isError && pantry.rows.length === 0 ? (
          <View className="gap-3 rounded-xl border border-red-200 bg-red-50 p-4">
            <Text accessibilityRole="alert" className="text-base text-red-800">
              Could not load the pantry.
            </Text>
            <Button label="Try again" variant="secondary" onPress={pantry.refetch} />
          </View>
        ) : null}

        {added.length > 0 ? (
          <PantryGroup
            title="You added"
            rows={added}
            onSet={pantry.setStatus}
            onClear={pantry.clearStatus}
          />
        ) : null}
        {staples.length > 0 ? (
          <PantryGroup
            title="Staples"
            rows={staples}
            onSet={pantry.setStatus}
            onClear={pantry.clearStatus}
          />
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

function PantryGroup({
  title,
  rows,
  onSet,
  onClear,
}: {
  title: string;
  rows: PantryRow[];
  onSet: (args: { ingredientId: string; status: PantryStatus }) => void;
  onClear: (args: { ingredientId: string }) => void;
}) {
  return (
    <View className="gap-1" testID={`pantry-group-${title.toLowerCase().replace(/\s+/g, "-")}`}>
      <Text
        accessibilityRole="header"
        className="text-xs font-bold uppercase tracking-wide text-neutral-500"
      >
        {title}
      </Text>
      {rows.map((row) => (
        <View
          key={row.ingredientId}
          testID={`pantry-row-${row.name}`}
          className="gap-2 border-b border-neutral-100 py-3"
        >
          <View className="flex-row items-baseline justify-between gap-3">
            <Text className="flex-1 text-base font-medium text-neutral-900">{row.name}</Text>
            {row.isDefault ? null : (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={
                  row.isStaple
                    ? `Reset ${row.name} to the default`
                    : `Remove ${row.name} from the pantry`
                }
                onPress={() => onClear({ ingredientId: row.ingredientId })}
                className="min-h-9 justify-center px-2"
              >
                <Text className="text-sm font-semibold text-brand">
                  {row.isStaple ? "Reset" : "Remove"}
                </Text>
              </Pressable>
            )}
          </View>
          <SegmentedControl
            label={`${row.name} status`}
            testID={`pantry-status-${row.name}`}
            options={STATUS_OPTIONS.map((option) => ({
              ...option,
              testID: `pantry-${row.name}-${option.value}`,
              accessibilityLabel: `${row.name}: ${option.label}`,
            }))}
            value={row.status}
            onChange={(status) => onSet({ ingredientId: row.ingredientId, status })}
          />
          <Text className="text-xs text-neutral-500">{statusHint(row)}</Text>
        </View>
      ))}
    </View>
  );
}
