import { describe, expect, it } from "vitest";
import {
  arrivedStatus,
  confirmOrder,
  fetchOrder,
  fetchOrderForRun,
  fetchOrderLines,
  fetchRunForOrder,
  listOrders,
  ORDER_ERROR_MESSAGES,
  OrderError,
  orderErrorMessage,
  ordersKey,
  toOrderError,
  updateOrder,
} from "./orders";
import { eqFilters, opArgs, recordingClient } from "./testing/recordingClient";

const HOUSEHOLD = "0a000000-0000-4000-8000-00000000000a";
const RUN = "f2000000-0000-4000-8000-0000000000a1";
const ORDER = "52000000-0000-4000-8000-0000000000a1";

const orderRow = (over: Record<string, unknown> = {}) => ({
  id: ORDER,
  household_id: HOUSEHOLD,
  run_id: RUN,
  retailer: "kroger",
  retailer_order_id: null,
  modality: "pickup",
  slot_start: null,
  slot_end: null,
  total_usd: 100,
  status: "confirmed",
  confirmed_by: "a1111111-1111-4111-8111-111111111111",
  confirmed_at: "2026-11-02T18:00:00+00:00",
  notes: null,
  created_at: "2026-11-02T18:00:00+00:00",
  updated_at: "2026-11-02T18:00:00+00:00",
  // The embed PostgREST returns for the run's store.
  shopping_runs: { store_name: "Mock QFC Duvall" },
  ...over,
});

describe("toOrderError", () => {
  it("reads the codes confirm_order raises", () => {
    for (const code of [
      "not_authenticated",
      "run_not_found",
      "run_not_confirmable",
      "already_confirmed",
      "invalid_total",
      "invalid_window",
    ] as const) {
      expect(toOrderError({ message: code, code: "P0001" }, 400).code).toBe(code);
    }
  });

  it("reads the unique key as already confirmed, and a refused privilege as forbidden", () => {
    expect(toOrderError({ message: "duplicate key value", code: "23505" }, 409).code).toBe(
      "already_confirmed",
    );
    expect(toOrderError({ message: "permission denied", code: "42501" }, 403).code).toBe(
      "forbidden",
    );
  });

  it("reads a failed check as invalid", () => {
    expect(toOrderError({ message: "violates check", code: "23514" }, 400).code).toBe("invalid");
  });

  it("reads a request with no response, or a server fault, as network", () => {
    expect(toOrderError({ message: "TypeError: Failed to fetch" }, 0).code).toBe("network");
    expect(toOrderError({ message: "TypeError: Failed to fetch" }).code).toBe("network");
    expect(toOrderError({ message: "boom", code: "XX000" }, 503).code).toBe("network");
  });

  it("keeps anything else as unknown", () => {
    expect(toOrderError({ message: "something odd", code: "XX999" }, 400).code).toBe("unknown");
  });

  it("has a sentence for every code and words an error for the screen", () => {
    for (const message of Object.values(ORDER_ERROR_MESSAGES)) {
      expect(message.length).toBeGreaterThan(10);
      expect(message).not.toContain("—");
    }
    expect(orderErrorMessage(new OrderError("already_confirmed"))).toBe(
      ORDER_ERROR_MESSAGES.already_confirmed,
    );
    expect(orderErrorMessage(new Error("x"))).toBe(ORDER_ERROR_MESSAGES.unknown);
  });
});

describe("confirmOrder", () => {
  it("calls confirm_order with the total and nothing the person left out", async () => {
    const { client, calls } = recordingClient([{ data: ORDER }]);
    const id = await confirmOrder(client, RUN, { total: 123.45 });
    expect(id).toBe(ORDER);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.kind).toBe("rpc");
    expect(calls[0]?.target).toBe("confirm_order");
    expect(calls[0]?.args).toEqual({ run_id: RUN, total_usd: 123.45 });
  });

  it("sends the modality, window, order number and notes when given, trimmed", async () => {
    const { client, calls } = recordingClient([{ data: ORDER }]);
    await confirmOrder(client, RUN, {
      total: 55.5,
      modality: "delivery",
      slotStart: "2026-11-04T16:00:00-08:00",
      slotEnd: "2026-11-04T17:00:00-08:00",
      retailerOrderId: "  KRG-0042 ",
      notes: " side door ",
    });
    expect(calls[0]?.args).toEqual({
      run_id: RUN,
      total_usd: 55.5,
      modality: "delivery",
      slot_start: "2026-11-04T16:00:00-08:00",
      slot_end: "2026-11-04T17:00:00-08:00",
      retailer_order_id: "KRG-0042",
      notes: "side door",
    });
  });

  it("refuses a bad total or window before asking the server", async () => {
    const { client, calls } = recordingClient([{ data: ORDER }]);
    await expect(confirmOrder(client, RUN, { total: -1 })).rejects.toMatchObject({
      code: "invalid_total",
    });
    await expect(confirmOrder(client, RUN, { total: Number.NaN })).rejects.toMatchObject({
      code: "invalid_total",
    });
    await expect(
      confirmOrder(client, RUN, {
        total: 5,
        slotStart: "2026-11-04T17:00:00Z",
        slotEnd: "2026-11-04T16:00:00Z",
      }),
    ).rejects.toMatchObject({ code: "invalid_window" });
    await expect(
      confirmOrder(client, RUN, { total: 5, slotEnd: "2026-11-04T16:00:00Z" }),
    ).rejects.toMatchObject({ code: "invalid_window" });
    expect(calls).toHaveLength(0);
  });

  it("answers a second confirmation of a run with already_confirmed", async () => {
    const { client } = recordingClient([
      { error: { message: "already_confirmed", code: "P0001" }, status: 400 },
    ]);
    await expect(confirmOrder(client, RUN, { total: 10 })).rejects.toMatchObject({
      name: "OrderError",
      code: "already_confirmed",
    });
  });

  it("answers another household's run with run_not_found and a dead connection with network", async () => {
    const notFound = recordingClient([
      { error: { message: "run_not_found", code: "P0001" }, status: 400 },
    ]);
    await expect(confirmOrder(notFound.client, RUN, { total: 10 })).rejects.toMatchObject({
      code: "run_not_found",
    });
    const offline = recordingClient([
      { error: { message: "TypeError: Failed to fetch" }, status: 0 },
    ]);
    await expect(confirmOrder(offline.client, RUN, { total: 10 })).rejects.toMatchObject({
      code: "network",
    });
  });

  it("fails if the function answers with no id", async () => {
    const { client } = recordingClient([{ data: null }]);
    await expect(confirmOrder(client, RUN, { total: 10 })).rejects.toBeInstanceOf(OrderError);
  });
});

