// The worker end to end on PGlite with MockRetailer: enqueue -> plan -> needs_review -> approve
// (run-approve's own store) -> push -> cart_ready, with the transcript, the ledger, ai_runs and
// both notifications.
import type { MessageParam, ToolMessagesClient } from "@mp/llm";
import { RetailerAuthError } from "@mp/retailers";
import { MockRetailer } from "@mp/retailers/mock";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SqlApproveStore } from "../../../supabase/functions/run-approve/store.ts";
import { createModelSource } from "./models.ts";
import { parseRunMessage } from "./runner.ts";
import {
  ALICE,
  CONNECTION,
  createRunsTestDb,
  enqueue,
  HOUSEHOLD,
  lineId,
  type RunsTestDb,
  runRow,
  seedHousehold,
} from "./testing/fixtures.ts";
import { testWorker } from "./testing/worker.ts";

let t: RunsTestDb;

beforeAll(async () => {
  t = await createRunsTestDb();
  await seedHousehold(t, { allergies: ["peanut"] });
}, 120_000);

afterAll(async () => {
  await t?.close();
});

async function closeRuns() {
  await t.exec(
    `update public.shopping_runs set status = 'cancelled' where status in ('queued', 'running', 'needs_review', 'cart_ready', 'checking_out')`,
  );
  await t.exec("delete from pgmq.q_shopping_run");
}

/** A fake Anthropic client that picks candidate 0 for every line it is asked about. */
function chooser(): ToolMessagesClient {
  return {
    messages: {
      async create(params) {
        const messages = params.messages as MessageParam[];
        const turn = messages.filter((m) => m.role === "assistant").length;
        const first = messages[0];
        const text =
          typeof first?.content === "string"
            ? first.content
            : (first?.content ?? []).map((b) => ("text" in b ? b.text : "")).join("\n");
        const ids = [...text.matchAll(/^Line (\S+):/gm)].map((m) => m[1]);
        return {
          content: [
            ...ids.map((id, i) => ({
              type: "tool_use",
              id: `u${turn}${i}`,
              name: "choose_product",
              input: { listItemId: id, candidateIndex: 0, quantity: 1 },
            })),
            { type: "tool_use", id: `u${turn}r`, name: "request_review", input: {} },
          ],
          stop_reason: "tool_use",
          usage: {
            input_tokens: 2500,
            output_tokens: 500,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 2000,
          },
        };
      },
    },
  };
}

