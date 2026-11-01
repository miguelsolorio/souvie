import { Text, View } from "react-native";
import { Section } from "../components/Screen";
import {
  type AiCosts,
  formatLatency,
  formatPercent,
  formatSilence,
  formatUsd,
  totalsByDay,
} from "./aiCosts";

function Row({
  cells,
  header = false,
  testID,
}: {
  cells: string[];
  header?: boolean;
  testID?: string;
}) {
  return (
    <View testID={testID} className="flex-row gap-2 border-b border-neutral-200 py-1">
      {cells.map((cell, index) => (
        <Text
          // biome-ignore lint/suspicious/noArrayIndexKey: a fixed row of cells.
          key={index}
          className={`flex-1 text-xs ${header ? "font-semibold text-neutral-900" : "text-neutral-700"}`}
        >
          {cell}
        </Text>
      ))}
    </View>
  );
}

/**
 * The cost views as tables (WS15 admin screen): spend per day, spend by day, kind and model,
 * quality and latency by prompt version, and runs that stopped beating. Numbers only; there is
 * no prompt, answer, recipe or list on this screen.
 */
export function AiCostTables({ costs }: { costs: AiCosts }) {
  const days = totalsByDay(costs.daily);
  return (
    <View className="gap-6">
      <Section title="Spend per day">
        <Row header cells={["Day", "Cost", "Calls"]} />
        {days.length === 0 ? (
          <Text className="text-xs text-neutral-500">No model calls yet.</Text>
        ) : null}
        {days.map((day) => (
          <Row
            key={day.day}
            testID={`day-${day.day}`}
            cells={[day.day, formatUsd(day.costUsd), String(day.calls)]}
          />
        ))}
      </Section>

      <Section title="By day, kind and model">
        <Row header cells={["Day", "Kind", "Model", "Cost", "Calls"]} />
        {costs.daily.map((row) => (
          <Row
            key={`${row.day}|${row.kind}|${row.model}|${row.household_id ?? "none"}`}
            cells={[row.day, row.kind, row.model, formatUsd(row.cost_usd), String(row.calls)]}
          />
        ))}
      </Section>

      <Section title="By prompt version">
        <Row header cells={["Prompt", "Calls", "Latency", "Errors"]} />
        {costs.byPrompt.map((row) => (
          <Row
            key={row.prompt_version ?? "none"}
            testID={`prompt-${row.prompt_version ?? "none"}`}
            cells={[
              row.prompt_version ?? "(none)",
              String(row.calls),
              formatLatency(row.avg_latency_ms),
              formatPercent(row.error_rate),
            ]}
          />
        ))}
      </Section>

      <Section title="Runs with no heartbeat">
        {costs.stalled.length === 0 ? (
          <Text testID="no-stalled" className="text-xs text-neutral-500">
            None. Every running run has a worker.
          </Text>
        ) : (
          <>
            <Row header cells={["Run", "Store", "Status", "Silent"]} />
            {costs.stalled.map((run) => (
              <Row
                key={run.run_id}
                testID={`stalled-${run.run_id}`}
                cells={[
                  run.run_id.slice(0, 8),
                  run.retailer,
                  run.status,
                  formatSilence(run.silent_seconds),
                ]}
              />
            ))}
          </>
        )}
      </Section>
    </View>
  );
}
