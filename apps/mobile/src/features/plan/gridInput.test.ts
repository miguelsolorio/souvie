/// <reference types="node" />
import { JSDOM } from "jsdom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  attachGridInput,
  columnControls,
  gridDates,
  nextControl,
  parseDayHeaderId,
  parseEntryId,
  parseSlotId,
} from "./gridInput";

const DATES = ["2026-11-02", "2026-11-03", "2026-11-04"];

/**
 * A three-day, two-slot copy of the week grid's markup: the same test IDs react-native-web writes
 * out as data-testid. Monday has two dinners, Tuesday one, Wednesday none.
 */
function gridHtml(): string {
  const entries: Record<string, string[]> = {
    "2026-11-02-dinner": ["e1", "e2"],
    "2026-11-03-dinner": ["e3"],
    "2026-11-03-lunch": ["e4"],
  };
  const cell = (date: string, slot: string) => {
    const chips = (entries[`${date}-${slot}`] ?? [])
      .map((id) => `<div data-testid="entry-${id}" tabindex="0">${id}</div>`)
      .join("");
    return `<div data-testid="slot-${date}-${slot}">${chips}<div data-testid="add-${date}-${slot}" tabindex="0">+ Add</div></div>`;
  };
  const headers = DATES.map(
    (date) =>
      `<div data-testid="day-${date}"><div data-testid="open-day-${date}" tabindex="0">${date}</div></div>`,
  ).join("");
  const row = (slot: string) => `<div>${DATES.map((date) => cell(date, slot)).join("")}</div>`;
  return `<div data-testid="week-grid"><div>${headers}</div>${row("lunch")}${row("dinner")}</div>`;
}

let dom: JSDOM;
let root: HTMLElement;
let detach: (() => void) | undefined;

const q = (testId: string) =>
  root.querySelector<HTMLElement>(`[data-testid="${testId}"]`) as HTMLElement;

beforeEach(() => {
  dom = new JSDOM(`<body>${gridHtml()}</body>`);
  root = dom.window.document.querySelector('[data-testid="week-grid"]') as HTMLElement;
});

afterEach(() => {
  detach?.();
  detach = undefined;
  dom.window.close();
});

describe("test ID parsers", () => {
  it("reads a slot, an entry and a day header", () => {
    expect(parseSlotId("slot-2026-11-02-dinner")).toEqual({ date: "2026-11-02", slot: "dinner" });
    expect(parseSlotId("slot-2026-11-02-brunch")).toBeNull();
    expect(parseSlotId("add-2026-11-02-dinner")).toBeNull();
    expect(parseSlotId(null)).toBeNull();
    expect(parseEntryId("entry-4f1c")).toBe("4f1c");
    expect(parseEntryId("entry-")).toBeNull();
    expect(parseEntryId("add-2026-11-02-dinner")).toBeNull();
    expect(parseDayHeaderId("open-day-2026-11-02")).toBe("2026-11-02");
    expect(parseDayHeaderId("day-2026-11-02")).toBeNull();
  });
});

describe("the grid's shape", () => {
  it("lists the days left to right", () => {
    expect(gridDates(root)).toEqual(DATES);
  });

  it("lists a day's controls top to bottom: header, then each slot's meals and Add button", () => {
    const tuesday = columnControls(root, "2026-11-03").map((el) => el.getAttribute("data-testid"));
    expect(tuesday).toEqual([
      "open-day-2026-11-03",
      "entry-e4",
      "add-2026-11-03-lunch",
      "entry-e3",
      "add-2026-11-03-dinner",
    ]);
  });
});

describe("arrow keys", () => {
  it("move from a header to the next and previous day's header", () => {
    expect(nextControl(root, q("open-day-2026-11-02"), "ArrowRight")).toBe(
      q("open-day-2026-11-03"),
    );
    expect(nextControl(root, q("open-day-2026-11-03"), "ArrowLeft")).toBe(q("open-day-2026-11-02"));
  });

  it("stop at the first and last day", () => {
    expect(nextControl(root, q("open-day-2026-11-02"), "ArrowLeft")).toBeNull();
    expect(nextControl(root, q("open-day-2026-11-04"), "ArrowRight")).toBeNull();
  });

  it("move along a meal row to the same place in the next day's slot", () => {
    // Monday's second dinner is the second control in its slot; Tuesday's dinner has two.
    expect(nextControl(root, q("entry-e1"), "ArrowRight")).toBe(q("entry-e3"));
    expect(nextControl(root, q("entry-e2"), "ArrowRight")).toBe(q("add-2026-11-03-dinner"));
  });

  it("land on the last control when the next day's slot has fewer", () => {
    expect(nextControl(root, q("add-2026-11-02-dinner"), "ArrowRight")).toBe(
      q("add-2026-11-03-dinner"),
    );
    // Wednesday's dinner has only the Add button.
    expect(nextControl(root, q("entry-e3"), "ArrowRight")).toBe(q("add-2026-11-04-dinner"));
  });

  it("move down and up one day's column", () => {
    expect(nextControl(root, q("open-day-2026-11-03"), "ArrowDown")).toBe(q("entry-e4"));
    expect(nextControl(root, q("entry-e4"), "ArrowDown")).toBe(q("add-2026-11-03-lunch"));
    expect(nextControl(root, q("add-2026-11-03-lunch"), "ArrowDown")).toBe(q("entry-e3"));
    expect(nextControl(root, q("entry-e3"), "ArrowUp")).toBe(q("add-2026-11-03-lunch"));
    expect(nextControl(root, q("open-day-2026-11-03"), "ArrowUp")).toBeNull();
    expect(nextControl(root, q("add-2026-11-03-dinner"), "ArrowDown")).toBeNull();
  });

  it("move real focus when the key is pressed inside the grid", () => {
    detach = attachGridInput(root, { onMove: vi.fn() });
    q("open-day-2026-11-02").focus();
    q("open-day-2026-11-02").dispatchEvent(
      new dom.window.KeyboardEvent("keydown", {
        key: "ArrowRight",
        bubbles: true,
        cancelable: true,
      }),
    );
    expect(dom.window.document.activeElement).toBe(q("open-day-2026-11-03"));
  });

  it("leave a key with a modifier alone, so browser shortcuts still work", () => {
    detach = attachGridInput(root, { onMove: vi.fn() });
    q("open-day-2026-11-02").focus();
    const event = new dom.window.KeyboardEvent("keydown", {
      key: "ArrowRight",
      metaKey: true,
      bubbles: true,
      cancelable: true,
    });
    q("open-day-2026-11-02").dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    expect(dom.window.document.activeElement).toBe(q("open-day-2026-11-02"));
  });
});

