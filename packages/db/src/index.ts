// @mp/db: Generated Supabase types, typed query helpers, and RLS test fixtures.
// WS01 adds the client wrapper, the identity helpers, and the session and household hooks.
// WS04 adds the planner hooks, the Realtime subscription, and the planning helpers.
// WS05 adds the grocery list and pantry hooks, the replay queue, and the list Realtime subscription.
// WS11 adds scheduled runs, quiet hours, notification preferences and device tokens.
// WS12 adds the orders and History readers and their hooks.
// Later workstreams add hooks for the tables they own.
export const packageName = "@mp/db";

export * from "./client";
export * from "./context";
export * from "./history";
export * from "./hooks/useAddManualItem";
export * from "./hooks/useBuildList";
export * from "./hooks/useDeleteEntry";
export * from "./hooks/useGroceryList";
export * from "./hooks/useGroceryListItems";
export * from "./hooks/useHistory";
export * from "./hooks/useHousehold";
export * from "./hooks/useHouseholdMembers";
export * from "./hooks/useImportRecipe";
export * from "./hooks/useMealPlan";
export * from "./hooks/useMealPlanEntries";
export * from "./hooks/useNotificationSettings";
export * from "./hooks/useOrders";
export * from "./hooks/usePantry";
export * from "./hooks/useProfile";
export * from "./hooks/useRecipe";
export * from "./hooks/useRecipeFeedback";
export * from "./hooks/useRecipes";
export * from "./hooks/useSchedules";
export * from "./hooks/useSession";
export * from "./hooks/useSetPlanMode";
export * from "./hooks/useToggleItem";
export * from "./hooks/useUpsertEntry";
export * from "./identity";
export * from "./ids";
export * from "./lists";
export * from "./offline/listQueue";
export * from "./offline/replayQueue";
export * from "./orders";
export * from "./planning";
export * from "./realtime/lists";
export * from "./realtime/planning";
export * from "./schedules";
export type {
  CompositeTypes,
  Database,
  Enums,
  Json,
  Tables,
  TablesInsert,
  TablesUpdate,
} from "./types.generated";
