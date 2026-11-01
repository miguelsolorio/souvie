import { MEAL_SLOTS, type MealSlot, weekDates, weekStartFor } from "@mp/core";
import { currentThumb, type PlanEntry, useRecipeFeedback, useSetThumb } from "@mp/db";
import { SegmentedControl, Sheet } from "@mp/ui/primitives";
import { useRouter } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Button } from "../../components/Button";
import { confirmAction } from "../../lib/confirm";
import {
  entryTitle,
  longDate,
  SLOT_LABELS,
  STATUS_LABELS,
  shortDayName,
  shortMonthDay,
  slotTitle,
} from "./format";
import { PlanNoticeBar } from "./PlanNotice";
import { pickRoute, recipeRoute } from "./routes";
import { EntryServingsStepper } from "./ServingsStepper";
import { SwapMenu } from "./SwapMenu";
import type { usePlanActions } from "./usePlanActions";

type Panel = "main" | "swap" | "move";

const NOTES_MAX = 1000;

/**
 * A planned meal, opened. Servings, notes, a thumbs control, and the actions: mark cooked, skip,
 * swap, move, and remove. Every change applies at once and saves in the background.
 *
 * It is controlled by the screen that shows it: pass the entry (read from the live plan, so a
 * change by another member shows here too) or null to close it.
 */
export function EntrySheet({
  entry,
  weekEntries,
  actions,
  onClose,
}: {
  entry: PlanEntry | null;
  /** All entries of the entry's week: used to place a moved entry and to avoid repeats on a swap. */
  weekEntries: readonly PlanEntry[];
  actions: ReturnType<typeof usePlanActions>;
  onClose: () => void;
}) {
  const [panel, setPanel] = useState<Panel>("main");
  const insets = useSafeAreaInsets();
  const entryId = entry?.id;

  // Each time a different entry opens, start on the main panel.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset when the entry id changes.
  useEffect(() => {
    setPanel("main");
  }, [entryId]);

  return (
    <Sheet
      visible={entry !== null}
      onClose={onClose}
      title={entry ? entryTitle(entry) : "Meal"}
      bottomInset={insets.bottom}
      testID="entry-sheet"
    >
      {entry ? (
        <EntryBody
          entry={entry}
          weekEntries={weekEntries}
          actions={actions}
          panel={panel}
          setPanel={setPanel}
          onClose={onClose}
        />
      ) : null}
    </Sheet>
  );
}

