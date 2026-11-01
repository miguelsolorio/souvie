// Database access for run-approve (WS09), all through one SqlRunner.
//
// The function connects as the database owner (SUPABASE_DB_URL). Every transaction starts with
// `set local role service_role`, as list-build does: table privileges and RLS bypass like the
// service role, no DDL. Membership is resolved first, in its own statement, before anything about
// the run is read, and the household id in every later statement comes from that check. A run of
// another household and a run that does not exist give the same answer, so the endpoint is no
// oracle for run ids.
//
// The review itself is @mp/agent's applyReview (packages/agent/src/review.ts), imported by path:
// the same code the replay tests run.
import {
  applyReview,
  goesToCart,
  type ReviewableItem,
  type ReviewDecision,
} from "../../../packages/agent/src/review.ts";
import type { SqlRunner } from "./sql.ts";

export const SERVICE_ROLE_STATEMENT = "set local role service_role";

export type RunMembership = { kind: "member"; householdId: string } | { kind: "not_found" };

export type ApproveResult =
  | { ok: true; runId: string; status: "running"; subtotalUsd: number; itemCount: number }
  | { ok: false; error: "not_reviewable" | "empty_cart" | "over_budget" }
  | { ok: false; error: "invalid_decision"; details: string[] };

interface ItemRow {
  id: string;
  status: ReviewableItem["status"];
  product_id: string | null;
  upc: string | null;
  product_name: string | null;
  size: string | null;
  qty: number | null;
  unit_price_usd: number | null;
  line_total_usd: number | null;
  alternatives: ReviewableItem["alternatives"];
  user_decision: ReviewableItem["userDecision"];
  ingredient_id: string | null;
}

export class SqlApproveStore {
  constructor(private readonly sql: SqlRunner) {}

  private inServiceRole<T>(fn: (tx: SqlRunner) => Promise<T>): Promise<T> {
    return this.sql.transaction(async (tx) => {
      await tx.query(SERVICE_ROLE_STATEMENT, []);
      return fn(tx);
    });
  }

  /** The run's household, when the caller is a member of it. Nothing else is read here. */
  async resolveRun(userId: string, runId: string): Promise<RunMembership> {
    return this.inServiceRole(async (tx) => {
      const rows = await tx.query<{ household_id: string }>(
        `select r.household_id
           from public.shopping_runs r
           join public.household_members m on m.household_id = r.household_id and m.user_id = $2::uuid
           join public.households h on h.id = r.household_id and h.deleted_at is null
          where r.id = $1::uuid`,
        [runId, userId],
      );
      const first = rows[0];
      return first ? { kind: "member", householdId: first.household_id } : { kind: "not_found" };
    });
  }

