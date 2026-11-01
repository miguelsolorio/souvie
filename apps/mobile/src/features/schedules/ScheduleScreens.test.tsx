// WS11 criterion 9: the schedule screens create, edit, disable and delete a schedule and show the
// next run that nextRunAt gives. react-test-renderer over the repo's react-native stand-in, with the
// data hooks replaced by state the test controls and records.
import type { ScheduledRun } from "@mp/core";
import { createElement } from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const HOUSEHOLD = "0a000000-0000-4000-8000-00000000000a";
const SCHEDULE = "5a000000-0000-4000-8000-0000000000a1";
const KROGER = "7a000000-0000-4000-8000-0000000000a1";
const TIER3 = "7a000000-0000-4000-8000-0000000000a3";
const STALE = "7a000000-0000-4000-8000-0000000000a2";

type Options = { onSuccess?: (value?: unknown) => void; onError?: (error: unknown) => void };

const h = vi.hoisted(() => ({
  router: { push: vi.fn(), replace: vi.fn(), back: vi.fn() },
  household: { isPending: false, data: { id: "h", role: "owner" } as { id: string; role: string } },
  settings: { data: { timezone: "America/Los_Angeles", quietHours: null } },
  stored: { isPending: false, data: null as unknown },
  schedules: { isPending: false, isError: false, data: [] as unknown[], refetch: vi.fn() },
  connections: { isPending: false, data: [] as unknown[] },
  save: { isPending: false, mutate: vi.fn() },
  toggle: { isPending: false, mutate: vi.fn() },
  remove: { isPending: false, mutate: vi.fn() },
  createDefault: { isPending: false, mutate: vi.fn() },
  confirm: vi.fn(async () => true),
}));

vi.mock("react-native", () => import("../../testing/reactNativeStub"));
vi.mock("react-native-safe-area-context", async () => {
  const { View } = await import("../../testing/reactNativeStub");
  return {
    SafeAreaView: View,
    useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
  };
});
vi.mock("expo-router", () => ({ useRouter: () => h.router }));
vi.mock("../../lib/confirm", () => ({
  confirmAction: (...args: unknown[]) => h.confirm(...(args as [])),
}));
vi.mock("@mp/db", () => ({
  useHousehold: () => h.household,
  useNotificationSettings: () => h.settings,
  useSchedule: () => h.stored,
  useSchedules: () => h.schedules,
  useScheduleConnections: () => h.connections,
  useSaveSchedule: () => h.save,
  useToggleSchedule: () => h.toggle,
  useDeleteSchedule: () => h.remove,
  useCreateDefaultSchedule: () => h.createDefault,
  toScheduleApiError: (error: unknown) => ({
    message: `error: ${String((error as Error)?.message ?? error)}`,
  }),
}));

import { ScheduleEditorScreen } from "./ScheduleEditorScreen";
import { ScheduleListScreen } from "./ScheduleListScreen";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const connections = [
  { id: KROGER, retailer: "kroger", storeName: "QFC Duvall", status: "active", unattended: true },
  {
    id: TIER3,
    retailer: "safeway",
    storeName: "Safeway Duvall",
    status: "active",
    unattended: false,
  },
  {
    id: STALE,
    retailer: "kroger",
    storeName: "QFC Redmond",
    status: "needs_reauth",
    unattended: true,
  },
];

function schedule(over: Partial<ScheduledRun> = {}): ScheduledRun {
  return {
    id: SCHEDULE,
    household_id: HOUSEHOLD,
    cron: "30 18 * * 5",
    tz: "America/Los_Angeles",
    connection_id: KROGER,
    policy: { budget_cap_usd: 120, substitution: "any" },
    next_run_at: "2026-11-07T02:30:00+00:00",
    last_enqueued_for: null,
    enabled: true,
    created_at: "2026-10-31T12:00:00+00:00",
    updated_at: "2026-10-31T12:00:00+00:00",
    ...over,
  };
}

let renderer: ReactTestRenderer | null = null;

