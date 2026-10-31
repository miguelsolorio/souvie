// The run state machine (docs/03-ai-design.md §8). The same table is enforced in SQL by the
// shopping_runs status guard (supabase/migrations/*_ws09_runs.sql), so a writer that skips this
// module still cannot make an illegal move. services/shopper-worker/src/store.test.ts checks
// every (from, to) pair against shopping_run_transition_allowed, so the two tables stay identical.
//
//   queued ──> running ──> needs_review ──> running (push phase) ──> cart_ready
//                │                                                     │
//                └─> queued (handed back: shutdown, retry)             └─> checking_out ──> checked_out
//
//   failed and cancelled are reachable from every active state. checked_out, failed and cancelled
//   are terminal.
import { RUN_STATUSES, type RunStatus } from "./types.ts";

export const ACTIVE_STATUSES: readonly RunStatus[] = [
  "queued",
  "running",
  "needs_review",
  "cart_ready",
  "checking_out",
];

export const TERMINAL_STATUSES: readonly RunStatus[] = ["checked_out", "failed", "cancelled"];

/** Statuses where the run rests and waits for a person (or ends). The snapshot clock starts here. */
export const CLOSED_STATUSES: readonly RunStatus[] = [
  "cart_ready",
  "checked_out",
  "failed",
  "cancelled",
];

const FORWARD: Readonly<Record<RunStatus, readonly RunStatus[]>> = {
  queued: ["running"],
  running: ["queued", "needs_review", "cart_ready"],
  needs_review: ["running"],
  cart_ready: ["checking_out"],
  checking_out: ["checked_out"],
  checked_out: [],
  failed: [],
  cancelled: [],
};

/** Every legal (from, to) pair, the failure and cancel edges included. */
export const TRANSITIONS: Readonly<Record<RunStatus, readonly RunStatus[]>> = Object.freeze(
  Object.fromEntries(
    RUN_STATUSES.map((from) => [
      from,
      ACTIVE_STATUSES.includes(from)
        ? [...FORWARD[from], "failed" as const, "cancelled" as const]
        : [],
    ]),
  ) as unknown as Record<RunStatus, readonly RunStatus[]>,
);

export class InvalidTransitionError extends Error {
  readonly from: RunStatus;
  readonly to: RunStatus;

  constructor(from: RunStatus, to: RunStatus) {
    super(`invalid_transition: ${from} -> ${to}`);
    this.name = "InvalidTransitionError";
    this.from = from;
    this.to = to;
  }
}

export function isRunStatus(value: unknown): value is RunStatus {
  return typeof value === "string" && (RUN_STATUSES as readonly string[]).includes(value);
}

export function canTransition(from: RunStatus, to: RunStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function assertTransition(from: RunStatus, to: RunStatus): void {
  if (!canTransition(from, to)) throw new InvalidTransitionError(from, to);
}

export function isTerminal(status: RunStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

export function isActive(status: RunStatus): boolean {
  return ACTIVE_STATUSES.includes(status);
}

/** The timestamps a run row carries, as the guard trigger maintains them. */
export interface RunClock {
  status: RunStatus;
  startedAt: string | null;
  finishedAt: string | null;
  statusChangedAt: string;
}

/**
 * Applies one transition to a run's clock, checked. Mirrors the SQL guard: the first `running`
 * stamps startedAt, a closed status stamps finishedAt, any other clears it.
 */
export function transition(run: RunClock, to: RunStatus, now: Date): RunClock {
  assertTransition(run.status, to);
  const at = now.toISOString();
  return {
    status: to,
    startedAt: run.startedAt ?? (to === "running" ? at : null),
    finishedAt: CLOSED_STATUSES.includes(to) ? at : null,
    statusChangedAt: at,
  };
}