describe("listOrders", () => {
  it("reads the household's orders newest first, 200 at most, without the Tier 3 details", async () => {
    const { client, calls } = recordingClient([{ data: [orderRow({ total_usd: "40.5" })] }]);
    const orders = await listOrders(client, HOUSEHOLD);
    expect(orders).toHaveLength(1);
    expect(orders[0]?.total_usd).toBe(40.5);
    expect(orders[0]?.store_name).toBe("Mock QFC Duvall");
    const call = calls[0];
    expect(call?.target).toBe("orders");
    expect(eqFilters(call)).toEqual([["household_id", HOUSEHOLD]]);
    expect(opArgs(call, "order")).toEqual(["confirmed_at", { ascending: false }]);
    expect(opArgs(call, "limit")).toEqual([200]);
    expect(String(opArgs(call, "select")?.[0])).not.toContain("raw");
    expect(String(opArgs(call, "select")?.[0])).toContain("shopping_runs(store_name)");
  });

  it("applies the range and the limit", async () => {
    const { client, calls } = recordingClient([{ data: [] }]);
    await listOrders(client, HOUSEHOLD, {
      from: "2026-10-01T00:00:00Z",
      to: "2026-11-01T00:00:00Z",
      limit: 5,
    });
    expect(opArgs(calls[0], "gte")).toEqual(["confirmed_at", "2026-10-01T00:00:00Z"]);
    expect(opArgs(calls[0], "lt")).toEqual(["confirmed_at", "2026-11-01T00:00:00Z"]);
    expect(opArgs(calls[0], "limit")).toEqual([5]);
  });

  it("throws on a row that does not match the schema and on a failed request", async () => {
    const bad = recordingClient([{ data: [orderRow({ status: "refunded" })] }]);
    await expect(listOrders(bad.client, HOUSEHOLD)).rejects.toBeInstanceOf(OrderError);
    const failed = recordingClient([{ error: { message: "boom", code: "XX000" }, status: 500 }]);
    await expect(listOrders(failed.client, HOUSEHOLD)).rejects.toMatchObject({ code: "network" });
  });

  it("keys the cache by household and range, so households never share an entry", () => {
    expect(ordersKey("h1")).not.toEqual(ordersKey("h2"));
    expect(ordersKey("h1", { from: "a" })).not.toEqual(ordersKey("h1", { from: "b" }));
    expect(ordersKey("h1")[0]).toBe("orders");
    expect(ordersKey("h1")[1]).toBe("h1");
  });
});

describe("fetchOrder and fetchOrderForRun", () => {
  it("find one order by id, scoped to the household", async () => {
    const { client, calls } = recordingClient([{ data: orderRow() }]);
    const order = await fetchOrder(client, HOUSEHOLD, ORDER);
    expect(order?.id).toBe(ORDER);
    expect(order?.store_name).toBe("Mock QFC Duvall");
    expect(eqFilters(calls[0])).toEqual([
      ["household_id", HOUSEHOLD],
      ["id", ORDER],
    ]);
  });

  it("find the order of a run, or null while nobody confirmed one", async () => {
    const found = recordingClient([{ data: orderRow() }]);
    expect((await fetchOrderForRun(found.client, HOUSEHOLD, RUN))?.run_id).toBe(RUN);
    expect(eqFilters(found.calls[0])).toContainEqual(["run_id", RUN]);
    const none = recordingClient([{ data: null }]);
    expect(await fetchOrderForRun(none.client, HOUSEHOLD, RUN)).toBeNull();
    // A run whose store was never recorded still reads as an order, with no store name.
    const unnamed = recordingClient([{ data: orderRow({ shopping_runs: null }) }]);
    expect((await fetchOrderForRun(unnamed.client, HOUSEHOLD, RUN))?.store_name).toBeNull();
    expect(await fetchOrder(recordingClient([{ data: null }]).client, HOUSEHOLD, ORDER)).toBeNull();
  });
});

