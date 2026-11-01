// Mouse and keyboard input for the seven-column planner (WS13). Plain DOM, no React and no
// react-native, so it runs under jsdom in a test and in a browser as it is.
//
// Why DOM and not props: react-native-web does not pass `draggable` or the drag events through
// its View, and the planner needs no gesture library for this. Instead the week grid is marked up
// with test IDs that react-native-web writes out as `data-testid`, and this file reads them:
//
//   open-day-<date>          a day's header button
//   slot-<date>-<slot>       one meal slot of one day (a drop target)
//   entry-<id>               a planned meal (draggable)
//   add-<date>-<slot>        the "+ Add" button of a slot
//
// What it adds:
//   * Drag a meal with the mouse onto any slot of any day to move it there.
//   * Arrow keys move focus between days (left and right, in the same meal row) and down or up a
//     day's column. Tab still walks every control in order.

import { MEAL_SLOTS, type MealSlot } from "@mp/core";

const SLOT_ID = /^slot-(\d{4}-\d{2}-\d{2})-(breakfast|lunch|dinner|snack)$/;
const DAY_HEADER_ID = /^open-day-(\d{4}-\d{2}-\d{2})$/;

export interface SlotTarget {
  date: string;
  slot: MealSlot;
}

/** The day and slot a `slot-<date>-<slot>` test ID names, or null for anything else. */
export function parseSlotId(testId: string | null | undefined): SlotTarget | null {
  const match = testId ? SLOT_ID.exec(testId) : null;
  if (!match) return null;
  return { date: match[1] as string, slot: match[2] as MealSlot };
}

/** The entry id an `entry-<id>` test ID names, or null. */
export function parseEntryId(testId: string | null | undefined): string | null {
  if (!testId?.startsWith("entry-")) return null;
  const id = testId.slice("entry-".length);
  return id.length > 0 ? id : null;
}

/** The date a day header's `open-day-<date>` test ID names, or null. */
export function parseDayHeaderId(testId: string | null | undefined): string | null {
  const match = testId ? DAY_HEADER_ID.exec(testId) : null;
  return match ? (match[1] as string) : null;
}

const byTestId = (id: string) => `[data-testid="${id}"]`;

/** The controls of one day, top to bottom: the header, then each slot's meals and its Add button. */
export function columnControls(root: ParentNode, date: string): HTMLElement[] {
  const controls: HTMLElement[] = [];
  const header = root.querySelector<HTMLElement>(byTestId(`open-day-${date}`));
  if (header) controls.push(header);
  for (const slot of MEAL_SLOTS) {
    const cell = root.querySelector<HTMLElement>(byTestId(`slot-${date}-${slot}`));
    if (!cell) continue;
    controls.push(
      ...cell.querySelectorAll<HTMLElement>('[data-testid^="entry-"], [data-testid^="add-"]'),
    );
  }
  return controls;
}

/** The dates the grid shows, left to right, read from the day headers. */
export function gridDates(root: ParentNode): string[] {
  const dates: string[] = [];
  for (const header of root.querySelectorAll<HTMLElement>('[data-testid^="open-day-"]')) {
    const date = parseDayHeaderId(header.getAttribute("data-testid"));
    if (date) dates.push(date);
  }
  return dates;
}

export type ArrowKey = "ArrowLeft" | "ArrowRight" | "ArrowUp" | "ArrowDown";

interface Position {
  date: string;
  /** "header", or the slot the control sits in. */
  row: "header" | MealSlot;
  controls: HTMLElement[];
  index: number;
}

function positionOf(root: ParentNode, active: Element): Position | null {
  const testId = active.getAttribute("data-testid");
  const headerDate = parseDayHeaderId(testId);
  const cell = active.closest<HTMLElement>('[data-testid^="slot-"]');
  const slotTarget = parseSlotId(cell?.getAttribute("data-testid"));
  const date = headerDate ?? slotTarget?.date;
  if (!date) return null;
  const controls = columnControls(root, date);
  const index = controls.indexOf(active as HTMLElement);
  if (index === -1) return null;
  return { date, row: headerDate ? "header" : (slotTarget as SlotTarget).slot, controls, index };
}

/**
 * The control an arrow key moves focus to from `active`, or null when it stays put.
 *   Left and right: the same row (the header, or the same meal slot) of the next day. In a slot
 *   with several controls the same place counts, else the last one.
 *   Down and up: the next or previous control in the same day's column.
 */
