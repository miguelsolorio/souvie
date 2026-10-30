import { describe, expect, it } from "vitest";
import { gate, type Outcome, summarize } from "./score.ts";

// Made-up results: the gate is a pure function of the outcome list.

const OPTIONS = { threshold: 45, requireRecordings: false };

function pass(n: number, offset = 0): Outcome[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `pass-${offset + i}`,
    domain: "example.test",
    path: "jsonld" as const,
    status: "PASS" as const,
    detail: "title ok",
  }));
}

function fail(n: number, path: "jsonld" | "blocked" | "failed" = "jsonld"): Outcome[] {
  return Array.from(
    { length: n },
    (_, i): Outcome => ({
      id: `fail-${path}-${i}`,
      domain: "example.test",
      path,
      status: "FAIL",
      detail: "403",
    }),
  );
}

function pending(n: number): Outcome[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `pend-${i}`,
    domain: "example.test",
    path: "llm" as const,
    status: "PEND" as const,
    detail: "needs a Sonnet answer",
  }));
}

describe("gate with nothing pending", () => {
  it("passes at the threshold and allows failures up to the margin", () => {
    expect(gate([...pass(45), ...fail(5)], OPTIONS)).toEqual({ ok: true, problems: [] });
    expect(gate(pass(50), OPTIONS).ok).toBe(true);
  });

  it("fails under the threshold, counting blocked and failed cases as failures", () => {
    expect(gate([...pass(44), ...fail(6)], OPTIONS).problems).toEqual([
      "44/50 passed, under the threshold of 45",
    ]);
    expect(gate([...pass(44), ...fail(3, "blocked"), ...fail(3, "failed")], OPTIONS).ok).toBe(
      false,
    );
  });
});

describe("gate with pending cases", () => {
  it("is green when every known case passes", () => {
    expect(gate([...pass(44), ...pending(6)], OPTIONS)).toEqual({ ok: true, problems: [] });
  });

  it("is red on a single failure: pending cannot cover for it", () => {
    const verdict = gate([...pass(43), ...fail(1), ...pending(6)], OPTIONS);
    expect(verdict.ok).toBe(false);
    expect(verdict.problems).toHaveLength(1);
    expect(verdict.problems[0]).toContain("1 case(s) failed while 6 are pending");
    expect(verdict.problems[0]).toContain("fail-jsonld-0");
  });

  it("is red when the JSON-LD path regressed to 39 passes, though 39 + 6 pending reaches 45", () => {
    const outcomes = [...pass(39), ...fail(5), ...pending(6)];
    const summary = summarize(outcomes);
    expect(summary.pass + summary.pending).toBe(45);
    expect(gate(outcomes, OPTIONS).ok).toBe(false);
  });

  it("is red when a blocked site is among the failures", () => {
    expect(gate([...pass(43), ...fail(1, "blocked"), ...pending(6)], OPTIONS).ok).toBe(false);
  });

  it("is red when even all pending cases passing could not reach the threshold", () => {
    const verdict = gate([...pass(30), ...pending(10)], OPTIONS);
    expect(verdict.ok).toBe(false);
    expect(verdict.problems[0]).toContain("40/40 is under the threshold of 45");
  });
});

describe("gate with EVAL_REQUIRE_RECORDINGS", () => {
  const strict = { threshold: 45, requireRecordings: true };

  it("counts a pending case as a failure", () => {
    const verdict = gate([...pass(44), ...pending(6)], strict);
    expect(verdict.ok).toBe(false);
    expect(verdict.problems[0]).toContain(
      "6 case(s) have no recorded Sonnet answer and EVAL_REQUIRE_RECORDINGS=1 counts them as failures",
    );
  });

  it("is green once the recordings exist and 45 cases pass", () => {
    expect(gate(pass(50), strict)).toEqual({ ok: true, problems: [] });
    expect(gate([...pass(47), ...fail(3)], strict).ok).toBe(true);
  });

  it("changes nothing when no case is pending", () => {
    expect(gate([...pass(44), ...fail(6)], strict)).toEqual(
      gate([...pass(44), ...fail(6)], OPTIONS),
    );
  });
});
