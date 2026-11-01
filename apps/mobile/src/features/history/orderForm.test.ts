import { ConfirmOrderInput, OrderPatch } from "@mp/core";
import { describe, expect, it } from "vitest";
import {
  formFromOrder,
  initialForm,
  type OrderFormState,
  TOTAL_ERROR,
  toConfirmInput,
  toOrderPatch,
  validateForm,
} from "./orderForm";

const local = (y: number, m: number, d: number, h: number, min = 0) =>
  new Date(y, m - 1, d, h, min).toISOString();

const form = (over: Partial<OrderFormState> = {}): OrderFormState => ({
  ...initialForm({ subtotal: 98, modality: "pickup", today: "2026-11-04" }),
  ...over,
});

describe("initialForm", () => {
  it("starts the total at the run's subtotal and the modality at its connection's", () => {
    expect(initialForm({ subtotal: 98, modality: "delivery", today: "2026-11-04" })).toEqual({
      total: "98.00",
      modality: "delivery",
      windowOn: false,
      day: "2026-11-04",
      start: "",
      end: "",
      retailerOrderId: "",
      notes: "",
    });
  });

  it("leaves the total empty with no subtotal and defaults to pickup", () => {
    const empty = initialForm({ subtotal: null, modality: null, today: "2026-11-04" });
    expect(empty.total).toBe("");
    expect(empty.modality).toBe("pickup");
  });
});

describe("validateForm", () => {
  it("accepts the prefilled form as it stands", () => {
    const result = validateForm(form());
    expect(result).toEqual({
      ok: true,
      value: {
        total: 98,
        modality: "pickup",
        slotStart: null,
        slotEnd: null,
        retailerOrderId: null,
        notes: null,
      },
    });
  });

  it("reads what the person typed for the total", () => {
    for (const [text, total] of [
      ["$123.45", 123.45],
      ["1,234.5", 1234.5],
      [" 40 ", 40],
    ] as const) {
      const result = validateForm(form({ total: text }));
      expect(result.ok && result.value.total).toBe(total);
    }
  });

  it("refuses a missing or unreadable total", () => {
    for (const total of ["", "abc", "-5", "1.234", "100000.01"]) {
      const result = validateForm(form({ total }));
      expect(result.ok, total).toBe(false);
      if (!result.ok) expect(result.errors.total).toBe(TOTAL_ERROR);
    }
  });

  it("builds the window in the device's zone when one is entered", () => {
    const result = validateForm(
      form({ windowOn: true, day: "2026-11-05", start: "4:00 pm", end: "5:00 pm" }),
    );
    expect(result).toMatchObject({
      ok: true,
      value: { slotStart: local(2026, 11, 5, 16), slotEnd: local(2026, 11, 5, 17) },
    });
  });

  it("ignores window text while the window is off", () => {
    const result = validateForm(form({ windowOn: false, start: "nonsense", end: "later" }));
    expect(result).toMatchObject({ ok: true, value: { slotStart: null, slotEnd: null } });
  });

  it("asks for a start when the window is on and empty", () => {
    const result = validateForm(form({ windowOn: true }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.start).toMatch(/starts/);
  });

  it("reports every problem at once", () => {
    const result = validateForm(
      form({ total: "x", windowOn: true, start: "4pm", end: "3pm", notes: "n".repeat(1001) }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(Object.keys(result.errors).sort()).toEqual(["end", "notes", "total"]);
    }
  });

  it("trims the order number and notes, and turns empty ones into null", () => {
    const result = validateForm(form({ retailerOrderId: "  KRG-1 ", notes: " side door " }));
    expect(result).toMatchObject({
      ok: true,
      value: { retailerOrderId: "KRG-1", notes: "side door" },
    });
    expect(validateForm(form({ retailerOrderId: "   ", notes: " " }))).toMatchObject({
      ok: true,
      value: { retailerOrderId: null, notes: null },
    });
  });

  it("refuses an order number past the database limit", () => {
    const result = validateForm(form({ retailerOrderId: "x".repeat(101) }));
    expect(result.ok).toBe(false);
  });
});

describe("what the form hands the readers", () => {
  const checked = (state: OrderFormState) => {
    const result = validateForm(state);
    if (!result.ok) throw new Error("form should be valid");
    return result.value;
  };

  it("makes a confirm input the schema accepts, leaving out what is empty", () => {
    const value = checked(form());
    const input = toConfirmInput(value);
    expect(input).toEqual({ total: 98, modality: "pickup" });
    expect(ConfirmOrderInput.safeParse(input).success).toBe(true);
  });

  it("carries the window, order number and notes when they are there", () => {
    const value = checked(
      form({
        windowOn: true,
        day: "2026-11-05",
        start: "4pm",
        end: "5pm",
        retailerOrderId: "KRG-1",
        notes: "side door",
      }),
    );
    const input = toConfirmInput(value);
    expect(input).toMatchObject({
      slotStart: local(2026, 11, 5, 16),
      slotEnd: local(2026, 11, 5, 17),
      retailerOrderId: "KRG-1",
      notes: "side door",
    });
    expect(ConfirmOrderInput.safeParse(input).success).toBe(true);
  });

  it("makes a patch that clears what the person emptied", () => {
    const patch = toOrderPatch(checked(form({ windowOn: false })));
    expect(patch).toEqual({
      total_usd: 98,
      modality: "pickup",
      slot_start: null,
      slot_end: null,
      retailer_order_id: null,
      notes: null,
    });
    expect(OrderPatch.safeParse(patch).success).toBe(true);
  });
});

describe("formFromOrder", () => {
  it("fills the form from an order with a window", () => {
    const state = formFromOrder(
      {
        total_usd: 55.5,
        modality: "delivery",
        slot_start: local(2026, 11, 4, 16),
        slot_end: local(2026, 11, 4, 17),
        retailer_order_id: "KRG-1",
        notes: "side door",
      },
      "2026-11-10",
    );
    expect(state).toEqual({
      total: "55.50",
      modality: "delivery",
      windowOn: true,
      day: "2026-11-04",
      start: "4:00 pm",
      end: "5:00 pm",
      retailerOrderId: "KRG-1",
      notes: "side door",
    });
  });

  it("fills the form from an order with none, on today", () => {
    const state = formFromOrder(
      {
        total_usd: 10,
        modality: "pickup",
        slot_start: null,
        slot_end: null,
        retailer_order_id: null,
        notes: null,
      },
      "2026-11-10",
    );
    expect(state).toMatchObject({ windowOn: false, day: "2026-11-10", start: "", end: "" });
  });

  it("round-trips: an unchanged form saves the same window", () => {
    const start = local(2026, 11, 4, 16);
    const end = local(2026, 11, 4, 17, 30);
    const state = formFromOrder(
      {
        total_usd: 1,
        modality: "pickup",
        slot_start: start,
        slot_end: end,
        retailer_order_id: null,
        notes: null,
      },
      "2026-11-10",
    );
    expect(validateForm(state)).toMatchObject({
      ok: true,
      value: { slotStart: start, slotEnd: end },
    });
  });
});
