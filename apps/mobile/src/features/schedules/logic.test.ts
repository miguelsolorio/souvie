import type { ScheduledRun } from "@mp/core";
import type { ScheduleConnection } from "@mp/db";
import { describe, expect, it } from "vitest";
import {
  clockText,
  connectionChoices,
  defaultConnectionId,
  describeSchedule,
  draftOf,
  formatRun,
  from12h,
  newDraft,
  parseBudget,
  previewNextRun,
  to12h,
  toInput,
  weekOfText,
  zoneLabel,
} from "./logic";

const CONNECTION = "7a000000-0000-4000-8000-0000000000a1";

function stored(over: Partial<ScheduledRun> = {}): ScheduledRun {
  return {
    id: "5a000000-0000-4000-8000-0000000000a1",
    household_id: "0a000000-0000-4000-8000-00000000000a",
    cron: "30 18 * * 5",
    tz: "America/Los_Angeles",
    connection_id: CONNECTION,
    policy: { budget_cap_usd: 120, substitution: "any", per_item_ceiling_usd: 25 },
    next_run_at: "2026-11-06T02:30:00+00:00",
    last_enqueued_for: null,
    enabled: true,
    created_at: "2026-10-31T12:00:00+00:00",
    updated_at: "2026-10-31T12:00:00+00:00",
    ...over,
  };
}

describe("the suggested schedule", () => {
  it("is Saturday 9:00 AM, same brand, on", () => {
    const draft = newDraft({ tz: "America/Los_Angeles", connectionId: CONNECTION });
    expect(draft).toMatchObject({
      weekday: 6,
      hour: 9,
      minute: 0,
      substitution: "same_brand",
      enabled: true,
      budgetText: "",
      connectionId: CONNECTION,
    });
  });

  it("falls back to Los Angeles for a zone the runtime does not know", () => {
    expect(newDraft({ tz: "Nowhere/Land" }).tz).toBe("America/Los_Angeles");
    expect(newDraft({}).tz).toBe("America/Los_Angeles");
  });
});

describe("a stored schedule as a draft", () => {
  it("reads the weekday, time, store, cap and swap rule back", () => {
    expect(draftOf(stored())).toEqual({
      weekday: 5,
      hour: 18,
      minute: 30,
      connectionId: CONNECTION,
      budgetText: "120",
      substitution: "any",
      enabled: true,
      tz: "America/Los_Angeles",
      perItemCeilingUsd: 25,
    });
  });

  it("is null for a schedule on several days, which the editor cannot show", () => {
    expect(draftOf(stored({ cron: "0 18 * * 1-5" }))).toBeNull();
    expect(draftOf(stored({ cron: "0 18 * * *" }))).toBeNull();
  });

  it("defaults the swap rule and the cap when the policy leaves them out", () => {
    const draft = draftOf(stored({ policy: {} }));
    expect(draft?.substitution).toBe("same_brand");
    expect(draft?.budgetText).toBe("");
    expect(draft?.perItemCeilingUsd).toBeNull();
  });
});

describe("saving", () => {
  it("builds the schedule the database takes", () => {
    const draft = { ...newDraft({ connectionId: CONNECTION }), budgetText: "$150" };
    expect(toInput(draft)).toEqual({
      ok: true,
      input: {
        cron: "0 9 * * 6",
        tz: "America/Los_Angeles",
        connection_id: CONNECTION,
        policy: { budget_cap_usd: 150, substitution: "same_brand" },
        enabled: true,
      },
    });
  });

  it("sends a null cap for an empty field, and keeps a ceiling set elsewhere", () => {
    const result = toInput({
      ...(draftOf(stored()) as NonNullable<ReturnType<typeof draftOf>>),
      budgetText: "",
    });
    expect(result).toMatchObject({
      ok: true,
      input: { policy: { budget_cap_usd: null, per_item_ceiling_usd: 25, substitution: "any" } },
    });
  });

  it("never sends auto_checkout: a scheduled run does not check out by itself", () => {
    const result = toInput(newDraft({ connectionId: CONNECTION }));
    expect(result.ok && Object.keys(result.input.policy)).not.toContain("auto_checkout");
  });

  it("asks for a store, and refuses a cap that is not money", () => {
    expect(toInput(newDraft({}))).toMatchObject({
      ok: false,
      errors: { connection: expect.any(String) },
    });
    for (const text of ["abc", "-5", "0", "12.345", "1e3", "150 dollars", "1000000"]) {
      const result = toInput({ ...newDraft({ connectionId: CONNECTION }), budgetText: text });
      expect(result, text).toMatchObject({ ok: false, errors: { budget: expect.any(String) } });
    }
  });

  it("reads the cap the way people type it", () => {
    expect(parseBudget("")).toEqual({ ok: true, value: null });
    expect(parseBudget("  ")).toEqual({ ok: true, value: null });
    expect(parseBudget("150")).toEqual({ ok: true, value: 150 });
    expect(parseBudget("$1,250.50")).toEqual({ ok: true, value: 1250.5 });
    expect(parseBudget("99.9")).toEqual({ ok: true, value: 99.9 });
  });
});

