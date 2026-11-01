import type { Page } from "@playwright/test";
import {
  ENTRIES,
  HOUSEHOLD,
  IDS,
  LIST,
  LIST_ITEMS,
  NOW,
  PLAN,
  PROFILE,
  RUN,
  RUN_ITEMS,
  USER,
} from "../fixtures/world";
import { FakeSupabase, makeSession, sessionStorageKey } from "./fakeSupabase";

/** A fake Supabase holding the test household's data (fixtures/world.ts). */
export function worldSupabase(): FakeSupabase {
  const fake = new FakeSupabase();
  fake.signedInUser = { ...USER };
  fake
    .seed("household_members", [
      {
        household_id: IDS.household,
        user_id: IDS.user,
        role: "owner",
        invited_by: null,
        created_at: "2026-10-01T12:00:00.000Z",
        households: HOUSEHOLD,
      },
    ])
    .seed("profiles", [PROFILE])
    .seed("meal_plans", [PLAN])
    .seed("meal_plan_entries", ENTRIES)
    .seed("grocery_lists", [LIST])
    .seed("grocery_list_items", LIST_ITEMS)
    .seed("shopping_runs", [RUN])
    .seed("shopping_run_items", RUN_ITEMS)
    .seed("recipes", [])
    .seed("recipe_feedback", [])
    .seed("pantry_items", [])
    .seed("ingredients", [])
    .seed("push_tokens", [])
    .seed("retailer_connections", []);
  fake.edgeFunction("health", () => ({ ok: true, version: "browser-test" }));
  return fake;
}

/**
 * Starts a page the way a signed-in visitor would find it: the clock fixed to Wednesday 4
 * November 2026, a stored session, and the fake Supabase answering. Call before `page.goto`.
 */
export async function openSignedIn(page: Page, fake: FakeSupabase): Promise<void> {
  await page.clock.setFixedTime(NOW);
  fake.now = NOW;
  await fake.install(page);
  const session = makeSession({ ...USER }, NOW);
  await page.addInitScript(
    ({ key, value }) => {
      window.localStorage.setItem(key, value);
    },
    { key: sessionStorageKey(), value: JSON.stringify(session) },
  );
}

/** Starts a page nobody is signed in on. The fake still answers, for the sign-in round trip. */
export async function openSignedOut(page: Page, fake: FakeSupabase): Promise<void> {
  await page.clock.setFixedTime(NOW);
  fake.now = NOW;
  await fake.install(page);
}
