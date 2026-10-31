// Database access for the shopper worker (WS09), all through one SqlRunner.
//
// The worker connects with WORKER_DATABASE_URL as the database owner, which bypasses Row Level
// Security and could run DDL. So every statement on an application table runs in a transaction
// that starts with `set local role service_role` (orchestrator correction 4, the list-build
// precedent): it keeps the table privileges the worker needs, still bypasses RLS like the service
// role, and loses the owner's DDL (store.test.ts proves a `create table` inside fails).
//
// pgmq is different: the service role has no grant on the pgmq schema (ws09_runs_rls.sql proves
// it on the real stack), so queue.ts calls pgmq as the connection role, outside these
// transactions. Nothing widens the service role's grants.
//
// Because RLS is bypassed, every query names the household. The run is found by id (the queue
// message), and the household id in every later statement comes from that row. The sweeper is the
// one statement that spans households, by design: it resumes or fails runs whose worker died.

import type {
  CartSnapshot,
  ItemFlag,
  LedgerStore,
  ListLine,
  ProductChoice,
  ProposedItem,
  PushRow,
  RunFlag,
  RunProgress,
  RunStatus,
  TranscriptEntry,
} from "@mp/agent";
import type { Allergen } from "@mp/core";
import { ALLERGENS, toAdapterModality } from "@mp/core";
import type { AiRunRow } from "@mp/llm";
import type { ConnectionHandle, RetailerId } from "@mp/retailers";
import type { SqlRunner } from "./sql.ts";

export const SERVICE_ROLE_STATEMENT = "set local role service_role";

/** Times the sweeper resumes one run's push after its worker died, before it fails the run. */
export const MAX_SWEEP_RESUMES = 2;

/** What one sweep did. */
export interface SweepResult {
  /** Approved runs handed back to the queue: their push resumes from the ledger. */
  requeued: string[];
  failed: string[];
}

/** A run the worker holds, as the claim returned it. */
export interface ClaimedRun {
  id: string;
  householdId: string;
  listId: string;
  connectionId: string | null;
  retailer: RetailerId;
  storeId: string | null;
  storeName: string | null;
  policy: unknown;
  approvedAt: string | null;
  subtotalUsd: number | null;
}

export interface ConnectionRow {
  id: string;
  retailer: RetailerId;
  authType: "oauth" | "browser_session" | "none";
  storeId: string | null;
  storeName: string | null;
  modality: "pickup" | "delivery";
  status: "active" | "needs_reauth" | "revoked";
}

export interface PlanningInput {
  lines: ListLine[];
  choices: ProductChoice[];
  allergies: Allergen[];
  /** Each member's preferences object, for the soft shopping preferences. */
  memberPreferences: unknown[];
  connection: ConnectionRow | null;
}

export class InvalidAllergyError extends Error {
  constructor(value: unknown) {
    super(
      `a member's allergies hold a value outside the vocabulary: ${String(value).slice(0, 40)}`,
    );
    this.name = "InvalidAllergyError";
  }
}

interface LineRow {
  id: string;
  display_name: string;
  qty: number | null;
  unit: string | null;
  section: string;
  position: number;
  qualifiers: string[] | null;
  needs_attention: boolean;
  detail: unknown;
  ingredient_id: string | null;
  ingredient_name: string | null;
  category: string | null;
  default_unit: string | null;
  density_g_per_ml: number | null;
  typical_unit_weight_g: number | null;
}

/** The recipe lines behind an item's amount (grocery_list_items.detail.contributions[].rawTexts). */
export function rawTextsOf(detail: unknown): string[] {
  const contributions = (detail as { contributions?: unknown } | null)?.contributions;
  if (!Array.isArray(contributions)) return [];
  const out: string[] = [];
  for (const contribution of contributions) {
    const texts = (contribution as { rawTexts?: unknown } | null)?.rawTexts;
    if (!Array.isArray(texts)) continue;
    for (const text of texts) if (typeof text === "string" && text.trim()) out.push(text.trim());
  }
  return [...new Set(out)].slice(0, 6);
}

/**
 * The union of the members' allergies. A member who never answered adds none (WS06). A value
 * outside ALLERGENS stops the run: a typo must not quietly filter nothing.
 */
