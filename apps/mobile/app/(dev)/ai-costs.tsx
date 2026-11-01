// Dev-only AI cost dashboard (WS15): the cost views from the observability migration as tables.
// Reach it at souvie://ai-costs in a development build. Release builds redirect home.
//
// It reads v_ai_cost_daily, v_ai_cost_by_prompt and v_runs_stalled as the signed-in member, so it
// shows the household's own numbers (Row Level Security applies). Nothing here is persisted.
import { Redirect } from "expo-router";
import { ErrorText, LoadingScreen, Screen } from "../../src/components/Screen";
import { SessionGuard } from "../../src/features/auth/SessionGuard";
import { AiCostTables } from "../../src/observability/AiCostTables";
import { useAiCosts } from "../../src/observability/aiCosts";

function AiCosts() {
  const costs = useAiCosts();
  if (costs.isPending) return <LoadingScreen label="Reading the cost views" />;
  return (
    <Screen
      title="AI costs"
      subtitle="Model spend from ai_runs, by day and by prompt. A refused call (the daily cap) is not counted as a call."
    >
      <ErrorText>{costs.isError ? costs.error.message : null}</ErrorText>
      {costs.data ? <AiCostTables costs={costs.data} /> : null}
    </Screen>
  );
}

export default function AiCostsScreen() {
  if (!__DEV__) return <Redirect href="/" />;
  return (
    <SessionGuard>
      <AiCosts />
    </SessionGuard>
  );
}