describe("a run through the worker", () => {
  it("plans to needs_review, then after approval fills the cart and reaches cart_ready", async () => {
    await closeRuns();
    const store = new (await import("./store.ts")).RunStore(t.runner);
    const models = createModelSource({
      toolClient: chooser(),
      parseClient: {
        messages: {
          parse: async () => ({
            parsed_output: { summary: "11 of 12 ready. Check the chicken broth." },
            stop_reason: "end_turn",
            usage: { input_tokens: 300, output_tokens: 40 },
          }),
        },
      },
      store,
      dailyCapUsd: 2,
      log: { info() {}, warn() {}, error() {} },
    });
    const worker = testWorker(t, { models });
    const runId = await enqueue(t, { per_item_ceiling_usd: 15 });

    // Plan.
    const planned = await worker.next();
    expect(planned?.outcome).toBe("done");
    let run = await runRow(t, runId);
    expect(run.status).toBe("needs_review");
    expect(run.heartbeat_at).toBeNull();
    const items = await t.query<{
      id: string;
      list_item_id: string;
      status: string;
      product_name: string | null;
      alternatives: unknown[] | null;
      flags: Array<{ kind: string }>;
    }>(
      `select id, list_item_id, status::text as status, product_name, alternatives, flags from public.shopping_run_items where run_id = $1 order by position`,
      [runId],
    );
    expect(items).toHaveLength(12);
    expect(items.filter((i) => i.status === "matched").length).toBeGreaterThanOrEqual(10);
    expect(worker.mock.calls.filter((c) => c.operation === "addToCart")).toEqual([]);
    expect(run.cart_snapshot).toMatchObject({
      storeName: "Mock QFC Duvall",
      summary: "11 of 12 ready. Check the chicken broth.",
    });
    expect(run.transcript.length).toBeGreaterThan(12);
    expect(worker.pushes[0]).toMatchObject({ type: "needs_review", runId });

    // Every model call wrote an ai_runs row for the household.
    const aiRuns = await t.query<{ kind: string; prompt_version: string; cost_usd: string }>(
      `select kind, prompt_version, cost_usd from public.ai_runs where household_id = $1 order by created_at`,
      [HOUSEHOLD],
    );
    expect(aiRuns.map((r) => r.kind)).toEqual(["agent_plan", "agent_step"]);
    expect(aiRuns.map((r) => r.prompt_version)).toEqual([
      "agent-system.v1",
      "agent-review-summary.v1",
    ]);
    expect(aiRuns.reduce((sum, r) => sum + Number(r.cost_usd), 0)).toBeLessThan(0.25);

    // Approve, swapping one line to its first alternative, through run-approve's store.
    const swappable = items.find(
      (i) => (i.alternatives?.length ?? 0) > 0 && i.status === "matched",
    );
    expect(swappable).toBeDefined();
    const approve = new SqlApproveStore(t.runner);
    const approved = await approve.approve({
      runId,
      householdId: HOUSEHOLD,
      userId: ALICE,
      decisions: [{ runItemId: swappable?.id ?? "", action: "swap", alternativeIndex: 0 }],
    });
    expect(approved.ok).toBe(true);
    run = await runRow(t, runId);
    expect(run.status).toBe("running");
    expect(run.heartbeat_at).toBeNull();

    // Push.
    const pushed = await worker.next();
    expect(pushed?.outcome).toBe("done");
    run = await runRow(t, runId);
    expect(run.status).toBe("cart_ready");
    expect(run.cart_snapshot?.handoffUrl).toMatch(/^https:\/\/mock-retailer\.test\/checkout/);
    const ledger = await t.query<{
      product_id: string;
      cart_qty: string;
      delta_result: string | null;
      user_decision: string | null;
    }>(
      `select product_id, cart_qty, delta_result, user_decision::text as user_decision from public.shopping_run_items where run_id = $1 and status in ('matched', 'substituted') order by position`,
      [runId],
    );
    expect(ledger.every((row) => row.delta_result === "204")).toBe(true);
    const cart = await worker.mock.getCart({
      connectionId: CONNECTION,
      retailer: "kroger",
      storeId: "MOCK0001",
    });
    expect(cart.items.map((i) => i.productId).sort()).toEqual(
      ledger.map((r) => r.product_id).sort(),
    );
    expect(cart.items.every((i) => i.modality === "PICKUP")).toBe(true);
    const ready = worker.pushes.at(-1);
    expect(ready).toMatchObject({ type: "cart_ready", runId, storeName: "Mock QFC Duvall" });
    expect(ready && "subtotalUsd" in ready ? ready.subtotalUsd : 0).toBeGreaterThan(0);
  });

  it("acks a stale message for a run waiting for review without touching it", async () => {
    await closeRuns();
    const worker = testWorker(t);
    const runId = await enqueue(t);
    await worker.next();
    expect((await runRow(t, runId)).status).toBe("needs_review");
    await t.query(`select public.shopping_run_dispatch($1::uuid)`, [runId]);
    const before = worker.mock.calls.length;
    const again = await worker.next();
    expect(again?.outcome).toBe("done");
    expect(worker.mock.calls.length).toBe(before);
    expect((await runRow(t, runId)).status).toBe("needs_review");
  });

  it("drops a product with a household allergen before review", async () => {
    await closeRuns();
    // The household is allergic to peanuts; add a peanut butter line.
    await t.exec(`
      insert into public.ingredients (id, name, category, default_unit) values ('11111111-0000-4000-8000-0000000009ff', 'peanut butter', 'pantry', 'tbsp') on conflict do nothing;
      insert into public.grocery_list_items (id, list_id, household_id, ingredient_id, display_name, qty, unit, section, position)
        values ('8a000000-0000-4000-8000-0000000009ff', '9a000000-0000-4000-8000-0000000000a9', '${HOUSEHOLD}', '11111111-0000-4000-8000-0000000009ff', 'Peanut butter', 16, 'oz', 'pantry', 99)
        on conflict do nothing;
    `);
    const worker = testWorker(t);
    const runId = await enqueue(t);
    await worker.next();
    const rows = await t.query<{ product_name: string | null; flags: Array<{ kind: string }> }>(
      `select product_name, flags from public.shopping_run_items where run_id = $1 and display_name = 'Peanut butter'`,
      [runId],
    );
    expect(rows[0]?.product_name).toBeNull();
    expect(rows[0]?.flags.map((f) => f.kind)).toContain("allergen");
    await t.exec(
      `delete from public.grocery_list_items where id = '8a000000-0000-4000-8000-0000000009ff'`,
    );
  });

  it("fails the run at once when the store connection needs a new sign-in, and marks the connection", async () => {
    await closeRuns();
    const mock = new MockRetailer({ seed: 1 });
    mock.setFailure("searchProducts", "auth");
    const worker = testWorker(t, { mock });
    const runId = await enqueue(t);
    const result = await worker.next();
    expect(result?.outcome).toBe("done");
    const run = await runRow(t, runId);
    expect(run.status).toBe("failed");
    expect(run.error).toMatch(/needs_reauth/);
    const conn = await t.query<{ status: string }>(
      `select status::text as status from public.retailer_connections where id = $1`,
      [CONNECTION],
    );
    expect(conn[0]?.status).toBe("needs_reauth");
    expect(RetailerAuthError).toBeDefined();
    await t.exec(
      `update public.retailer_connections set status = 'active' where id = '${CONNECTION}'`,
    );
  });

  it("stops planning when the person cancels, and writes no proposal", async () => {
    await closeRuns();
    const mock = new MockRetailer({ seed: 1, latencyMs: 5 });
    const worker = testWorker(t, { mock });
    const runId = await enqueue(t);
    const [message] = await worker.queue.read("shopping_run", 900, 1);
    if (!message) throw new Error("no message");
    const handling = worker.runner.handle(message, new AbortController().signal);
    await new Promise((resolve) => setTimeout(resolve, 15));
    await t.query(`select public.cancel_shopping_run($1::uuid)`, [runId]);
    await handling;
    const run = await runRow(t, runId);
    expect(run.status).toBe("cancelled");
    const items = await t.query(`select 1 from public.shopping_run_items where run_id = $1`, [
      runId,
    ]);
    expect(items).toEqual([]);
  });

  it("reads only run messages", () => {
    expect(parseRunMessage({ run_id: "5A000000-0000-4000-8000-0000000000AA" })).toBe(
      "5a000000-0000-4000-8000-0000000000aa",
    );
    expect(parseRunMessage({ run_id: "nope" })).toBeNull();
    expect(parseRunMessage("x")).toBeNull();
    expect(lineId(0)).toMatch(/^8a/);
  });
});