async function render(element: ReturnType<typeof createElement>) {
  await act(async () => {
    renderer = create(element);
  });
  const root = (renderer as unknown as ReactTestRenderer).root;
  // The innermost component with the testID: the stand-in react-native element, not the wrapper
  // (ToggleRow, TextField, Stepper) that passed the testID down to it.
  const find = (testID: string): ReactTestInstance | undefined =>
    root.findAll((n) => n.props.testID === testID && typeof n.type === "function").at(-1);
  const must = (testID: string): ReactTestInstance => {
    const found = find(testID);
    if (!found) throw new Error(`Nothing with testID "${testID}" on screen`);
    return found;
  };
  const text = (testID: string): string => textOf(must(testID));
  const press = async (testID: string) => {
    await act(async () => {
      must(testID).props.onPress();
    });
  };
  const type = async (testID: string, value: string) => {
    await act(async () => {
      must(testID).props.onChangeText(value);
    });
  };
  const all = () => JSON.stringify((renderer as unknown as ReactTestRenderer).toJSON());
  return { root, find, must, text, press, type, all, has: (id: string) => find(id) !== undefined };
}

function textOf(node: ReactTestInstance | string): string {
  if (typeof node === "string") return node;
  return node.children.map(textOf).join("");
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  // Wednesday 2026-10-28 12:00 in Los Angeles.
  vi.setSystemTime(new Date("2026-10-28T19:00:00Z"));
  h.router = { push: vi.fn(), replace: vi.fn(), back: vi.fn() };
  h.household = { isPending: false, data: { id: HOUSEHOLD, role: "owner" } };
  h.settings = { data: { timezone: "America/Los_Angeles", quietHours: null } };
  h.stored = { isPending: false, data: null };
  h.schedules = { isPending: false, isError: false, data: [], refetch: vi.fn() };
  h.connections = { isPending: false, data: connections };
  h.save = { isPending: false, mutate: vi.fn() };
  h.toggle = { isPending: false, mutate: vi.fn() };
  h.remove = { isPending: false, mutate: vi.fn() };
  h.createDefault = { isPending: false, mutate: vi.fn() };
  h.confirm = vi.fn(async () => true);
});

afterEach(() => {
  vi.useRealTimers();
  renderer = null;
});

describe("the schedule editor: a new schedule", () => {
  it("starts at Saturday 9:00 AM and shows the next run nextRunAt works out", async () => {
    const screen = await render(createElement(ScheduleEditorScreen, { scheduleId: "new" }));
    expect(screen.text("schedule-time-text")).toBe("9:00 AM");
    expect(screen.must("schedule-weekday-6").props.accessibilityState.selected).toBe(true);
    expect(screen.text("schedule-next-run")).toBe("Next run: Sat, Oct 31 at 9:00 AM");
    expect(screen.text("schedule-target-week")).toContain("Nov 2");
    // The first store that can run by itself is picked; the Tier 3 and the stale ones cannot be.
    expect(screen.must(`schedule-connection-${KROGER}`).props.accessibilityState.selected).toBe(
      true,
    );
    expect(screen.must(`schedule-connection-${TIER3}`).props.disabled).toBe(true);
    expect(screen.must(`schedule-connection-${STALE}`).props.disabled).toBe(true);
    expect(screen.all()).toContain("runs on your phone");
  });

  it("moves the preview as the day and time change", async () => {
    const screen = await render(createElement(ScheduleEditorScreen, { scheduleId: "new" }));
    await screen.press("schedule-weekday-2");
    expect(screen.text("schedule-next-run")).toBe("Next run: Tue, Nov 3 at 9:00 AM");
    expect(screen.text("schedule-target-week")).toContain("Nov 9");
    await screen.press("schedule-time-hour-plus");
    await screen.press("schedule-time-hour-plus");
    expect(screen.text("schedule-time-text")).toBe("11:00 AM");
    expect(screen.text("schedule-next-run")).toBe("Next run: Tue, Nov 3 at 11:00 AM");
    // Switching to PM and the half hour.
    const pm = screen.root.findAll(
      (n) => n.props.accessibilityLabel === "PM" && typeof n.type === "function",
    )[0] as ReactTestInstance;
    await act(async () => pm.props.onPress());
    const half = screen.root.findAll(
      (n) => n.props.accessibilityLabel === ":30" && typeof n.type === "function",
    )[0] as ReactTestInstance;
    await act(async () => half.props.onPress());
    expect(screen.text("schedule-next-run")).toBe("Next run: Tue, Nov 3 at 11:30 PM");
  });

  it("saves what was set, then goes back to the list", async () => {
    h.save.mutate = vi.fn((_input: unknown, options?: Options) => options?.onSuccess?.());
    const screen = await render(createElement(ScheduleEditorScreen, { scheduleId: "new" }));
    await screen.type("schedule-budget", "150");
    await screen.press("schedule-save");
    expect(h.save.mutate).toHaveBeenCalledTimes(1);
    expect(h.save.mutate.mock.calls[0]?.[0]).toEqual({
      cron: "0 9 * * 6",
      tz: "America/Los_Angeles",
      connection_id: KROGER,
      policy: { budget_cap_usd: 150, substitution: "same_brand" },
      enabled: true,
    });
    expect(h.router.replace).toHaveBeenCalledWith("/schedules");
  });

  it("does not save a cap that is not money, and says so", async () => {
    const screen = await render(createElement(ScheduleEditorScreen, { scheduleId: "new" }));
    await screen.type("schedule-budget", "lots");
    await screen.press("schedule-save");
    expect(h.save.mutate).not.toHaveBeenCalled();
    expect(screen.all()).toContain("Enter a dollar amount");
  });

  it("shows what the server refused", async () => {
    h.save.mutate = vi.fn((_input: unknown, options?: Options) =>
      options?.onError?.(new Error("too_many_schedules")),
    );
    const screen = await render(createElement(ScheduleEditorScreen, { scheduleId: "new" }));
    await screen.press("schedule-save");
    expect(screen.all()).toContain("error: too_many_schedules");
    expect(h.router.replace).not.toHaveBeenCalled();
  });

  it("offers no save and no delete when no store can run by itself", async () => {
    h.connections = { isPending: false, data: [connections[1], connections[2]] };
    const screen = await render(createElement(ScheduleEditorScreen, { scheduleId: "new" }));
    expect(screen.must("schedule-save").props.disabled).toBe(true);
    expect(screen.has("schedule-delete")).toBe(false);
  });

  it("asks to connect a store when there is none", async () => {
    h.connections = { isPending: false, data: [] };
    const screen = await render(createElement(ScheduleEditorScreen, { scheduleId: "new" }));
    expect(screen.has("schedule-no-store")).toBe(true);
  });
});