  /**
   * Applies the review and opens the push phase, in one transaction: the decisions, the approved
   * subtotal checked against the budget cap, the household's confirmed choices into
   * product_matches, needs_review -> running, and the queue message for the worker. Any refusal
   * writes nothing.
   */
  async approve(input: {
    runId: string;
    householdId: string;
    userId: string;
    decisions: readonly ReviewDecision[];
  }): Promise<ApproveResult> {
    const { runId, householdId, userId } = input;
    return this.inServiceRole(async (tx) => {
      const runs = await tx.query<{
        status: string;
        policy: { budget_cap_usd?: number | null } | null;
        retailer: string;
        store_id: string | null;
      }>(
        `select r.status::text as status, r.policy, r.retailer::text as retailer, r.store_id
           from public.shopping_runs r
          where r.id = $1::uuid and r.household_id = $2::uuid
          for update`,
        [runId, householdId],
      );
      const run = runs[0];
      if (run?.status !== "needs_review") return { ok: false, error: "not_reviewable" };

      const rows = await tx.query<ItemRow>(
        `select i.id, i.status::text as status, i.product_id, i.upc, i.product_name, i.size,
                i.qty::float8 as qty, i.unit_price_usd::float8 as unit_price_usd,
                i.line_total_usd::float8 as line_total_usd, i.alternatives,
                i.user_decision::text as user_decision, gli.ingredient_id
           from public.shopping_run_items i
           left join public.grocery_list_items gli on gli.id = i.list_item_id
          where i.run_id = $1::uuid and i.household_id = $2::uuid
          order by i.position, i.id`,
        [runId, householdId],
      );
      const items: ReviewableItem[] = rows.map((row) => ({
        id: row.id,
        status: row.status,
        productId: row.product_id,
        upc: row.upc,
        productName: row.product_name,
        size: row.size,
        qty: row.qty,
        unitPriceUsd: row.unit_price_usd,
        lineTotalUsd: row.line_total_usd,
        alternatives: row.alternatives,
        userDecision: row.user_decision,
      }));
      const review = applyReview(items, input.decisions);
      if (review.errors.length > 0)
        return { ok: false, error: "invalid_decision", details: review.errors };
      if (review.cartLines === 0) return { ok: false, error: "empty_cart" };
      const cap = run.policy?.budget_cap_usd;
      if (typeof cap === "number" && review.subtotalUsd > cap)
        return { ok: false, error: "over_budget" };

      await tx.query(
        `update public.shopping_run_items i
            set status = r.status::public.shopping_run_items_status, product_id = r.product_id,
                upc = r.upc, product_name = r.product_name, size = r.size, qty = r.qty,
                unit_price_usd = r.unit_price_usd, line_total_usd = r.line_total_usd,
                alternatives = r.alternatives,
                user_decision = r.user_decision::public.shopping_run_items_user_decision
           from jsonb_to_recordset($3::text::jsonb) as r(
             id uuid, status text, product_id text, upc text, product_name text, size text,
             qty numeric, unit_price_usd numeric, line_total_usd numeric, alternatives jsonb,
             user_decision text
           )
          where i.id = r.id and i.run_id = $1::uuid and i.household_id = $2::uuid`,
        [
          runId,
          householdId,
          JSON.stringify(
            review.items.map((item) => ({
              id: item.id,
              status: item.status,
              product_id: item.productId,
              upc: item.upc,
              product_name: item.productName,
              size: item.size,
              qty: item.qty,
              unit_price_usd: item.unitPriceUsd,
              line_total_usd: item.lineTotalUsd,
              alternatives:
                item.alternatives && item.alternatives.length > 0 ? item.alternatives : null,
              user_decision: item.userDecision,
            })),
          ),
        ],
      );

      // The household confirmed these products: remember them (ids, name, size; no price).
      const ingredientOf = new Map(rows.map((row) => [row.id, row.ingredient_id]));
      const learned = review.items
        .filter(
          (item) =>
            goesToCart(item) && ingredientOf.get(item.id) && item.productId && item.productName,
        )
        .map((item) => ({
          ingredient_id: ingredientOf.get(item.id),
          product_id: item.productId,
          upc: item.upc,
          product_name: item.productName,
          size: item.size,
          chosen_by: item.userDecision === "swapped" ? "user" : "agent",
        }));
      if (run.store_id && learned.length > 0) {
        await tx.query(
          `insert into public.product_matches (
             household_id, retailer, store_id, ingredient_id, product_id, upc, product_name, size,
             chosen_by, pinned, last_chosen_at
           )
           select $1::uuid, $2::public.retailer, $3, r.ingredient_id, r.product_id, r.upc,
                  r.product_name, r.size, r.chosen_by::public.product_matches_chosen_by, false, now()
             from jsonb_to_recordset($4::text::jsonb) as r(
               ingredient_id uuid, product_id text, upc text, product_name text, size text,
               chosen_by text
             )
           on conflict on constraint product_matches_choice_key do update
              set last_chosen_at = now(), product_name = excluded.product_name,
                  size = excluded.size,
                  chosen_by = case when excluded.chosen_by = 'user' then 'user'::public.product_matches_chosen_by
                                   else public.product_matches.chosen_by end`,
          [householdId, run.retailer, run.store_id, JSON.stringify(learned)],
        );
      }

      await tx.query(
        `update public.shopping_runs r
            set status = 'running', approved_at = now(), approved_by = $3::uuid,
                subtotal_usd = $4, heartbeat_at = null,
                progress = jsonb_build_object('phase', 'pushing', 'done', 0, 'total', $5::integer)
          where r.id = $1::uuid and r.household_id = $2::uuid`,
        [runId, householdId, userId, review.subtotalUsd, review.cartLines],
      );
      await tx.query(`select public.shopping_run_dispatch($1::uuid)`, [runId]);
      return {
        ok: true,
        runId,
        status: "running",
        subtotalUsd: review.subtotalUsd,
        itemCount: review.cartLines,
      };
    });
  }
}
