// @mp/db: Generated Supabase types, typed query helpers, and RLS test fixtures.
// WS01 adds the client wrapper, the identity helpers, and the session and household hooks.
// WS04 adds the planner hooks, the Realtime subscription, and the planning helpers.
// Later workstreams add hooks for the tables they own.
export const packageName = "@mp/db";

export * from "./client";
export * from "./context";
export * from "./hooks/useDeleteEntry";
export * from "./hooks/useHousehold";
export * from "./hooks/useHouseholdMembers";
export * from "./hooks/useImportRecipe";
export * from "./hooks/useMealPlan";
export * from "./hooks/useMealPlanEntries";
export * from "./hooks/useProfile";
export * from "./hooks/useRecipe";
export * from "./hooks/useRecipeFeedback";
export * from "./hooks/useRecipes";
export * from "./hooks/useSession";
export * from "./hooks/useUpsertEntry";
export * from "./identity";
export * from "./ids";
export * from "./planning";
export * from "./realtime/planning";
export type {
  CompositeTypes,
  Database,
  Enums,
  Json,
  Tables,
  TablesInsert,
  TablesUpdate,
} from "./types.generated";