describe("the next run preview", () => {
  it("is the same moment nextRunAt gives, in the schedule's zone", () => {
    const draft = newDraft({ connectionId: CONNECTION });
    // Wednesday 2026-10-28 12:00 in Los Angeles.
    const next = previewNextRun(draft, new Date("2026-10-28T19:00:00Z"));
    expect(next?.toISOString()).toBe("2026-10-31T16:00:00.000Z");
    expect(formatRun(next as Date, draft.tz)).toBe("Sat, Oct 31 at 9:00 AM");
  });

  it("keeps 9:00 on the clock after the clocks change back", () => {
    const draft = newDraft({ connectionId: CONNECTION });
    const next = previewNextRun(draft, new Date("2026-10-31T16:00:00Z"));
    expect(next?.toISOString()).toBe("2026-11-07T17:00:00.000Z");
    expect(formatRun(next as Date, draft.tz)).toBe("Sat, Nov 7 at 9:00 AM");
  });

  it("follows a changed weekday and time", () => {
    const draft = {
      ...newDraft({ connectionId: CONNECTION }),
      weekday: 2 as const,
      hour: 18,
      minute: 30,
    };
    const next = previewNextRun(draft, new Date("2026-10-28T19:00:00Z"));
    expect(formatRun(next as Date, draft.tz)).toBe("Tue, Nov 3 at 6:30 PM");
  });

  it("is null for a zone that does not exist", () => {
    expect(previewNextRun({ ...newDraft({}), tz: "Nowhere/Land" }, new Date())).toBeNull();
  });
});

describe("the words", () => {
  it("describes a weekly schedule", () => {
    expect(describeSchedule("0 9 * * 6")).toBe("Saturdays at 9:00 AM");
    expect(describeSchedule("30 18 * * 7")).toBe("Sundays at 6:30 PM");
    expect(describeSchedule("0 0 * * 1")).toBe("Mondays at 12:00 AM");
    expect(describeSchedule("15 12 * * *")).toBe("Every day at 12:15 PM");
    expect(describeSchedule("0 18 * * 1-5")).toBe("Mon, Tue, Wed, Thu, Fri at 6:00 PM");
    expect(describeSchedule("nonsense")).toBe("nonsense");
  });

  it("converts between the 12 hour clock and 24 hours", () => {
    for (let hour = 0; hour < 24; hour++) expect(from12h(to12h(hour))).toBe(hour);
    expect(to12h(0)).toEqual({ hour: 12, pm: false });
    expect(to12h(12)).toEqual({ hour: 12, pm: true });
    expect(to12h(15)).toEqual({ hour: 3, pm: true });
    expect(clockText(21, 5)).toBe("9:05 PM");
  });

  it("names a zone and a week", () => {
    expect(zoneLabel("America/Los_Angeles")).toBe("Los Angeles");
    expect(zoneLabel("UTC")).toBe("UTC");
    expect(weekOfText("2026-11-09")).toBe("Nov 9");
  });
});

describe("store choices", () => {
  const connection = (over: Partial<ScheduleConnection>): ScheduleConnection => ({
    id: CONNECTION,
    retailer: "kroger",
    storeName: "QFC Duvall",
    status: "active",
    unattended: true,
    ...over,
  });

  it("offers an active store and explains one that cannot be picked", () => {
    const choices = connectionChoices([
      connection({}),
      connection({
        id: "tier3",
        retailer: "safeway",
        storeName: "Safeway Duvall",
        unattended: false,
      }),
      connection({ id: "stale", status: "needs_reauth" }),
      connection({ id: "gone", status: "revoked", storeName: null }),
    ]);
    expect(choices.map((c) => [c.id, c.reason === null])).toEqual([
      [CONNECTION, true],
      ["tier3", false],
      ["stale", false],
      ["gone", false],
    ]);
    expect(choices[1]?.reason).toMatch(/runs on your phone/);
    expect(choices[2]?.reason).toMatch(/new sign-in/);
    expect(choices[0]?.label).toBe("QFC Duvall");
  });

  it("starts a new schedule at the first store that can run by itself", () => {
    expect(
      defaultConnectionId([
        connection({ id: "tier3", unattended: false }),
        connection({ id: "stale", status: "needs_reauth" }),
        connection({ id: "good" }),
      ]),
    ).toBe("good");
    expect(defaultConnectionId([connection({ unattended: false })])).toBeNull();
    expect(defaultConnectionId([])).toBeNull();
  });
});
