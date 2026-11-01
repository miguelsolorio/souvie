// The planner's web-only space (WS13 follow-up). A control that stacks two texts ("Mon" over
// "Nov 2", a recipe's name over "4 servings") needs a space between them for a browser to read
// "Mon Nov 2", but React Native Web logs "Unexpected text node" for any string that is a direct
// child of a View or Pressable. So the space has to sit inside a Text.
//
// These tests draw the planner's day header, a filled slot cell and a meal chip with
// react-native stood in by src/testing/reactNativeStub.tsx, where View is a div, Pressable a
// button and Text a span. They walk the markup and fail on any text node whose parent is not a
// span, which is the same rule React Native Web enforces. They also check the space is still
// there on the web and gone on a phone.
import { MEAL_SLOTS, weekDates } from "@mp/core";
import { isValidElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WebSpace } from "../../../lib/webSpace";
import { byDay, planEntry } from "../../../testing/planEntries";
import { renderScreen } from "../../../testing/renderScreen";
import { EntryChip, SlotCell } from "../SlotCell";
import { WeekGrid } from "../WeekGrid";

const h = vi.hoisted(() => ({ os: "web" as "web" | "ios" | "android", width: 1280 }));

vi.mock("react-native", async () => {
  const stub = await import("../../../testing/reactNativeStub");
  return {
    ...stub,
    // Read on every use, so a test can draw the same screen as a phone app.
    Platform: {
      ...stub.Platform,
      get OS() {
        return h.os;
      },
    },
    useWindowDimensions: () => ({ width: h.width, height: 844, scale: 1, fontScale: 1 }),
  };
});

beforeEach(() => {
  h.os = "web";
  h.width = 1280;
});

interface TextNode {
  /** The tag the text sits directly in: "span" for a Text, "div" for a View, "button" for a Pressable. */
  parent: string;
  /** The `data-testid` of every ancestor that has one, outermost first. */
  ids: string[];
  text: string;
}

const VOID_TAGS = new Set(["input", "br", "img", "hr"]);

/** Every text node in the markup, with the tag it sits in. The markup is the stub's: no comments. */
function textNodes(html: string): TextNode[] {
  const nodes: TextNode[] = [];
  const open: { tag: string; id: string | null }[] = [];
  for (const match of html.matchAll(/<(\/?)([a-z][a-z0-9]*)([^>]*)>|([^<]+)/gi)) {
    const [, closing, tag = "", attributes = "", text] = match;
    if (text !== undefined) {
      nodes.push({
        parent: open.at(-1)?.tag ?? "(root)",
        ids: open.flatMap((entry) => (entry.id ? [entry.id] : [])),
        text,
      });
    } else if (closing) {
      open.pop();
    } else if (!VOID_TAGS.has(tag) && !attributes.endsWith("/")) {
      open.push({ tag, id: /data-testid="([^"]+)"/.exec(attributes)?.[1] ?? null });
    }
  }
  return nodes;
}

/** Text nodes that are a direct child of a View or a Pressable: React Native Web rejects each. */
function bareStrings(html: string): string[] {
  return textNodes(html)
    .filter((node) => node.parent !== "span")
    .map(
      (node) =>
        `${JSON.stringify(node.text)} is a direct child of <${node.parent}> in ${
          node.ids.at(-1) ?? "(no testID)"
        }`,
    );
}

/** What a browser reads out of one control: its text nodes, joined as they are in the page. */
function textOf(html: string, testID: string): string {
  return textNodes(html)
    .filter((node) => node.ids.includes(testID))
    .map((node) => node.text)
    .join("");
}

const noop = () => {};
const DAYS = weekDates("2026-11-02");
const TODAY = "2026-11-03";

const monday = planEntry("e1", "2026-11-02", "dinner", "Lemon chicken");
const tuesdayCooked = planEntry("e2", "2026-11-03", "dinner", "Tacos", { status: "cooked" });
const lunch = planEntry("e3", "2026-11-04", "lunch", "Leftover soup");

function grid(mode: "simple" | "full", entries = [monday, tuesdayCooked, lunch]) {
  return renderScreen(
    <WeekGrid
      weekStart="2026-11-02"
      mode={mode}
      byDay={byDay(entries)}
      today={TODAY}
      onAdd={noop}
      onOpenEntry={noop}
      onOpenDay={noop}
    />,
  );
}

describe("the detector", () => {
  it("flags a string that is a child of a View or a Pressable, and only that", () => {
    expect(bareStrings("<button><span>Mon</span> <span>Nov 2</span></button>")).toEqual([
      '" " is a direct child of <button> in (no testID)',
    ]);
    expect(bareStrings('<div data-testid="cell">Hi</div>')).toEqual([
      '"Hi" is a direct child of <div> in cell',
    ]);
    expect(
      bareStrings("<button><span>Mon</span><span> </span><span>Nov 2</span></button>"),
    ).toEqual([]);
  });
});