function EntryBody({
  entry,
  weekEntries,
  actions,
  panel,
  setPanel,
  onClose,
}: {
  entry: PlanEntry;
  weekEntries: readonly PlanEntry[];
  actions: ReturnType<typeof usePlanActions>;
  panel: Panel;
  setPanel: (panel: Panel) => void;
  onClose: () => void;
}) {
  const router = useRouter();
  const recipeGone = !entry.recipe || entry.recipe.deleted_at !== null;

  if (panel === "swap") {
    return (
      <SwapMenu
        entry={entry}
        weekEntries={weekEntries}
        actions={actions}
        onBack={() => setPanel("main")}
        onDone={onClose}
        onPick={() => {
          onClose();
          router.push(pickRoute({ date: entry.date, slot: entry.slot, entry: entry.id }));
        }}
      />
    );
  }

  if (panel === "move") {
    return (
      <MovePanel
        entry={entry}
        onBack={() => setPanel("main")}
        onMove={(target) => {
          actions.moveEntry(entry, target, weekEntries);
          onClose();
        }}
      />
    );
  }

  async function confirmRemove() {
    const ok = await confirmAction({
      title: "Remove from plan",
      message: `${entryTitle(entry)} will be taken off ${slotTitle(entry.date, entry.slot)}. The recipe stays in your recipes.`,
      confirmLabel: "Remove",
      destructive: true,
    });
    if (!ok) return;
    actions.deleteEntry(entry);
    onClose();
  }

  const cooked = entry.status === "cooked";
  const skipped = entry.status === "skipped";

  return (
    <View testID="entry-body" className="gap-5">
      <PlanNoticeBar />

      <View className="gap-1">
        <Text className="text-sm text-neutral-600">
          {[
            longDate(entry.date),
            SLOT_LABELS[entry.slot],
            entry.status === "planned" ? null : STATUS_LABELS[entry.status],
          ]
            .filter(Boolean)
            .join(" · ")}
        </Text>
        {recipeGone ? (
          <Text className="text-sm text-neutral-600">
            This recipe is not in your recipes any more. Swap it or remove it.
          </Text>
        ) : (
          <Pressable
            testID="open-recipe"
            accessibilityRole="link"
            accessibilityLabel={`Open the recipe for ${entryTitle(entry)}`}
            onPress={() => {
              onClose();
              router.push(recipeRoute(entry.recipe_id));
            }}
            className="min-h-11 justify-center self-start"
          >
            <Text className="text-base font-medium text-brand underline">Open recipe</Text>
          </Pressable>
        )}
      </View>

      {entry.why ? (
        <View testID="entry-why" className="gap-1 rounded-xl bg-green-50 p-3">
          <Text className="text-xs font-semibold uppercase tracking-wide text-green-800">
            Why this
          </Text>
          <Text className="text-sm text-neutral-800">{entry.why}</Text>
        </View>
      ) : null}

      <View className="flex-row items-center justify-between gap-4">
        <Text className="text-base font-semibold text-neutral-900">Servings</Text>
        <EntryServingsStepper
          servings={entry.servings}
          onCommit={(servings) => actions.setServings(entry, servings)}
        />
      </View>

      <NotesField entry={entry} onCommit={(notes) => actions.setNotes(entry, notes)} />

      <Thumbs entry={entry} />

      <View className="gap-3">
        <Button
          testID="mark-cooked"
          label={cooked ? "Undo cooked" : "Mark cooked"}
          variant={cooked ? "secondary" : "primary"}
          onPress={() => actions.setStatus(entry, cooked ? "planned" : "cooked")}
        />
        <Button
          testID="skip-entry"
          label={skipped ? "Undo skip" : "Skip this meal"}
          variant="secondary"
          onPress={() => actions.setStatus(entry, skipped ? "planned" : "skipped")}
        />
        <View className="flex-row gap-3">
          <View className="flex-1">
            <Button
              testID="swap-entry"
              label="Swap"
              variant="secondary"
              onPress={() => setPanel("swap")}
            />
          </View>
          <View className="flex-1">
            <Button
              testID="move-entry"
              label="Move"
              variant="secondary"
              onPress={() => setPanel("move")}
            />
          </View>
        </View>
        <Button
          testID="remove-entry"
          label="Remove from plan"
          variant="danger"
          onPress={() => void confirmRemove()}
        />
      </View>
    </View>
  );
}

/** Notes save when the field loses focus, not on every key, so one edit is one request. */
function NotesField({
  entry,
  onCommit,
}: {
  entry: PlanEntry;
  onCommit: (notes: string | null) => void;
}) {
  const [draft, setDraft] = useState(entry.notes ?? "");
  const [focused, setFocused] = useState(false);
  const pending = useRef({ draft, saved: entry.notes ?? "", onCommit });
  pending.current = { draft, saved: entry.notes ?? "", onCommit };

  // Follow another member's edit, but never overwrite what this person is typing.
  useEffect(() => {
    if (!focused) setDraft(entry.notes ?? "");
  }, [entry.notes, focused]);

  // Closing the sheet unmounts the field, and on a phone that does not always send a blur first.
  // Whatever was typed and not yet saved is saved now.
  useEffect(
    () => () => {
      const { draft: typed, saved, onCommit: commit } = pending.current;
      if (typed.trim() !== saved.trim()) commit(typed);
    },
    [],
  );

  return (
    <View className="gap-1.5">
      <Text className="text-sm font-medium text-neutral-800">Notes</Text>
      <TextInput
        testID="entry-notes"
        value={draft}
        onChangeText={setDraft}
        onFocus={() => setFocused(true)}
        onBlur={() => {
          setFocused(false);
          onCommit(draft);
        }}
        placeholder="Swap the rice for noodles, double the sauce"
        placeholderTextColor="#9ca3af"
        accessibilityLabel="Notes"
        multiline
        maxLength={NOTES_MAX}
        className="min-h-20 rounded-xl border border-neutral-300 bg-white px-4 py-3 text-base text-neutral-900"
        style={{ textAlignVertical: "top" }}
      />
    </View>
  );
}

