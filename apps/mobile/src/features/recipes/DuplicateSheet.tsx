import type { DuplicateMatch } from "@mp/db";
import { Sheet } from "@mp/ui/primitives";
import { Text, View } from "react-native";
import { Button } from "../../components/Button";

export const DUPLICATE_SHEET_TITLE = "You already have this recipe";

const BODY: Record<DuplicateMatch, string> = {
  url: "That link is already saved in your recipes.",
  title: "A recipe with this title is already in your recipes.",
};

/**
 * What the add-recipe screen says when the household already has the recipe being added. "Open it"
 * goes to the recipe that is there. "Add anyway" is offered only for a same-title match: a link
 * can be saved once, because the database keeps one live recipe per link in a household.
 *
 * It rises over the screen, so whatever the person typed stays where it was. The screen shows it
 * from the failed request's own state and closes it by resetting that state, so there is no
 * second copy of "is it open" to fall out of step.
 */
export function DuplicateSheet({
  existing,
  onOpen,
  onAddAnyway,
  onClose,
}: {
  existing: { matchedBy: DuplicateMatch } | null;
  onOpen: () => void;
  onAddAnyway: () => void;
  onClose: () => void;
}) {
  return (
    <Sheet
      visible={existing !== null}
      onClose={onClose}
      title={DUPLICATE_SHEET_TITLE}
      bottomInset={24}
      testID="duplicate-sheet"
    >
      {existing ? (
        <View className="gap-3">
          <Text className="text-base text-neutral-700">{BODY[existing.matchedBy]}</Text>
          <Button testID="duplicate-open" label="Open it" onPress={onOpen} />
          {existing.matchedBy === "title" ? (
            <Button
              testID="duplicate-add-anyway"
              label="Add anyway"
              variant="secondary"
              onPress={onAddAnyway}
            />
          ) : (
            <Text testID="duplicate-link-note" className="text-sm text-neutral-500">
              A link can be saved once. Delete the saved recipe first to add it again.
            </Text>
          )}
          <Button testID="duplicate-cancel" label="Cancel" variant="ghost" onPress={onClose} />
        </View>
      ) : null}
    </Sheet>
  );
}
