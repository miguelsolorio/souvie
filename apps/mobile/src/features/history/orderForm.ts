// The order form's state and its checks (WS12), shared by the "Did you place this order?" sheet
// and the edit sheet on an order. Pure, so Vitest runs it. The fields are text because that is what
// a text box holds; `validateForm` turns them into what `confirmOrder` and `updateOrder` take.
import { HISTORY_LIMITS, isoDateOf, type Modality, type Order, parseMoneyInput } from "@mp/core";
import { totalFieldText } from "./format";
import { buildWindow, clockText } from "./pickupWindow";

export interface OrderFormState {
  /** What the person paid, as typed: "98.50". */
  total: string;
  modality: Modality;
  /** Whether a pickup or delivery window is being entered. */
  windowOn: boolean;
  /** The window's day, YYYY-MM-DD. */
  day: string;
  start: string;
  end: string;
  retailerOrderId: string;
  notes: string;
}

export type OrderFormField = "total" | "start" | "end" | "retailerOrderId" | "notes";
export type OrderFormErrors = Partial<Record<OrderFormField, string>>;

export const TOTAL_ERROR = "Enter the total you paid, like 98.50.";

/** A new form for a run: the total starts at the run's subtotal, the modality at its connection's. */
export function initialForm(args: {
  subtotal: number | null;
  modality: Modality | null;
  today: string;
}): OrderFormState {
  return {
    total: totalFieldText(args.subtotal),
    modality: args.modality ?? "pickup",
    windowOn: false,
    day: args.today,
    start: "",
    end: "",
    retailerOrderId: "",
    notes: "",
  };
}

/** A form filled from an order that exists, to correct it. */
export function formFromOrder(
  order: Pick<
    Order,
    "total_usd" | "modality" | "slot_start" | "slot_end" | "retailer_order_id" | "notes"
  >,
  today: string,
): OrderFormState {
  return {
    total: totalFieldText(order.total_usd),
    modality: order.modality,
    windowOn: order.slot_start !== null,
    day: order.slot_start ? isoDateOf(new Date(order.slot_start)) : today,
    start: order.slot_start ? clockText(order.slot_start) : "",
    end: order.slot_end ? clockText(order.slot_end) : "",
    retailerOrderId: order.retailer_order_id ?? "",
    notes: order.notes ?? "",
  };
}

export interface OrderFormValue {
  total: number;
  modality: Modality;
  slotStart: string | null;
  slotEnd: string | null;
  retailerOrderId: string | null;
  notes: string | null;
}

export type OrderFormResult =
  | { ok: true; value: OrderFormValue }
  | { ok: false; errors: OrderFormErrors };

/** Reads the form: every problem at once, so the person fixes them in one pass. */
export function validateForm(state: OrderFormState): OrderFormResult {
  const errors: OrderFormErrors = {};

  const total = parseMoneyInput(state.total);
  if (total === null) errors.total = TOTAL_ERROR;

  let slotStart: string | null = null;
  let slotEnd: string | null = null;
  if (state.windowOn) {
    if (state.start.trim() === "") {
      errors.start = "Enter when the window starts, like 4:00 pm.";
    } else {
      const window = buildWindow({ day: state.day, start: state.start, end: state.end });
      if (window.ok) {
        slotStart = window.slotStart;
        slotEnd = window.slotEnd;
      } else {
        errors[window.field] = window.message;
      }
    }
  }

  const retailerOrderId = state.retailerOrderId.trim();
  if (retailerOrderId.length > HISTORY_LIMITS.retailerOrderId) {
    errors.retailerOrderId = `Keep the order number to ${HISTORY_LIMITS.retailerOrderId} characters.`;
  }
  const notes = state.notes.trim();
  if (notes.length > HISTORY_LIMITS.notes) {
    errors.notes = `Keep notes to ${HISTORY_LIMITS.notes} characters.`;
  }

  if (Object.keys(errors).length > 0 || total === null) return { ok: false, errors };
  return {
    ok: true,
    value: {
      total,
      modality: state.modality,
      slotStart,
      slotEnd,
      retailerOrderId: retailerOrderId === "" ? null : retailerOrderId,
      notes: notes === "" ? null : notes,
    },
  };
}

/** The input `confirmOrder` takes, from a checked form. Empty optional fields are left out. */
export function toConfirmInput(value: OrderFormValue) {
  return {
    total: value.total,
    modality: value.modality,
    ...(value.slotStart ? { slotStart: value.slotStart } : {}),
    ...(value.slotEnd ? { slotEnd: value.slotEnd } : {}),
    ...(value.retailerOrderId ? { retailerOrderId: value.retailerOrderId } : {}),
    ...(value.notes ? { notes: value.notes } : {}),
  };
}

/** The patch `updateOrder` takes: every field, so clearing a window or a note saves too. */
export function toOrderPatch(value: OrderFormValue) {
  return {
    total_usd: value.total,
    modality: value.modality,
    slot_start: value.slotStart,
    slot_end: value.slotEnd,
    retailer_order_id: value.retailerOrderId,
    notes: value.notes,
  };
}