describe("fetchRunForOrder", () => {
  const runRow = {
    id: RUN,
    status: "cart_ready",
    retailer: "kroger",
    store_name: "Mock QFC Duvall",
    subtotal_usd: "98.00",
    approved_at: "2026-11-02T17:00:00+00:00",
    finished_at: "2026-11-02T17:05:00+00:00",
    connection_id: "72000000-0000-4000-8000-0000000000a1",
  };

  it("reads the run and the modality of its connection", async () => {
    const { client, calls } = recordingClient([
      { data: runRow },
      { data: { modality: "delivery" } },
    ]);
    const run = await fetchRunForOrder(client, HOUSEHOLD, RUN);
    expect(run).toMatchObject({
      id: RUN,
      status: "cart_ready",
      store_name: "Mock QFC Duvall",
      subtotal_usd: 98,
      modality: "delivery",
    });
    expect(calls.map((call) => call.target)).toEqual(["shopping_runs", "retailer_connections"]);
  });

  it("has no modality when the connection is gone, and asks nothing about it", async () => {
    const { client, calls } = recordingClient([{ data: { ...runRow, connection_id: null } }]);
    const run = await fetchRunForOrder(client, HOUSEHOLD, RUN);
    expect(run?.modality).toBeNull();
    expect(calls).toHaveLength(1);
  });

  it("is null for a run that is not in the household", async () => {
    const { client } = recordingClient([{ data: null }]);
    expect(await fetchRunForOrder(client, HOUSEHOLD, RUN)).toBeNull();
  });
});

describe("fetchOrderLines", () => {
  it("reads what the store's cart held, in list order, with the amounts as numbers", async () => {
    const { client, calls } = recordingClient([
      {
        data: [
          {
            id: "i1",
            display_name: "Yellow onions",
            product_name: "Harbor Fields Yellow Onions",
            size: "3 lb bag",
            cart_qty: "2",
            unit_price_usd: "3.49",
            line_total_usd: 6.98,
          },
          {
            id: "i2",
            display_name: "Candles",
            product_name: null,
            size: null,
            cart_qty: 1,
            unit_price_usd: null,
            line_total_usd: null,
          },
        ],
      },
    ]);
    const lines = await fetchOrderLines(client, HOUSEHOLD, RUN);
    expect(lines).toEqual([
      {
        id: "i1",
        display_name: "Yellow onions",
        product_name: "Harbor Fields Yellow Onions",
        size: "3 lb bag",
        quantity: 2,
        unit_price_usd: 3.49,
        line_total_usd: 6.98,
      },
      {
        id: "i2",
        display_name: "Candles",
        product_name: null,
        size: null,
        quantity: 1,
        unit_price_usd: null,
        line_total_usd: null,
      },
    ]);
    expect(eqFilters(calls[0])).toEqual([
      ["household_id", HOUSEHOLD],
      ["run_id", RUN],
    ]);
    expect(opArgs(calls[0], "gt")).toEqual(["cart_qty", 0]);
    expect(opArgs(calls[0], "order")).toEqual(["position", { ascending: true }]);
  });
});

describe("updateOrder", () => {
  it("sends only the columns given and returns the saved order", async () => {
    const { client, calls } = recordingClient([{ data: orderRow({ status: "cancelled" }) }]);
    const order = await updateOrder(client, ORDER, { status: "cancelled" });
    expect(order.status).toBe("cancelled");
    expect(opArgs(calls[0], "update")).toEqual([{ status: "cancelled" }]);
    expect(eqFilters(calls[0])).toEqual([["id", ORDER]]);
  });

  it("refuses an empty change and an invalid one before asking the server", async () => {
    const { client, calls } = recordingClient([]);
    await expect(updateOrder(client, ORDER, {})).rejects.toMatchObject({ code: "invalid" });
    await expect(updateOrder(client, ORDER, { total_usd: -1 })).rejects.toMatchObject({
      code: "invalid_total",
    });
    await expect(
      updateOrder(client, ORDER, { slot_start: "tomorrow" as never }),
    ).rejects.toMatchObject({ code: "invalid_window" });
    expect(calls).toHaveLength(0);
  });

  it("says not_found when row level security hides the order, so nothing was updated", async () => {
    const { client } = recordingClient([{ data: null }]);
    await expect(updateOrder(client, ORDER, { notes: "x" })).rejects.toMatchObject({
      code: "not_found",
    });
  });
});

describe("arrivedStatus", () => {
  it("is picked up for a pickup and delivered for a delivery", () => {
    expect(arrivedStatus("pickup")).toBe("picked_up");
    expect(arrivedStatus("delivery")).toBe("delivered");
  });
});