export function unionAllergies(preferences: readonly unknown[]): Allergen[] {
  const out = new Set<Allergen>();
  for (const prefs of preferences) {
    const allergies = (prefs as { allergies?: unknown } | null)?.allergies;
    if (allergies === undefined || allergies === null) continue;
    if (!Array.isArray(allergies)) throw new InvalidAllergyError(allergies);
    for (const value of allergies) {
      if (!(ALLERGENS as readonly unknown[]).includes(value)) throw new InvalidAllergyError(value);
      out.add(value as Allergen);
    }
  }
  return [...out].sort();
}

const RPC_SIGNATURES: Readonly<
  Record<string, { args: Array<[string, string]>; returnsSet: boolean }>
> = {
  retailer_read_refresh_token: { args: [["p_connection_id", "uuid"]], returnsSet: false },
  retailer_rotate_refresh_token: {
    args: [
      ["p_connection_id", "uuid"],
      ["p_refresh_token", "text"],
    ],
    returnsSet: false,
  },
  retailer_mark_needs_reauth: { args: [["p_connection_id", "uuid"]], returnsSet: false },
  retailer_quota_consume: {
    args: [
      ["p_retailer", "public.retailer"],
      ["p_endpoint", "text"],
      ["p_day", "date"],
      ["p_ceiling", "integer"],
      ["p_amount", "integer"],
    ],
    returnsSet: true,
  },
  retailer_quota_raise: {
    args: [
      ["p_retailer", "public.retailer"],
      ["p_endpoint", "text"],
      ["p_day", "date"],
      ["p_count", "integer"],
    ],
    returnsSet: false,
  },
};

export class RunStore {
  constructor(private readonly sql: SqlRunner) {}

  /** Runs `fn` in one transaction as service_role. Every method below goes through it. */
  inServiceRole<T>(fn: (tx: SqlRunner) => Promise<T>): Promise<T> {
    return this.sql.transaction(async (tx) => {
      await tx.query(SERVICE_ROLE_STATEMENT, []);
      return fn(tx);
    });
  }

  /**
   * Takes a run for this worker: a queued run (the planning phase, or an approved run handed
   * back), or an approved run waiting for a worker (running, no heartbeat). One statement, so two
   * workers cannot both take it.
   */
  async claim(runId: string): Promise<ClaimedRun | null> {
    const rows = await this.inServiceRole((tx) =>
      tx.query<{
        id: string;
        household_id: string;
        list_id: string;
        connection_id: string | null;
        retailer: RetailerId;
        store_id: string | null;
        store_name: string | null;
        policy: unknown;
        approved_at: Date | string | null;
        subtotal_usd: number | null;
      }>(
        `update public.shopping_runs r
            set status = 'running', heartbeat_at = now(), error = null
          where r.id = $1::uuid
            and (r.status = 'queued' or (r.status = 'running' and r.heartbeat_at is null))
        returning r.id, r.household_id, r.list_id, r.connection_id, r.retailer::text as retailer,
                  r.store_id, r.store_name, r.policy, r.approved_at,
                  r.subtotal_usd::float8 as subtotal_usd`,
        [runId],
      ),
    );
    const row = rows[0];
    if (!row) return null;
    return {
      id: row.id,
      householdId: row.household_id,
      listId: row.list_id,
      connectionId: row.connection_id,
      retailer: row.retailer,
      storeId: row.store_id,
      storeName: row.store_name,
      policy: row.policy,
      approvedAt: row.approved_at ? new Date(row.approved_at).toISOString() : null,
      subtotalUsd: row.subtotal_usd,
    };
  }

  async status(runId: string): Promise<RunStatus | null> {
    const rows = await this.inServiceRole((tx) =>
      tx.query<{ status: RunStatus }>(
        `select r.status::text as status from public.shopping_runs r where r.id = $1::uuid`,
        [runId],
      ),
    );
    return rows[0]?.status ?? null;
  }

