import { Text, View } from "react-native";
import { useIsDesktop } from "../../lib/useBreakpoint";
import { LineItemCard } from "./LineItemCard";
import { CartTableHeader, LineItemRow } from "./LineItemRow";
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
  /** Takes an updater, so two quick taps never overwrite each other. */
  onDraft: (update: (current: ReviewDraft) => ReviewDraft) => void;
}) {
  const groups = groupBySection(items);
  // WS13: at the desktop breakpoint the cart is a table, one row per line. Same data, same
  // handlers; a phone and a tablet keep the cards.
  const table = useIsDesktop();
  const Line = table ? LineItemRow : LineItemCard;
  return (
    <View testID="proposed-cart" role={table ? "table" : undefined} className="gap-5">
      {table ? <CartTableHeader /> : null}
      {groups.map((group) => {
        const heading = (
          <Text
            accessibilityRole="header"
            className="text-sm font-semibold uppercase tracking-wide text-neutral-500"
          >
            {group.label}
          </Text>
        );
        return (
          <View key={group.section} role={table ? "rowgroup" : undefined} className="gap-2">
            {table ? (
              <View role="row">
                <View role="rowheader">{heading}</View>
              </View>
            ) : (
              heading
            )}
            {group.items.map((item) => (
              <Line
                key={item.id}
                item={item}
                approved={preview.items.get(item.id)}
                edit={draft[item.id]}
                editable={editable}
                onSwap={(index) => onDraft((d) => swap(d, item.id, index))}
                onRemove={() => onDraft((d) => remove(d, item.id))}
                onRestore={() => onDraft((d) => restore(d, item.id))}
                onQuantity={(quantity) => onDraft((d) => setQuantity(d, item.id, quantity))}
              />
            ))}
          </View>
        );
      })}
    </View>
  );
}
