// CI smoke helper (WS09): approves a run with run-approve's own store over postgres.js, as the
// Edge Function does after auth.getUser, so the function's SQL runs on the real Postgres in CI
// (PGlite passes a string bound to ::jsonb through, postgres.js does not). It swaps the first line
// that has an alternative and keeps the rest.
//
//   DB_URL=... tsx scripts/approve.ts <runId> <userId>
import postgres from "postgres";
import type { PgClient } from "../../../supabase/functions/run-approve/sql.ts";
import { runnerOf } from "../../../supabase/functions/run-approve/sql.ts";
import { SqlApproveStore } from "../../../supabase/functions/run-approve/store.ts";

async function main(): Promise<void> {
  const [runId, userId] = process.argv.slice(2);
  const url = process.env.DB_URL;
  if (!url || !runId || !userId)
    throw new Error("usage: DB_URL=... tsx scripts/approve.ts <runId> <userId>");
  const sql = postgres(url, { prepare: false, max: 2, onnotice: () => {} });
  try {
    const store = new SqlApproveStore(runnerOf(sql as unknown as PgClient));
    const membership = await store.resolveRun(userId, runId);
    if (membership.kind !== "member")
      throw new Error("the user is not a member of the run's household");
    const rows = await sql<{ id: string }[]>`
      select id from public.shopping_run_items
       where run_id = ${runId} and alternatives is not null and jsonb_array_length(alternatives) > 0
       order by position limit 1`;
    const swap = rows[0];
    const result = await store.approve({
      runId,
      householdId: membership.householdId,
      userId,
      decisions: swap ? [{ runItemId: swap.id, action: "swap", alternativeIndex: 0 }] : [],
    });
    console.log(JSON.stringify({ ...result, swapped: swap ? 1 : 0 }));
    if (!result.ok) process.exitCode = 1;
  } finally {
    await sql.end({ timeout: 2 });
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