  async loadPlanningInput(run: ClaimedRun): Promise<PlanningInput> {
    return this.inServiceRole(async (tx) => {
      const lineRows = await tx.query<LineRow>(
        `select gli.id, gli.display_name, gli.qty::float8 as qty, gli.unit, gli.section,
                gli.position, gli.qualifiers, gli.needs_attention, gli.detail,
                i.id as ingredient_id, i.name as ingredient_name, i.category, i.default_unit,
                i.density_g_per_ml::float8 as density_g_per_ml,
                i.typical_unit_weight_g::float8 as typical_unit_weight_g
           from public.grocery_list_items gli
           left join public.ingredients i on i.id = gli.ingredient_id
          where gli.list_id = $1::uuid and gli.household_id = $2::uuid
            and gli.excluded_reason is null and gli.checked = false
          order by gli.position, gli.id`,
        [run.listId, run.householdId],
      );
      const lines: ListLine[] = lineRows.map((row) => ({
        id: row.id,
        displayName: row.display_name,
        qty: row.qty,
        unit: row.unit,
        section: row.section,
        position: row.position,
        ingredient:
          row.ingredient_id && row.ingredient_name && row.category && row.default_unit
            ? {
                id: row.ingredient_id,
                name: row.ingredient_name,
                category: row.category,
                defaultUnit: row.default_unit,
                densityGPerMl: row.density_g_per_ml,
                typicalUnitWeightG: row.typical_unit_weight_g,
              }
            : null,
        qualifiers: row.qualifiers ?? [],
        needsAttention: row.needs_attention,
        rawTexts: rawTextsOf(row.detail),
      }));

      const ingredientIds = [
        ...new Set(lines.flatMap((line) => (line.ingredient ? [line.ingredient.id] : []))),
      ];
      const choices =
        run.storeId && ingredientIds.length > 0
          ? (
              await tx.query<{
                ingredient_id: string;
                product_id: string;
                upc: string | null;
                product_name: string;
                size: string | null;
                pinned: boolean;
                last_chosen_at: Date | string;
              }>(
                `select pm.ingredient_id, pm.product_id, pm.upc, pm.product_name, pm.size, pm.pinned,
                        pm.last_chosen_at
                   from public.product_matches pm
                  where pm.household_id = $1::uuid and pm.retailer = $2::public.retailer
                    and pm.store_id = $3 and pm.ingredient_id = any($4::uuid[])
                  order by pm.pinned desc, pm.last_chosen_at desc`,
                [run.householdId, run.retailer, run.storeId, ingredientIds],
              )
            ).map(
              (row): ProductChoice => ({
                ingredientId: row.ingredient_id,
                productId: row.product_id,
                upc: row.upc,
                productName: row.product_name,
                size: row.size,
                pinned: row.pinned,
                lastChosenAt: new Date(row.last_chosen_at).toISOString(),
              }),
            )
          : [];

      const preferences = (
        await tx.query<{ preferences: unknown }>(
          `select p.preferences
             from public.household_members m
             join public.profiles p on p.user_id = m.user_id
            where m.household_id = $1::uuid`,
          [run.householdId],
        )
      ).map((row) => row.preferences);

      const connection = run.connectionId
        ? ((
            await tx.query<{
              id: string;
              retailer: RetailerId;
              auth_type: ConnectionRow["authType"];
              store_id: string | null;
              store_name: string | null;
              modality: ConnectionRow["modality"];
              status: ConnectionRow["status"];
            }>(
              `select c.id, c.retailer::text as retailer, c.auth_type::text as auth_type,
                      c.store_id, c.store_name, c.modality::text as modality, c.status::text as status
                 from public.retailer_connections c
                where c.id = $1::uuid and c.household_id = $2::uuid`,
              [run.connectionId, run.householdId],
            )
          ).map(
            (row): ConnectionRow => ({
              id: row.id,
              retailer: row.retailer,
              authType: row.auth_type,
              storeId: row.store_id,
              storeName: row.store_name,
              modality: row.modality,
              status: row.status,
            }),
          )[0] ?? null)
        : null;

      return {
        lines,
        choices,
        allergies: unionAllergies(preferences),
        memberPreferences: preferences,
        connection,
      };
    });
  }

