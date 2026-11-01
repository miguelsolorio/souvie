import { EmptyState } from "@mp/ui/primitives";
import { useRouter } from "expo-router";
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Button } from "../../components/Button";
import { LIST_ROUTE } from "../list/routes";
import { isActive, type ShoppingRun, STATUS_LABEL } from "./logic";
import { runRoute } from "./routes";
import { useRunRealtime } from "./useRunRealtime";
import { useShoppingRuns } from "./useShoppingRun";

function when(run: ShoppingRun): string {
  const date = new Date(run.created_at);
  return date.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}

function itemsLine(run: ShoppingRun): string {
  const s = run.cart_snapshot;
  if (!s?.itemCount) return run.trigger === "scheduled" ? "Scheduled run" : "Started by hand";
  const review = s.needsReviewCount ?? 0;
  return review > 0 && run.status === "needs_review"
    ? `${s.itemCount} items, ${review} need your call`
    : `${s.itemCount} items`;
}

/**
 * The household's shopping runs, newest first, with live status. Subtotals are not on this screen:
 * runs at different stores would put two retailers' prices side by side.
 */
export function RunList() {
  useRunRealtime();
  const router = useRouter();
  const runs = useShoppingRuns();

  if (runs.isPending) {
    return (
      <View className="flex-1 items-center justify-center bg-white">
        <ActivityIndicator color="#2F6B4F" />
      </View>
    );
  }
  const list = runs.data ?? [];

  return (
    <SafeAreaView className="flex-1 bg-white" edges={["bottom"]}>
      <ScrollView
        contentContainerClassName="mx-auto w-full max-w-2xl gap-3 px-4 py-4"
        refreshControl={
          <RefreshControl refreshing={runs.isRefetching} onRefresh={() => void runs.refetch()} />
        }
      >
        {runs.isError ? (
          <View className="gap-3 rounded-xl border border-red-200 bg-red-50 p-4">
            <Text accessibilityRole="alert" className="text-base text-red-800">
              Could not load your shopping runs.
            </Text>
            <Button label="Try again" variant="secondary" onPress={() => void runs.refetch()} />
          </View>
        ) : null}
        {list.length === 0 && !runs.isError ? (
          <EmptyState
            testID="runs-empty"
            icon="🧺"
            title="No shopping runs yet"
            message="From your grocery list, tap Shop this list and the shopper fills your store cart for you to review."
            action={{
              label: "Open the list",
              testID: "runs-open-list",
              onPress: () => router.push(LIST_ROUTE),
            }}
          />
        ) : null}
        {list.map((run) => (
          <Pressable
            key={run.id}
            testID={`run-row-${run.id}`}
            accessibilityRole="button"
            onPress={() => router.push(runRoute(run.id))}
            className="gap-1 rounded-xl border border-neutral-200 p-4"
          >
            <View className="flex-row items-center justify-between gap-2">
              <Text className="text-base font-semibold text-neutral-900">
                {run.store_name ?? "Store"}
              </Text>
              <Text
                className={`rounded-full px-2 py-0.5 text-xs font-semibold ${
                  run.status === "needs_review"
                    ? "bg-amber-100 text-amber-900"
                    : run.status === "cart_ready" || run.status === "checked_out"
                      ? "bg-green-100 text-green-900"
                      : run.status === "failed"
                        ? "bg-red-100 text-red-900"
                        : "bg-neutral-100 text-neutral-700"
                }`}
              >
                {STATUS_LABEL[run.status]}
              </Text>
            </View>
            <Text className="text-sm text-neutral-600">
              {when(run)} · {itemsLine(run)}
              {isActive(run.status) && run.status !== "needs_review" && run.status !== "cart_ready"
                ? " · in progress"
                : ""}
            </Text>
          </Pressable>
        ))}
      </ScrollView>
    </SafeAreaView>
  );
}
