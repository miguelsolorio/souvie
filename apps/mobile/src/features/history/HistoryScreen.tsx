import { SegmentedControl } from "@mp/ui/primitives";
import { useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { ScrollView, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { MealsTab } from "./MealsTab";
import { MostBoughtTab } from "./MostBoughtTab";
import { OrderPromptBanner } from "./OrderPromptBanner";
import { type HistoryTab, parseTab } from "./routes";
import { SpendTab } from "./SpendTab";

/**
 * History (WS12): three tabs on one screen. Meals shows what the household cooked, Spend shows
 * what its confirmed orders cost, by week and by store, and Most bought ranks the products it buys
 * most and pins them. A `?tab=` parameter opens a given tab. The "Did you place this order?"
 * follow-up banner sits at the top.
 */
export function HistoryScreen() {
  const params = useLocalSearchParams<{ tab?: string }>();
  const [tab, setTab] = useState<HistoryTab>(() => parseTab(params.tab));

  return (
    <SafeAreaView className="flex-1 bg-white" edges={["bottom"]}>
      <ScrollView contentContainerClassName="mx-auto w-full max-w-2xl gap-5 px-4 py-4">
        <OrderPromptBanner />
        <SegmentedControl<HistoryTab>
          testID="history-tabs"
          label="History"
          value={tab}
          onChange={setTab}
          options={[
            { value: "meals", label: "Meals", testID: "history-tab-meals" },
            { value: "spend", label: "Spend", testID: "history-tab-spend" },
            { value: "bought", label: "Most bought", testID: "history-tab-bought" },
          ]}
        />
        <View testID={`history-panel-${tab}`}>
          {tab === "meals" ? <MealsTab /> : null}
          {tab === "spend" ? <SpendTab /> : null}
          {tab === "bought" ? <MostBoughtTab /> : null}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}