  /**
   * Writes the proposal and moves the run to needs_review (request_review), in one transaction.
   * Returns false, and writes nothing, when the run left `running` meanwhile (a cancel).
   */
  async writeProposal(
    run: ClaimedRun,
    proposal: { items: ProposedItem[]; snapshot: CartSnapshot; subtotalUsd: number },
  ): Promise<boolean> {
    return this.inServiceRole(async (tx) => {
      const held = await tx.query<{ id: string }>(
        `select r.id from public.shopping_runs r
          where r.id = $1::uuid and r.household_id = $2::uuid and r.status = 'running'
          for update`,
        [run.id, run.householdId],
      );
      if (held.length === 0) return false;
      await tx.query(
        `delete from public.shopping_run_items i where i.run_id = $1::uuid and i.household_id = $2::uuid`,
        [run.id, run.householdId],
      );
      const rows = proposal.items.map((item) => ({
        id: item.id,
        list_item_id: item.listItemId,
        position: item.position,
        display_name: item.displayName.slice(0, 500),
        section: item.section.slice(0, 40) || "other",
        product_id: item.product?.productId ?? null,
        upc: item.product?.upc ?? null,
        product_name: item.product?.name ?? null,
        size: item.product?.size ?? null,
        qty: item.qty,
        unit_price_usd: item.unitPriceUsd,
        line_total_usd: item.lineTotalUsd,
        status: item.status,
        alternatives: item.alternatives.length > 0 ? item.alternatives : null,
        flags: item.flags,
        reason: item.reason,
      }));
      if (rows.length > 0) {
        await tx.query(
          `insert into public.shopping_run_items (
             id, run_id, household_id, list_item_id, position, display_name, section, product_id,
             upc, product_name, size, qty, unit_price_usd, line_total_usd, status, alternatives,
             flags, reason
           )
           select r.id, $1::uuid, $2::uuid,
                  (select gli.id from public.grocery_list_items gli
                    where gli.id = r.list_item_id and gli.household_id = $2::uuid),
                  r.position, r.display_name, r.section, r.product_id, r.upc, r.product_name,
                  r.size, r.qty, r.unit_price_usd, r.line_total_usd,
                  r.status::public.shopping_run_items_status, r.alternatives,
                  coalesce(r.flags, '[]'::jsonb), r.reason
             from jsonb_to_recordset($3::text::jsonb) as r(
               id uuid, list_item_id uuid, position integer, display_name text, section text,
               product_id text, upc text, product_name text, size text, qty numeric,
               unit_price_usd numeric, line_total_usd numeric, status text, alternatives jsonb,
               flags jsonb, reason text
             )`,
          [run.id, run.householdId, JSON.stringify(rows)],
        );
      }
      await tx.query(
        `update public.shopping_runs r
            set status = 'needs_review', cart_snapshot = $3::text::jsonb, subtotal_usd = $4,
                progress = $5::text::jsonb
          where r.id = $1::uuid and r.household_id = $2::uuid`,
        [
          run.id,
          run.householdId,
          JSON.stringify(proposal.snapshot),
          proposal.subtotalUsd,
          JSON.stringify({
            phase: "reviewing",
            done: proposal.items.length,
            total: proposal.items.length,
          }),
        ],
      );
      return true;
    });
  }

  async appendTranscript(run: ClaimedRun, entries: readonly TranscriptEntry[]): Promise<void> {
    if (entries.length === 0) return;
    await this.inServiceRole((tx) =>
      tx.query(
        `update public.shopping_runs r
            set transcript = r.transcript || $3::text::jsonb
          where r.id = $1::uuid and r.household_id = $2::uuid
            and jsonb_array_length(r.transcript) < 2000`,
        [run.id, run.householdId, JSON.stringify(entries)],
      ),
    );
  }

  async setProgress(run: ClaimedRun, progress: RunProgress): Promise<void> {
    await this.inServiceRole((tx) =>
      tx.query(
        `update public.shopping_runs r set progress = $3::text::jsonb
          where r.id = $1::uuid and r.household_id = $2::uuid and r.status in ('running', 'checking_out')`,
        [run.id, run.householdId, JSON.stringify(progress)],
      ),
    );
  }

  /** The heartbeat: every run this worker holds, in one statement. */
  async heartbeat(runIds: readonly string[]): Promise<number> {
    if (runIds.length === 0) return 0;
    const rows = await this.inServiceRole((tx) =>
      tx.query<{ id: string }>(
        `update public.shopping_runs r set heartbeat_at = now()
          where r.id = any($1::uuid[]) and r.status in ('running', 'checking_out')
        returning r.id`,
        [runIds],
      ),
    );
    return rows.length;
  }