describe("the schedule editor: an existing schedule", () => {
  beforeEach(() => {
    h.stored = { isPending: false, data: schedule() };
  });

  it("shows the stored day, time, cap and swap rule", async () => {
    const screen = await render(createElement(ScheduleEditorScreen, { scheduleId: SCHEDULE }));
    expect(screen.must("schedule-weekday-5").props.accessibilityState.selected).toBe(true);
    expect(screen.text("schedule-time-text")).toBe("6:30 PM");
    expect(screen.must("schedule-budget").props.value).toBe("120");
    expect(screen.must("schedule-substitution-any").props.accessibilityState.selected).toBe(true);
    expect(screen.text("schedule-next-run")).toBe("Next run: Fri, Oct 30 at 6:30 PM");
  });

  it("edits and saves", async () => {
    h.save.mutate = vi.fn((_input: unknown, options?: Options) => options?.onSuccess?.());
    const screen = await render(createElement(ScheduleEditorScreen, { scheduleId: SCHEDULE }));
    await screen.press("schedule-weekday-6");
    await screen.type("schedule-budget", "");
    await screen.press("schedule-substitution-none");
    await screen.press("schedule-save");
    expect(h.save.mutate.mock.calls[0]?.[0]).toEqual({
      cron: "30 18 * * 6",
      tz: "America/Los_Angeles",
      connection_id: KROGER,
      policy: { budget_cap_usd: null, substitution: "none" },
      enabled: true,
    });
  });

  it("disables: the switch turns the preview off and saves enabled false", async () => {
    const screen = await render(createElement(ScheduleEditorScreen, { scheduleId: SCHEDULE }));
    await screen.press("schedule-enabled");
    expect(screen.text("schedule-next-run")).toBe("This schedule is off, so it will not run.");
    await screen.press("schedule-save");
    expect(h.save.mutate.mock.calls[0]?.[0]).toMatchObject({ enabled: false });
  });

  it("deletes after a confirmation, then goes back to the list", async () => {
    h.remove.mutate = vi.fn((_id: string, options?: Options) => options?.onSuccess?.());
    const screen = await render(createElement(ScheduleEditorScreen, { scheduleId: SCHEDULE }));
    await screen.press("schedule-delete");
    expect(h.confirm).toHaveBeenCalledTimes(1);
    expect(h.remove.mutate).toHaveBeenCalledWith(SCHEDULE, expect.any(Object));
    expect(h.router.replace).toHaveBeenCalledWith("/schedules");
  });

  it("keeps the schedule when the confirmation is declined", async () => {
    h.confirm = vi.fn(async () => false);
    const screen = await render(createElement(ScheduleEditorScreen, { scheduleId: SCHEDULE }));
    await screen.press("schedule-delete");
    expect(h.remove.mutate).not.toHaveBeenCalled();
  });

  it("is read only for a member, who sees why", async () => {
    h.household = { isPending: false, data: { id: HOUSEHOLD, role: "member" } };
    const screen = await render(createElement(ScheduleEditorScreen, { scheduleId: SCHEDULE }));
    expect(screen.has("schedule-readonly")).toBe(true);
    expect(screen.has("schedule-save")).toBe(false);
    expect(screen.has("schedule-delete")).toBe(false);
    expect(screen.must("schedule-weekday-6").props.disabled).toBe(true);
    expect(screen.must("schedule-budget").props.editable).toBe(false);
  });

  it("shows a schedule on several days without pretending it can edit it", async () => {
    h.stored = { isPending: false, data: schedule({ cron: "0 18 * * 1-5" }) };
    const screen = await render(createElement(ScheduleEditorScreen, { scheduleId: SCHEDULE }));
    expect(screen.all()).toContain("more than one day");
    expect(screen.has("schedule-weekday-6")).toBe(false);
    await screen.press("schedule-enabled");
    expect(h.toggle.mutate).toHaveBeenCalledWith({ scheduleId: SCHEDULE, enabled: false });
    expect(screen.has("schedule-delete")).toBe(true);
  });

  it("says when the schedule is not in the household", async () => {
    h.stored = { isPending: false, data: null };
    const screen = await render(createElement(ScheduleEditorScreen, { scheduleId: SCHEDULE }));
    expect(screen.all()).toContain("not in your household");
  });
});

