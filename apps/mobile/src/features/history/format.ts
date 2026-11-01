// Display helpers for the History screens (WS12). Pure, so they are unit-tested.
//
// Dates are the planner's calendar dates; names come from the fixed English tables in
// ../plan/format.ts, not Intl, so a phone's locale cannot change a word. The times of an order's
// window are shown in the device's own zone, which is where the person set them.
import {
  isoDateOf,
  type MealSlot,
  type Modality,
  type OrderStatus,
  type RetailerId,
} from "@mp/core";
import { longDate, SLOT_LABELS, shortDayName, shortMonthDay } from "../plan/format";

/** "$1,234.50". The household's own totals, always two decimals. */
export function formatUsd(amount: number): string {
  const [whole = "0", cents = "00"] = Math.abs(amount).toFixed(2).split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${amount < 0 ? "-" : ""}$${grouped}.${cents}`;
}

/** A total as the text field shows it: no symbol, no grouping, two decimals. */
export function totalFieldText(amount: number | null | undefined): string {
  return amount === null || amount === undefined ? "" : amount.toFixed(2);
}

export const RETAILER_NAME: Readonly<Record<RetailerId, string>> = {
  kroger: "Kroger",
  safeway: "Safeway",
  costco: "Costco",
};

/**
 * The store as the run recorded it, else the retailer's name. A retailer this table does not know
 * (the app's run type carries it as plain text) is shown as it is stored.
 */
export function storeLabel(store: { store_name: string | null; retailer: string }): string {
  const name = store.store_name?.trim();
  if (name) return name;
  return RETAILER_NAME[store.retailer as RetailerId] ?? store.retailer;
}

export const ORDER_STATUS_LABEL: Readonly<Record<OrderStatus, string>> = {
  confirmed: "Placed",
  picked_up: "Picked up",
  delivered: "Delivered",
  cancelled: "Cancelled",
};

export const MODALITY_LABEL: Readonly<Record<Modality, string>> = {
  pickup: "Pickup",
  delivery: "Delivery",
};

export const SLOT_NAME: Readonly<Record<MealSlot, string>> = SLOT_LABELS;

/** What a cooked meal is called when its recipe is gone. */
export const RECIPE_GONE = "Recipe unavailable";

/** "4:00 pm". */
export function clockLabel(date: Date): string {
  const hour = date.getHours();
  const minute = String(date.getMinutes()).padStart(2, "0");
  const twelve = hour % 12 === 0 ? 12 : hour % 12;
  return `${twelve}:${minute} ${hour < 12 ? "am" : "pm"}`;
}

/** "Mon, Nov 2", the device's day for an instant. */
export function dayLabel(instant: string | Date): string {
  const day = isoDateOf(typeof instant === "string" ? new Date(instant) : instant);
  return `${shortDayName(day)}, ${shortMonthDay(day)}`;
}

/**
 * A pickup or delivery window in words: "Wed, Nov 4, 4:00 pm to 5:00 pm", or "Wed, Nov 4, from
 * 4:00 pm" when only the start is known. Empty when there is no window.
 */
export function windowLabel(start: string | null, end: string | null): string {
  if (!start) return "";
  const from = new Date(start);
  const day = dayLabel(from);
  if (!end) return `${day}, from ${clockLabel(from)}`;
  const to = new Date(end);
  const sameDay = isoDateOf(from) === isoDateOf(to);
  return sameDay
    ? `${day}, ${clockLabel(from)} to ${clockLabel(to)}`
    : `${day}, ${clockLabel(from)} to ${dayLabel(to)}, ${clockLabel(to)}`;
}

/** "Tuesday, November 3" for a heading over a day's cooked meals. */
export const cookedDayLabel = longDate;

/** "1 order", "2 orders". */
export function orderCountLabel(count: number): string {
  return count === 1 ? "1 order" : `${count} orders`;
}

/** "1 meal", "3 meals". */
export function mealCountLabel(count: number): string {
  return count === 1 ? "1 meal" : `${count} meals`;
}

/** "Bought once", "Bought 3 times". */
export function timesBoughtLabel(count: number): string {
  if (count === 1) return "Bought once";
  return `Bought ${count} times`;
}