describe("on the web", () => {
  it("has no string child under a View or Pressable in the seven-column week", () => {
    for (const mode of ["simple", "full"] as const) {
      const screen = grid(mode);
      expect(textNodes(screen.html).length).toBeGreaterThan(0);
      expect(bareStrings(screen.html)).toEqual([]);
    }
  });

  it("has no string child under a View or Pressable in the phone's day cards", () => {
    h.width = 390;
    for (const mode of ["simple", "full"] as const) {
      const screen = grid(mode);
      expect(screen.has("day-2026-11-03")).toBe(true);
      expect(bareStrings(screen.html)).toEqual([]);
    }
  });

  it("has no string child in a filled slot cell, in either layout", () => {
    for (const layout of ["cell", "row"] as const) {
      const screen = renderScreen(
        <SlotCell
          date="2026-11-02"
          slot="dinner"
          entries={[monday, planEntry("e9", "2026-11-02", "dinner", "Rice", { status: "skipped" })]}
          layout={layout}
          onAdd={noop}
          onOpen={noop}
        />,
      );
      expect(screen.has("entry-e1")).toBe(true);
      expect(screen.has("entry-e9")).toBe(true);
      expect(bareStrings(screen.html)).toEqual([]);
    }
  });

  it("has no string child in a chip that names its meal above the recipe", () => {
    const screen = renderScreen(<EntryChip entry={lunch} onOpen={noop} slotLabel="Lunch" />);
    expect(bareStrings(screen.html)).toEqual([]);
  });

  it("keeps a space between the two texts of a day header", () => {
    const wide = grid("full");
    expect(textOf(wide.html, "open-day-2026-11-02")).toBe("Mon Nov 2");
    expect(textOf(wide.html, "open-day-2026-11-03")).toBe("Tue Nov 3");

    h.width = 390;
    const phone = grid("full");
    // Today's card has the date and a "Today" badge side by side.
    expect(textOf(phone.html, "open-day-2026-11-03")).toBe("Tuesday, November 3 Today");
    expect(textOf(phone.html, "open-day-2026-11-02")).toBe("Monday, November 2");
  });

  it("keeps a space between a meal's name and its servings", () => {
    const screen = renderScreen(
      <SlotCell
        date="2026-11-03"
        slot="dinner"
        entries={[tuesdayCooked]}
        layout="cell"
        onAdd={noop}
        onOpen={noop}
      />,
    );
    expect(textOf(screen.html, "entry-e2")).toBe("Tacos 4 servings · Cooked");

    const named = renderScreen(<EntryChip entry={lunch} onOpen={noop} slotLabel="Lunch" />);
    expect(textOf(named.html, "entry-e3")).toBe("Lunch Leftover soup 4 servings");
  });

  it("draws every day, and every slot, that it drew before", () => {
    const screen = grid("full");
    for (const date of DAYS) expect(screen.has(`open-day-${date}`)).toBe(true);
    for (const date of DAYS) {
      for (const slot of MEAL_SLOTS) expect(screen.has(`add-${date}-${slot}`)).toBe(true);
    }
  });
});

describe("WebSpace", () => {
  it("is a Text holding one space, with no size and no aria-hidden", () => {
    const element = WebSpace();
    expect(isValidElement(element)).toBe(true);
    const props = (element as { props: Record<string, unknown> }).props;
    expect(props.children).toBe(" ");
    // Out of the layout and zero by zero, so the screen is unchanged...
    expect(props.style).toMatchObject({ position: "absolute", width: 0, height: 0 });
    // ...but not hidden from assistive technology, or the space would not count toward the name.
    expect(props["aria-hidden"]).toBeUndefined();
    expect(props.accessibilityElementsHidden).toBeUndefined();
    expect(props.importantForAccessibility).toBeUndefined();
    // Nor clipped: axe reads a zero size box with overflow hidden as invisible and drops its text.
    expect(props.style).not.toHaveProperty("overflow");
  });
});

describe("on a phone", () => {
  for (const os of ["ios", "android"] as const) {
    it(`draws nothing for the space on ${os}`, () => {
      h.os = os;
      expect(WebSpace()).toBeNull();
    });

    it(`draws the same tree as before on ${os}: only the texts, no space`, () => {
      h.os = os;
      const wide = grid("full");
      expect(bareStrings(wide.html)).toEqual([]);
      expect(textNodes(wide.html).filter((node) => node.text.trim() === "")).toEqual([]);
      expect(textOf(wide.html, "open-day-2026-11-02")).toBe("MonNov 2");

      h.width = 390;
      const phone = grid("full");
      expect(textNodes(phone.html).filter((node) => node.text.trim() === "")).toEqual([]);
      expect(textOf(phone.html, "open-day-2026-11-03")).toBe("Tuesday, November 3Today");

      const chip = renderScreen(<EntryChip entry={lunch} onOpen={noop} slotLabel="Lunch" />);
      expect(textOf(chip.html, "entry-e3")).toBe("LunchLeftover soup4 servings");
    });
  }
});