/** Like and dislike. A thumb teaches the suggestions; tapping the active one takes it back. */
function Thumbs({ entry }: { entry: PlanEntry }) {
  const feedback = useRecipeFeedback(entry.recipe_id);
  const setThumb = useSetThumb();
  const thumb = currentThumb(feedback.data);

  const press = (next: "like" | "dislike") =>
    setThumb.mutate({
      householdId: entry.household_id,
      recipeId: entry.recipe_id,
      thumb: thumb === next ? null : next,
    });

  return (
    <View className="gap-1.5">
      <Text className="text-sm font-medium text-neutral-800">How was it?</Text>
      <View className="flex-row gap-3" accessibilityRole="radiogroup">
        <ThumbButton
          testID="thumb-like"
          label="Like"
          glyph="👍"
          selected={thumb === "like"}
          onPress={() => press("like")}
        />
        <ThumbButton
          testID="thumb-dislike"
          label="Dislike"
          glyph="👎"
          selected={thumb === "dislike"}
          onPress={() => press("dislike")}
        />
      </View>
    </View>
  );
}

function ThumbButton({
  testID,
  label,
  glyph,
  selected,
  onPress,
}: {
  testID: string;
  label: string;
  glyph: string;
  selected: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      testID={testID}
      accessibilityRole="radio"
      accessibilityLabel={label}
      accessibilityState={{ selected, checked: selected }}
      // react-native-web writes aria-* props and ignores accessibilityState (WS13).
      aria-checked={selected}
      onPress={onPress}
      className={`min-h-12 flex-1 flex-row items-center justify-center gap-2 rounded-xl border px-4 ${
        selected ? "border-brand bg-green-50" : "border-neutral-300 bg-white"
      }`}
    >
      <Text className="text-lg">{glyph}</Text>
      <Text className={`text-base font-semibold ${selected ? "text-brand" : "text-neutral-800"}`}>
        {label}
      </Text>
    </Pressable>
  );
}

/** Click-to-move: pick a day of the same week and a slot, then move. */
function MovePanel({
  entry,
  onBack,
  onMove,
}: {
  entry: PlanEntry;
  onBack: () => void;
  onMove: (target: { date: string; slot: MealSlot }) => void;
}) {
  const [date, setDate] = useState(entry.date);
  const [slot, setSlot] = useState<MealSlot>(entry.slot);
  const days = weekDates(weekStartFor(entry.date));
  const unchanged = date === entry.date && slot === entry.slot;

  return (
    <View testID="move-panel" className="gap-4">
      <Text className="text-base text-neutral-700">
        Move {entryTitle(entry)} to another day or meal this week.
      </Text>
      <View className="gap-2">
        <Text className="text-sm font-medium text-neutral-800">Day</Text>
        <View className="flex-row flex-wrap gap-2">
          {days.map((day) => {
            const selected = day === date;
            return (
              <Pressable
                key={day}
                testID={`move-day-${day}`}
                accessibilityRole="radio"
                accessibilityLabel={longDate(day)}
                accessibilityState={{ selected, checked: selected }}
                aria-checked={selected}
                onPress={() => setDate(day)}
                className={`min-h-12 min-w-16 items-center justify-center rounded-xl border px-3 ${
                  selected ? "border-brand bg-brand" : "border-neutral-300 bg-white"
                }`}
              >
                <Text
                  className={`text-xs font-semibold ${selected ? "text-white" : "text-neutral-600"}`}
                >
                  {shortDayName(day)}
                </Text>
                <Text
                  className={`text-sm font-bold ${selected ? "text-white" : "text-neutral-900"}`}
                >
                  {shortMonthDay(day).split(" ")[1]}
                </Text>
              </Pressable>
            );
          })}
        </View>
      </View>
      <View className="gap-2">
        <Text className="text-sm font-medium text-neutral-800">Meal</Text>
        <SegmentedControl
          label="Meal"
          value={slot}
          onChange={setSlot}
          options={MEAL_SLOTS.map((value) => ({
            value,
            label: value.charAt(0).toUpperCase() + value.slice(1),
            testID: `move-slot-${value}`,
          }))}
        />
      </View>
      <Button
        testID="move-confirm"
        label={unchanged ? "Pick a new day or meal" : `Move to ${slotTitle(date, slot)}`}
        disabled={unchanged}
        onPress={() => onMove({ date, slot })}
      />
      <Button testID="move-back" label="Back" variant="ghost" onPress={onBack} />
    </View>
  );
}
