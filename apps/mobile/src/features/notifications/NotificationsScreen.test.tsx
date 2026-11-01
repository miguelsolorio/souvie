// The notification settings screen: one switch per type that only the signed-in person owns, and the
// household's quiet hours that only the owner changes. react-test-renderer over the react-native
// stand-in, with the data hooks replaced by state the test controls and records.
import { NOTIFICATION_TYPES } from "@mp/core";
import { createElement } from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";

type Options = { onSuccess?: () => void; onError?: (error: unknown) => void };

const h = vi.hoisted(() => ({
  household: { isPending: false, data: { id: "h", role: "owner" } as { id: string; role: string } },
  prefs: {
    isPending: false,
    isError: false,
    data: {} as Record<string, boolean>,
    refetch: vi.fn(),
  },
  settings: {
    isPending: false,
    isError: false,
    data: { timezone: "America/Los_Angeles", quietHours: null } as {
      timezone: string | null;
      quietHours: { start: string; end: string } | null;
    },
    refetch: vi.fn(),
  },
  setPreference: { isError: false, error: null as unknown, mutate: vi.fn() },
  saveQuiet: { isPending: false, mutate: vi.fn() },
}));

vi.mock("react-native", () => import("../../testing/reactNativeStub"));
vi.mock("react-native-safe-area-context", async () => {
  const { View } = await import("../../testing/reactNativeStub");
  return { SafeAreaView: View };
});
vi.mock("@mp/db", () => ({
  useHousehold: () => h.household,
  useNotificationPreferences: () => h.prefs,
  useNotificationSettings: () => h.settings,
  useSetNotificationPreference: () => h.setPreference,
  useSaveQuietHours: () => h.saveQuiet,
  toScheduleApiError: (error: unknown) => ({
    message: `error: ${String((error as Error)?.message ?? error)}`,
  }),
}));

import { NotificationsScreen } from "./NotificationsScreen";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function textOf(node: ReactTestInstance | string): string {
  return typeof node === "string" ? node : node.children.map(textOf).join("");
}

async function render() {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(createElement(NotificationsScreen));
  });
  const root = renderer.root;
  const find = (testID: string) =>
    root.findAll((n) => n.props.testID === testID && typeof n.type === "function").at(-1);
  const must = (testID: string): ReactTestInstance => {
    const found = find(testID);
    if (!found) throw new Error(`Nothing with testID "${testID}" on screen`);
    return found;
  };
  return {
    must,
    has: (id: string) => find(id) !== undefined,
    text: (id: string) => textOf(must(id)),
    all: () => JSON.stringify(renderer.toJSON()),
    content: () => textOf(renderer.root),
    press: (id: string) =>
      act(async () => {
        must(id).props.onPress();
      }),
  };
}

beforeEach(() => {
  h.household = { isPending: false, data: { id: "h", role: "owner" } };
  h.prefs = { isPending: false, isError: false, data: {}, refetch: vi.fn() };
  h.settings = {
    isPending: false,
    isError: false,
    data: { timezone: "America/Los_Angeles", quietHours: null },
    refetch: vi.fn(),
  };
  h.setPreference = { isError: false, error: null, mutate: vi.fn() };
  h.saveQuiet = { isPending: false, mutate: vi.fn() };
});

describe("the notification switches", () => {
  it("shows every type, on unless the person turned it off", async () => {
    h.prefs.data = { items_need_review: false };
    const screen = await render();
    for (const type of NOTIFICATION_TYPES) {
      expect(screen.has(`notification-${type}`), type).toBe(true);
      expect(screen.must(`notification-${type}`).props.accessibilityState.checked).toBe(
        type !== "items_need_review",
      );
    }
  });

  it("turns one off and back on for this person", async () => {
    h.prefs.data = { items_need_review: false };
    const screen = await render();
    await screen.press("notification-cart_ready");
    expect(h.setPreference.mutate).toHaveBeenLastCalledWith({ type: "cart_ready", enabled: false });
    await screen.press("notification-items_need_review");
    expect(h.setPreference.mutate).toHaveBeenLastCalledWith({
      type: "items_need_review",
      enabled: true,
    });
  });

  it("is the same for a member as for an owner: the switches are each person's own", async () => {
    h.household = { isPending: false, data: { id: "h", role: "member" } };
    const screen = await render();
    expect(screen.must("notification-cart_ready").props.disabled).toBe(false);
    await screen.press("notification-cart_ready");
    expect(h.setPreference.mutate).toHaveBeenCalledTimes(1);
  });

  it("says a pushed total never names an item", async () => {
    const screen = await render();
    expect(screen.all()).toContain("never name what is in your cart");
  });
});

