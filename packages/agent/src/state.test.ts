import { describe, expect, it } from "vitest";
import {
  ACTIVE_STATUSES,
  assertTransition,
  canTransition,
  InvalidTransitionError,
  isTerminal,
  type RunClock,
  TERMINAL_STATUSES,
  TRANSITIONS,
  transition,
} from "./state.ts";
import { RUN_STATUSES, type RunStatus } from "./types.ts";

/** The legal moves, written out by hand from docs/03-ai-design.md §8 and the brief. */
const LEGAL: Array<[RunStatus, RunStatus]> = [
  ["queued", "running"],
  ["running", "needs_review"],
  ["needs_review", "running"],
  ["running", "cart_ready"],
  ["cart_ready", "checking_out"],
  ["checking_out", "checked_out"],
  ["running", "queued"],
  ...ACTIVE_STATUSES.flatMap(
    (from): Array<[RunStatus, RunStatus]> => [
      [from, "failed"],
      [from, "cancelled"],
    ],
  ),
];

describe("run state machine", () => {
  it.each(LEGAL)("allows %s -> %s", (from, to) => {
    expect(canTransition(from, to)).toBe(true);
    expect(() => assertTransition(from, to)).not.toThrow();
  });

  it("allows nothing else", () => {
    const legal = new Set(LEGAL.map(([from, to]) => `${from}>${to}`));
    for (const from of RUN_STATUSES) {
      for (const to of RUN_STATUSES) {
        expect(canTransition(from, to), `${from} -> ${to}`).toBe(legal.has(`${from}>${to}`));
      }
    }
  });

  it("refuses queued -> cart_ready", () => {
    expect(() => assertTransition("queued", "cart_ready")).toThrow(InvalidTransitionError);
    expect(() => assertTransition("queued", "cart_ready")).toThrow(
      "invalid_transition: queued -> cart_ready",
    );
  });

  it("refuses checked_out -> running", () => {
    expect(() => assertTransition("checked_out", "running")).toThrow(InvalidTransitionError);
  });

  it("treats checked_out, failed and cancelled as terminal with no way out", () => {
    for (const status of TERMINAL_STATUSES) {
      expect(isTerminal(status)).toBe(true);
      expect(TRANSITIONS[status]).toEqual([]);
    }
    expect(isTerminal("cart_ready")).toBe(false);
  });

  it("refuses to skip review: running -> checking_out and needs_review -> cart_ready", () => {
    expect(canTransition("running", "checking_out")).toBe(false);
    expect(canTransition("needs_review", "cart_ready")).toBe(false);
  });

  it("stamps the clock the way the SQL guard does", () => {
    const t0 = new Date("2026-10-31T10:00:00Z");
    const t1 = new Date("2026-10-31T10:05:00Z");
    const t2 = new Date("2026-10-31T10:09:00Z");
    let run: RunClock = {
      status: "queued",
      startedAt: null,
      finishedAt: null,
      statusChangedAt: t0.toISOString(),
    };
    run = transition(run, "running", t0);
    expect(run.startedAt).toBe(t0.toISOString());
    run = transition(run, "needs_review", t1);
    expect(run.startedAt).toBe(t0.toISOString());
    expect(run.finishedAt).toBeNull();
    run = transition(run, "running", t1);
    run = transition(run, "cart_ready", t2);
    expect(run.finishedAt).toBe(t2.toISOString());
    expect(run.statusChangedAt).toBe(t2.toISOString());
    expect(() => transition(run, "needs_review", t2)).toThrow(InvalidTransitionError);
  });
});
