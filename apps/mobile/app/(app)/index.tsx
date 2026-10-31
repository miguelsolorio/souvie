import { Redirect } from "expo-router";
import { PLAN_ROUTE } from "../../src/features/plan/routes";

/**
 * The app's root route sends everyone to the planner, which is the home screen (WS04). The plan
 * screen sends people with no household on to create or join one. The old landing screen, with the
 * links to recipes, household settings and profile, is the menu (./menu.tsx).
 */
export default function Home() {
  return <Redirect href={PLAN_ROUTE} />;
}