describe("drag to move", () => {
  function dragEvent(type: string, store: Map<string, string>): Event {
    const event = new dom.window.Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(event, "dataTransfer", {
      value: {
        setData: (key: string, value: string) => store.set(key, value),
        getData: (key: string) => store.get(key) ?? "",
        effectAllowed: "none",
        dropEffect: "none",
      },
    });
    return event;
  }

  it("marks every meal draggable, including ones that appear later", async () => {
    detach = attachGridInput(root, { onMove: vi.fn() });
    expect(q("entry-e1").getAttribute("draggable")).toBe("true");
    expect(q("entry-e3").getAttribute("draggable")).toBe("true");
    // The Add button and the day header are not meals.
    expect(q("add-2026-11-02-dinner").getAttribute("draggable")).toBeNull();

    const later = dom.window.document.createElement("div");
    later.setAttribute("data-testid", "entry-late");
    q("slot-2026-11-04-lunch").append(later);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(later.getAttribute("draggable")).toBe("true");
  });

  it("moves a meal to the slot it is dropped on", () => {
    const onMove = vi.fn();
    detach = attachGridInput(root, { onMove });
    const store = new Map<string, string>();

    q("entry-e1").dispatchEvent(dragEvent("dragstart", store));
    expect(store.get("text/plain")).toBe("e1");

    const over = dragEvent("dragover", store);
    q("slot-2026-11-04-lunch").dispatchEvent(over);
    // Without preventDefault on dragover the browser would refuse the drop.
    expect(over.defaultPrevented).toBe(true);

    q("slot-2026-11-04-lunch").dispatchEvent(dragEvent("drop", store));
    expect(onMove).toHaveBeenCalledTimes(1);
    expect(onMove).toHaveBeenCalledWith("e1", { date: "2026-11-04", slot: "lunch" });
  });

  it("finds the slot when the drop lands on the Add button inside it", () => {
    const onMove = vi.fn();
    detach = attachGridInput(root, { onMove });
    const store = new Map<string, string>();
    q("entry-e3").dispatchEvent(dragEvent("dragstart", store));
    q("add-2026-11-02-lunch").dispatchEvent(dragEvent("drop", store));
    expect(onMove).toHaveBeenCalledWith("e3", { date: "2026-11-02", slot: "lunch" });
  });

  it("does nothing for a drop outside any slot", () => {
    const onMove = vi.fn();
    detach = attachGridInput(root, { onMove });
    const store = new Map<string, string>();
    q("entry-e1").dispatchEvent(dragEvent("dragstart", store));
    q("open-day-2026-11-03").dispatchEvent(dragEvent("drop", store));
    expect(onMove).not.toHaveBeenCalled();
  });

  it("ignores a drag that did not start on a meal", () => {
    const onMove = vi.fn();
    detach = attachGridInput(root, { onMove });
    const store = new Map<string, string>();
    q("add-2026-11-02-dinner").dispatchEvent(dragEvent("dragstart", store));
    const over = dragEvent("dragover", store);
    q("slot-2026-11-03-lunch").dispatchEvent(over);
    expect(over.defaultPrevented).toBe(false);
  });

  it("lights the slot under the pointer and clears it after the drop", () => {
    detach = attachGridInput(root, { onMove: vi.fn() });
    const store = new Map<string, string>();
    q("entry-e1").dispatchEvent(dragEvent("dragstart", store));
    q("slot-2026-11-03-lunch").dispatchEvent(dragEvent("dragover", store));
    expect(q("slot-2026-11-03-lunch").style.backgroundColor).not.toBe("");
    q("slot-2026-11-03-lunch").dispatchEvent(dragEvent("drop", store));
    expect(q("slot-2026-11-03-lunch").style.backgroundColor).toBe("");
  });

  it("stops listening once detached", () => {
    const onMove = vi.fn();
    const off = attachGridInput(root, { onMove });
    off();
    const store = new Map<string, string>();
    q("entry-e1").dispatchEvent(dragEvent("dragstart", store));
    q("slot-2026-11-04-lunch").dispatchEvent(dragEvent("drop", store));
    expect(onMove).not.toHaveBeenCalled();
  });
});