export function nextControl(root: ParentNode, active: Element, key: ArrowKey): HTMLElement | null {
  const here = positionOf(root, active);
  if (!here) return null;

  if (key === "ArrowDown") return here.controls[here.index + 1] ?? null;
  if (key === "ArrowUp") return here.controls[here.index - 1] ?? null;

  const dates = gridDates(root);
  const target = dates[dates.indexOf(here.date) + (key === "ArrowRight" ? 1 : -1)];
  if (!target) return null;

  if (here.row === "header") {
    return root.querySelector<HTMLElement>(byTestId(`open-day-${target}`));
  }
  const cell = root.querySelector<HTMLElement>(byTestId(`slot-${target}-${here.row}`));
  const own = root.querySelector<HTMLElement>(byTestId(`slot-${here.date}-${here.row}`));
  if (!cell) return null;
  const targetControls = [
    ...cell.querySelectorAll<HTMLElement>('[data-testid^="entry-"], [data-testid^="add-"]'),
  ];
  const ownControls = own
    ? [...own.querySelectorAll<HTMLElement>('[data-testid^="entry-"], [data-testid^="add-"]')]
    : [];
  const place = Math.max(0, ownControls.indexOf(active as HTMLElement));
  return targetControls[Math.min(place, targetControls.length - 1)] ?? null;
}

export interface GridInputHandlers {
  /** A meal was dropped on a slot. */
  onMove: (entryId: string, target: SlotTarget) => void;
}

const DRAG_TYPE = "text/plain";
const DROP_BACKGROUND = "rgba(47, 107, 79, 0.14)";

/** The element an event was aimed at. Duck-typed, so it works in any window (and in a test). */
function elementOf(event: Event): Element | null {
  const target = event.target as Partial<Element> | null;
  return target && typeof target.closest === "function" ? (target as Element) : null;
}

/**
 * Wires drag-to-move and the arrow keys onto the week grid `root`. Returns a function that undoes
 * all of it. Safe to call again after the grid re-renders, since entries are marked by an observer.
 */
export function attachGridInput(root: HTMLElement, handlers: GridInputHandlers): () => void {
  let dragging: string | null = null;
  let lit: HTMLElement | null = null;

  const mark = () => {
    for (const chip of root.querySelectorAll<HTMLElement>('[data-testid^="entry-"]')) {
      if (chip.getAttribute("draggable") !== "true") chip.setAttribute("draggable", "true");
    }
  };
  mark();
  const view = root.ownerDocument.defaultView;
  const observer = view ? new view.MutationObserver(mark) : null;
  observer?.observe(root, { childList: true, subtree: true });

  const unlight = () => {
    if (lit) lit.style.backgroundColor = "";
    lit = null;
  };

  const onDragStart = (event: DragEvent) => {
    const chip = elementOf(event)?.closest<HTMLElement>('[data-testid^="entry-"]');
    const id = parseEntryId(chip?.getAttribute("data-testid"));
    if (!chip || !id || !event.dataTransfer) return;
    dragging = id;
    event.dataTransfer.setData(DRAG_TYPE, id);
    event.dataTransfer.effectAllowed = "move";
    chip.style.opacity = "0.5";
  };

  const onDragEnd = (event: DragEvent) => {
    dragging = null;
    unlight();
    const chip = elementOf(event)?.closest<HTMLElement>('[data-testid^="entry-"]');
    if (chip) chip.style.opacity = "";
  };

  const slotAt = (event: Event): { cell: HTMLElement; target: SlotTarget } | null => {
    const cell = elementOf(event)?.closest<HTMLElement>('[data-testid^="slot-"]');
    const target = parseSlotId(cell?.getAttribute("data-testid"));
    return cell && target ? { cell, target } : null;
  };

  const onDragOver = (event: DragEvent) => {
    if (!dragging) return;
    const hit = slotAt(event);
    if (!hit) {
      unlight();
      return;
    }
    // preventDefault on dragover is what tells the browser this element accepts a drop.
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
    if (lit !== hit.cell) {
      unlight();
      lit = hit.cell;
      lit.style.backgroundColor = DROP_BACKGROUND;
    }
  };

  const onDrop = (event: DragEvent) => {
    const hit = slotAt(event);
    const id = dragging ?? event.dataTransfer?.getData(DRAG_TYPE) ?? null;
    unlight();
    dragging = null;
    if (!hit || !id) return;
    event.preventDefault();
    handlers.onMove(id, hit.target);
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    if (
      event.key !== "ArrowLeft" &&
      event.key !== "ArrowRight" &&
      event.key !== "ArrowUp" &&
      event.key !== "ArrowDown"
    ) {
      return;
    }
    const active = root.ownerDocument.activeElement;
    if (!active || !root.contains(active)) return;
    const next = nextControl(root, active, event.key);
    if (!next) return;
    event.preventDefault();
    next.focus();
  };

  root.addEventListener("dragstart", onDragStart);
  root.addEventListener("dragend", onDragEnd);
  root.addEventListener("dragover", onDragOver);
  root.addEventListener("drop", onDrop);
  root.addEventListener("keydown", onKeyDown);

  return () => {
    observer?.disconnect();
    root.removeEventListener("dragstart", onDragStart);
    root.removeEventListener("dragend", onDragEnd);
    root.removeEventListener("dragover", onDragOver);
    root.removeEventListener("drop", onDrop);
    root.removeEventListener("keydown", onKeyDown);
    unlight();
  };
}