  /**
   * The sweeper: what to do with every run whose worker stopped beating for `staleSeconds`. The one
   * query that spans households; it reads no household data and writes only status, error and one
   * transcript note.
   *
   *   approved, running   requeued and dispatched: the push resumes from the ledger, so the items
   *                       already in the cart are not added twice. At most `maxResumes` times.
   *   anything else       failed: a plan that never reached review, a checkout, or a push that
   *                       keeps dying. The app warns when items may already be in the cart.
   *
   * The stale test is repeated in the UPDATE's own WHERE, so a second worker sweeping at the same
   * moment re-reads the row after the first one's commit and skips it.
   */
  async sweepStale(staleSeconds: number, maxResumes = MAX_SWEEP_RESUMES): Promise<SweepResult> {
    return this.inServiceRole(async (tx) => {
      const rows = await tx.query<{ id: string; status: string }>(
        `with stale as (
           select r.id,
                  r.status = 'running' and r.approved_at is not null
                    and (select count(*) from jsonb_array_elements(r.transcript) e
                          where e ->> 'tool' = 'resume') < $2::integer as resume
             from public.shopping_runs r
            where r.status in ('running', 'checking_out')
              and r.heartbeat_at is not null
              and r.heartbeat_at < now() - make_interval(secs => $1::integer)
         )
         update public.shopping_runs r
            set status = (case when s.resume then 'queued' else 'failed' end)::public.shopping_runs_status,
                error = case when s.resume then null
                             else 'stalled: no heartbeat for ' || $1::integer || ' seconds' end,
                transcript = case when s.resume then r.transcript || jsonb_build_array(jsonb_build_object(
                               'ts', now(), 'tool', 'resume', 'by', 'host', 'input', '{}'::jsonb,
                               'output_summary', 'The worker stopped mid-push. Resuming from the cart ledger.',
                               'ok', true))
                             else r.transcript end
           from stale s
          where r.id = s.id
            and r.status in ('running', 'checking_out')
            and r.heartbeat_at is not null
            and r.heartbeat_at < now() - make_interval(secs => $1::integer)
        returning r.id, r.status::text as status`,
        [Math.ceil(staleSeconds), maxResumes],
      );
      const requeued = rows.filter((row) => row.status === "queued").map((row) => row.id);
      for (const id of requeued) {
        await tx.query("select public.shopping_run_dispatch($1::uuid)", [id]);
      }
      return {
        requeued,
        failed: rows.filter((row) => row.status === "failed").map((row) => row.id),
      };
    });
  }

  /** Hands back a run by id alone: a retry or a shutdown that never loaded the row. */
  async requeueById(runId: string): Promise<boolean> {
    const rows = await this.inServiceRole((tx) =>
      tx.query<{ id: string }>(
        `update public.shopping_runs r set status = 'queued'
          where r.id = $1::uuid and r.status = 'running'
        returning r.id`,
        [runId],
      ),
    );
    return rows.length > 0;
  }

  /** Hands a run back to the queue (shutdown, a retry). The heartbeat clears with the status. */
  async requeue(run: Pick<ClaimedRun, "id" | "householdId">): Promise<boolean> {
    const rows = await this.inServiceRole((tx) =>
      tx.query<{ id: string }>(
        `update public.shopping_runs r set status = 'queued'
          where r.id = $1::uuid and r.household_id = $2::uuid and r.status = 'running'
        returning r.id`,
        [run.id, run.householdId],
      ),
    );
    return rows.length > 0;
  }

  /** Fails a run that is still active. Never touches a run a person cancelled. */
  async fail(runId: string, error: string): Promise<boolean> {
    const rows = await this.inServiceRole((tx) =>
      tx.query<{ id: string }>(
        `update public.shopping_runs r set status = 'failed', error = $2
          where r.id = $1::uuid
            and r.status in ('queued', 'running', 'needs_review', 'cart_ready', 'checking_out')
        returning r.id`,
        [runId, error.slice(0, 2000)],
      ),
    );
    return rows.length > 0;
  }

