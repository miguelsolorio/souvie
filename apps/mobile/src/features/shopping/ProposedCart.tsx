import { Text, View } from "react-native";
import { LineItemCard } from "./LineItemCard";
import {
  groupBySection,
  type ReviewDraft,
  type ReviewPreview,
  type RunItem,
  remove,
  restore,
  setQuantity,
  swap,
} from "./logic";

/**
 * The proposed cart, grouped by store section. While the run waits for review every line can be
 * swapped to one of its alternatives, removed, or given another quantity; the draft stays on this
 * screen until "Approve and fill cart" sends it.
 */
export function ProposedCart({
  items,
  draft,
  preview,
  editable,
  onDraft,
}: {
  items: readonly RunItem[];
  draft: ReviewDraft;
  preview: ReviewPreview;
  editable: boolean;
  onDraft: (next: ReviewDraft) => void;
}) {
  const groups = groupBySection(items);
  return (
    <View testID="proposed-cart" className="gap-5">
      {groups.map((group) => (
        <View key={group.section} className="gap-2">
          <Text
            accessibilityRole="header"
            className="text-sm font-semibold uppercase tracking-wide text-neutral-500"
          >
            {group.label}
          </Text>
          {group.items.map((item) => (
            <LineItemCard
              key={item.id}
              item={item}
              approved={preview.items.get(item.id)}
              edit={draft[item.id]}
              editable={editable}
              onSwap={(index) => onDraft(swap(draft, item.id, index))}
              onRemove={() => onDraft(remove(draft, item.id))}
              onRestore={() => onDraft(restore(draft, item.id))}
              onQuantity={(quantity) => onDraft(setQuantity(draft, item.id, quantity))}
            />
          ))}
        </View>
      ))}
    </View>
  );
}