describe("the schedule list", () => {
  it("offers the suggested Saturday run when nothing is scheduled", async () => {
    const screen = await render(createElement(ScheduleListScreen));
    expect(screen.has("schedules-empty")).toBe(true);
    await screen.press("schedule-add-suggested");
    expect(h.createDefault.mutate).toHaveBeenCalledTimes(1);
  });

  it("tells a member the owner sets schedules up", async () => {
    h.household = { isPending: false, data: { id: HOUSEHOLD, role: "member" } };
    const screen = await render(createElement(ScheduleListScreen));
    expect(screen.has("schedule-add-suggested")).toBe(false);
    expect(screen.has("schedule-add")).toBe(false);
    expect(screen.has("schedules-members-note")).toBe(true);
  });

  it("lists each schedule with its store and next run, and opens one", async () => {
    h.schedules = {
      isPending: false,
      isError: false,
      data: [
        schedule(),
        schedule({ id: "5a000000-0000-4000-8000-0000000000a2", enabled: false, cron: "0 9 * * 6" }),
      ],
      refetch: vi.fn(),
    };
    const screen = await render(createElement(ScheduleListScreen));
    expect(screen.all()).toContain("Fridays at 6:30 PM");
    expect(screen.all()).toContain("Saturdays at 9:00 AM");
    expect(screen.all()).toContain("QFC Duvall");
    expect(screen.text(`schedule-next-${SCHEDULE}`)).toBe(
      "Next run: Fri, Nov 6 at 6:30 PM (Los Angeles time)",
    );
    expect(screen.text("schedule-next-5a000000-0000-4000-8000-0000000000a2")).toBe("Off");
    await screen.press(`schedule-open-${SCHEDULE}`);
    expect(h.router.push).toHaveBeenCalledWith(`/schedules/${SCHEDULE}`);
    await screen.press("schedule-add");
    expect(h.router.push).toHaveBeenCalledWith("/schedules/new");
  });

  it("switches a schedule off from the list", async () => {
    h.schedules = { isPending: false, isError: false, data: [schedule()], refetch: vi.fn() };
    const screen = await render(createElement(ScheduleListScreen));
    await screen.press(`schedule-toggle-${SCHEDULE}`);
    expect(h.toggle.mutate).toHaveBeenCalledWith(
      { scheduleId: SCHEDULE, enabled: false },
      expect.any(Object),
    );
  });

  it("leaves the switch to the owner", async () => {
    h.household = { isPending: false, data: { id: HOUSEHOLD, role: "member" } };
    h.schedules = { isPending: false, isError: false, data: [schedule()], refetch: vi.fn() };
    const screen = await render(createElement(ScheduleListScreen));
    expect(screen.must(`schedule-toggle-${SCHEDULE}`).props.disabled).toBe(true);
  });

  it("offers a retry when the schedules cannot be loaded", async () => {
    h.schedules = { isPending: false, isError: true, data: [], refetch: vi.fn() };
    const screen = await render(createElement(ScheduleListScreen));
    expect(screen.all()).toContain("Could not load the schedules");
  });
});