  /** The approved rows, as the ledger reads them, in list order. */
  async loadPushRows(run: ClaimedRun): Promise<PushRow[]> {
    const rows = await this.inServiceRole((tx) =>
      tx.query<{
        id: string;
        position: number;
        display_name: string;
        product_id: string | null;
        upc: string | null;
        qty: number | null;
        status: PushRow["status"];
        user_decision: PushRow["userDecision"];
        cart_qty: number;
        delta_sent: number | null;
        delta_result: string | null;
        sent_at: Date | string | null;
        unit_price_usd: number | null;
        category: string | null;
      }>(
        `select i.id, i.position, i.display_name, i.product_id, i.upc, i.qty::float8 as qty,
                i.status::text as status, i.user_decision::text as user_decision,
                i.cart_qty::float8 as cart_qty, i.delta_sent::float8 as delta_sent,
                i.delta_result, i.sent_at, i.unit_price_usd::float8 as unit_price_usd,
                ing.category
           from public.shopping_run_items i
           left join public.grocery_list_items gli on gli.id = i.list_item_id
           left join public.ingredients ing on ing.id = gli.ingredient_id
          where i.run_id = $1::uuid and i.household_id = $2::uuid
          order by i.position, i.id`,
        [run.id, run.householdId],
      ),
    );
    return rows.map((row) => ({
      id: row.id,
      position: row.position,
      displayName: row.display_name,
      productId: row.product_id,
      upc: row.upc,
      qty: row.qty,
      status: row.status,
      userDecision: row.user_decision,
      cartQty: row.cart_qty,
      deltaSent: row.delta_sent,
      deltaResult: row.delta_result,
      sentAt: row.sent_at ? new Date(row.sent_at).toISOString() : null,
      ingredientCategory: row.category,
      unitPriceUsd: row.unit_price_usd,
    }));
  }

  /** The ledger writes. Each is its own transaction, so it is durable before the cart call. */
  ledger(run: ClaimedRun): LedgerStore {
    return {
      markSent: async (rowId, deltaSent, sentAt) => {
        await this.inServiceRole((tx) =>
          tx.query(
            `update public.shopping_run_items i
                set delta_sent = $4, sent_at = $5::timestamptz, delta_result = null
              where i.id = $1::uuid and i.run_id = $2::uuid and i.household_id = $3::uuid`,
            [rowId, run.id, run.householdId, deltaSent, sentAt],
          ),
        );
      },
      markResult: async (rowId, result) => {
        await this.inServiceRole((tx) =>
          tx.query(
            `update public.shopping_run_items i
                set cart_qty = $4, delta_sent = $5, delta_result = $6
              where i.id = $1::uuid and i.run_id = $2::uuid and i.household_id = $3::uuid`,
            [rowId, run.id, run.householdId, result.cartQty, result.deltaSent, result.deltaResult],
          ),
        );
      },
    };
  }

  /**
   * Closes the push phase: cart_ready with the hand-off link (finish), or back to needs_review
   * when quota or the budget stopped it (the approval is cleared, so the person approves again).
   */
  async finishPush(
    run: ClaimedRun,
    outcome: {
      status: "cart_ready" | "needs_review";
      flags: RunFlag[];
      rowFlags: ReadonlyMap<string, ItemFlag[]>;
      handoffUrl: string | null;
      /** What the push put in the cart. At cart_ready it becomes the run's subtotal. */
      cartSubtotalUsd: number | null;
      /** The cart_ready headline, the same words as the notification. */
      summary?: string | null;
    },
  ): Promise<boolean> {
    return this.inServiceRole(async (tx) => {
      for (const [rowId, flags] of outcome.rowFlags) {
        await tx.query(
          `update public.shopping_run_items i set flags = i.flags || $4::text::jsonb
            where i.id = $1::uuid and i.run_id = $2::uuid and i.household_id = $3::uuid`,
          [rowId, run.id, run.householdId, JSON.stringify(flags)],
        );
      }
      const patch: Record<string, unknown> = {};
      if (outcome.handoffUrl) patch.handoffUrl = outcome.handoffUrl;
      const ready = outcome.status === "cart_ready" && outcome.cartSubtotalUsd !== null;
      if (ready) {
        patch.subtotalUsd = outcome.cartSubtotalUsd;
        if (outcome.summary) patch.summary = outcome.summary;
      }
      const rows = await tx.query<{ id: string }>(
        `update public.shopping_runs r
            set status = $3::text::public.shopping_runs_status,
                subtotal_usd = coalesce($7::numeric, r.subtotal_usd),
                cart_snapshot = coalesce(r.cart_snapshot, '{}'::jsonb) || $4::text::jsonb
                  || jsonb_build_object('flags',
                       coalesce(r.cart_snapshot -> 'flags', '[]'::jsonb) || $5::text::jsonb),
                approved_at = case when $3::text = 'needs_review' then null else r.approved_at end,
                approved_by = case when $3::text = 'needs_review' then null else r.approved_by end,
                progress = $6::text::jsonb
          where r.id = $1::uuid and r.household_id = $2::uuid and r.status = 'running'
        returning r.id`,
        [
          run.id,
          run.householdId,
          outcome.status,
          JSON.stringify(patch),
          JSON.stringify(outcome.flags),
          JSON.stringify({
            phase: outcome.status === "cart_ready" ? "done" : "reviewing",
            done: 1,
            total: 1,
          }),
          ready ? outcome.cartSubtotalUsd : null,
        ],
      );
      return rows.length > 0;
    });
  }