describe("quiet hours", () => {
  it("starts off with nothing to save", async () => {
    const screen = await render();
    expect(screen.must("quiet-enabled").props.accessibilityState.checked).toBe(false);
    expect(screen.has("quiet-start-text")).toBe(false);
    expect(screen.must("quiet-save").props.disabled).toBe(true);
  });

  it("turns on at 9 PM to 7 AM, saves them with the household's zone the first time, and says saved", async () => {
    h.settings.data = { timezone: null, quietHours: null };
    h.saveQuiet.mutate = vi.fn((_vars: unknown, options?: Options) => options?.onSuccess?.());
    const screen = await render();
    await screen.press("quiet-enabled");
    expect(screen.text("quiet-start-text")).toBe("9:00 PM");
    expect(screen.text("quiet-end-text")).toBe("7:00 AM");
    expect(screen.must("quiet-save").props.disabled).toBe(false);
    await screen.press("quiet-save");
    const [vars] = h.saveQuiet.mutate.mock.calls[0] ?? [];
    expect(vars).toMatchObject({ quietHours: { start: "21:00", end: "07:00" } });
    expect(typeof (vars as { timezone?: string }).timezone).toBe("string");
    expect(screen.has("quiet-saved")).toBe(true);
  });

  it("keeps the household's zone when it already has one", async () => {
    h.settings.data = {
      timezone: "America/Los_Angeles",
      quietHours: { start: "22:00", end: "06:30" },
    };
    const screen = await render();
    expect(screen.text("quiet-start-text")).toBe("10:00 PM");
    expect(screen.text("quiet-end-text")).toBe("6:30 AM");
    expect(screen.content()).toContain("Times are in Los Angeles time.");
    await screen.press("quiet-start-hour-plus");
    await screen.press("quiet-save");
    expect(h.saveQuiet.mutate.mock.calls[0]?.[0]).toEqual({
      quietHours: { start: "23:00", end: "06:30" },
    });
  });

  it("clears them when switched off", async () => {
    h.settings.data = {
      timezone: "America/Los_Angeles",
      quietHours: { start: "21:00", end: "07:00" },
    };
    const screen = await render();
    await screen.press("quiet-enabled");
    await screen.press("quiet-save");
    expect(h.saveQuiet.mutate.mock.calls[0]?.[0]).toEqual({ quietHours: null });
  });

  it("refuses a start that equals the end", async () => {
    h.settings.data = {
      timezone: "America/Los_Angeles",
      quietHours: { start: "21:00", end: "07:00" },
    };
    const screen = await render();
    // Bring the start from 9 PM to 7 AM: 8 PM... the hour stepper moves one hour at a time.
    for (let i = 0; i < 2; i++) await screen.press("quiet-start-hour-plus"); // 11 PM
    const am = screen.must("quiet-start-text");
    expect(textOf(am)).toBe("11:00 PM");
    const meridiem = (label: string) =>
      screen
        .must("quiet-start-meridiem")
        .findAll(
          (n) => n.props.accessibilityLabel === label && typeof n.type === "function",
        )[0] as ReactTestInstance;
    await act(async () => meridiem("AM").props.onPress());
    for (let i = 0; i < 8; i++) await screen.press("quiet-start-hour-minus"); // 3 AM
    expect(screen.text("quiet-start-text")).toBe("3:00 AM");
    for (let i = 0; i < 4; i++) await screen.press("quiet-start-hour-plus"); // 7 AM
    expect(screen.text("quiet-start-text")).toBe("7:00 AM");
    await screen.press("quiet-save");
    expect(h.saveQuiet.mutate).not.toHaveBeenCalled();
    expect(screen.all()).toContain("different times");
  });

  it("shows what the server refused", async () => {
    h.settings.data = { timezone: "America/Los_Angeles", quietHours: null };
    h.saveQuiet.mutate = vi.fn((_vars: unknown, options?: Options) =>
      options?.onError?.(new Error("not_owner")),
    );
    const screen = await render();
    await screen.press("quiet-enabled");
    await screen.press("quiet-save");
    expect(screen.all()).toContain("error: not_owner");
    expect(screen.has("quiet-saved")).toBe(false);
  });

  it("shows a member the household's quiet hours without a way to change them", async () => {
    h.household = { isPending: false, data: { id: "h", role: "member" } };
    h.settings.data = {
      timezone: "America/Los_Angeles",
      quietHours: { start: "21:00", end: "07:00" },
    };
    const screen = await render();
    expect(screen.text("quiet-start-text")).toBe("9:00 PM");
    expect(screen.must("quiet-enabled").props.disabled).toBe(true);
    expect(screen.has("quiet-save")).toBe(false);
    expect(screen.has("quiet-members-note")).toBe(true);
  });
});

describe("loading and errors", () => {
  it("offers a retry when the settings cannot be loaded", async () => {
    h.settings.isError = true;
    const screen = await render();
    expect(screen.all()).toContain("Could not load your notification settings");
  });
});