  /** Every member's push tokens. */
  async pushTokens(householdId: string): Promise<{ token: string; platform: string }[]> {
    return this.inServiceRole((tx) =>
      tx.query<{ token: string; platform: string }>(
        `select pt.token, pt.platform::text as platform
           from public.push_tokens pt
           join public.household_members m on m.user_id = pt.user_id
          where m.household_id = $1::uuid`,
        [householdId],
      ),
    );
  }

  /** Tokens Expo says no longer reach a device. Scoped to the household's members. */
  async removeTokens(householdId: string, tokens: readonly string[]): Promise<void> {
    if (tokens.length === 0) return;
    await this.inServiceRole((tx) =>
      tx.query(
        `delete from public.push_tokens pt
          where pt.token = any($2::text[])
            and pt.user_id in (select m.user_id from public.household_members m where m.household_id = $1::uuid)`,
        [householdId, tokens],
      ),
    );
  }

  async recordAiRun(row: AiRunRow): Promise<void> {
    await this.inServiceRole((tx) =>
      tx.query(
        `insert into public.ai_runs (
           household_id, kind, model, prompt_version, input_tokens, output_tokens,
           cache_read_tokens, cost_usd, latency_ms, ok, error
         ) values ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          row.household_id,
          row.kind,
          row.model,
          row.prompt_version,
          row.input_tokens,
          row.output_tokens,
          row.cache_read_tokens,
          row.cost_usd,
          row.latency_ms,
          row.ok,
          row.error,
        ],
      ),
    );
  }

  /** What the household spent on models today (UTC), for the daily cap. */
  async spentTodayUsd(householdId: string): Promise<number> {
    const rows = await this.inServiceRole((tx) =>
      tx.query<{ spent: number }>(
        `select coalesce(sum(a.cost_usd), 0)::float8 as spent
           from public.ai_runs a
          where a.household_id = $1::uuid
            and a.created_at >= date_trunc('day', now() at time zone 'utc') at time zone 'utc'`,
        [householdId],
      ),
    );
    return rows[0]?.spent ?? 0;
  }

  /** Calls one of WS07's service-role functions, supabase-js rpc style, for the Kroger adapter. */
  async rpc(
    fn: string,
    args: Record<string, unknown>,
  ): Promise<{ data: unknown; error: { message: string } | null }> {
    const signature = Object.hasOwn(RPC_SIGNATURES, fn) ? RPC_SIGNATURES[fn] : undefined;
    if (!signature) return { data: null, error: { message: `rpc ${fn} is not allowed here` } };
    const params = signature.args.map(([name]) => args[name] ?? null);
    const call = `public.${fn}(${signature.args.map(([name, type], i) => `${name} => $${i + 1}::${type}`).join(", ")})`;
    try {
      const rows = await this.inServiceRole((tx) =>
        signature.returnsSet
          ? tx.query<Record<string, unknown>>(`select * from ${call}`, params)
          : tx.query<{ result: unknown }>(`select ${call} as result`, params),
      );
      return {
        data: signature.returnsSet
          ? rows
          : ((rows[0] as { result: unknown } | undefined)?.result ?? null),
        error: null,
      };
    } catch (err) {
      return { data: null, error: { message: err instanceof Error ? err.message : String(err) } };
    }
  }
}

/** The adapter's handle for a connection row. */
export function connectionHandle(connection: ConnectionRow): ConnectionHandle {
  return {
    connectionId: connection.id,
    retailer: connection.retailer,
    storeId: connection.storeId,
    modality: toAdapterModality(connection.modality),
  };
}
