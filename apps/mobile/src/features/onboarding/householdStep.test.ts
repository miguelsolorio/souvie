// What Continue does on the first onboarding screen, and who is asked how much they want to plan.
import { IdentityError } from "@mp/db";
import { describe, expect, it, vi } from "vitest";
import {
  asksPlanMode,
  type ExistingHousehold,
  type HouseholdStepDeps,
  NEW_HOUSEHOLD_PLAN_MODE,
  SAVE_FAILED,
  shownPlanMode,
  submitHouseholdStep,
} from "./householdStep";

const INVITE = "0123456789abcdef0123456789abcdef";

/** Fake calls that record the order they happen in. */
function deps(over: Partial<HouseholdStepDeps> = {}) {
  const calls: string[] = [];
  const value: HouseholdStepDeps = {
    createHousehold: vi.fn(async (name: string) => {
      calls.push(`create:${name}`);
      return "h-new";
    }),
    redeemInvite: vi.fn(async (token: string) => {
      calls.push(`redeem:${token}`);
      return "h-joined";
    }),
    refreshHousehold: vi.fn(async () => {
      calls.push("refresh");
    }),
    setPlanMode: vi.fn(async ({ householdId, mode }) => {
      calls.push(`mode:${householdId}:${mode}`);
    }),
    finish: vi.fn(async () => {
      calls.push("finish");
    }),
    ...over,
  };
  return { value, calls };
}

const owner = (plan_mode: "simple" | "full" = "simple"): ExistingHousehold => ({
  id: "h1",
  role: "owner",
  plan_mode,
});
const member = (plan_mode: "simple" | "full" = "simple"): ExistingHousehold => ({
  id: "h1",
  role: "member",
  plan_mode,
});

const create = { kind: "create", name: "Our kitchen" } as const;
const join = { kind: "join", invite: INVITE } as const;

describe("who is asked", () => {
  it("asks a person who is creating a household, because they will own it", () => {
    expect(asksPlanMode(null, "create")).toBe(true);
  });

  it("does not ask a person who is joining one, because they will be a member", () => {
    expect(asksPlanMode(null, "join")).toBe(false);
  });

  it("asks the owner of the household they are already in", () => {
    expect(asksPlanMode(owner(), "create")).toBe(true);
    // Whichever tab was last left open: it no longer matters once there is a household.
    expect(asksPlanMode(owner(), "join")).toBe(true);
  });

  it("does not ask a member of the household they are already in", () => {
    expect(asksPlanMode(member(), "create")).toBe(false);
    expect(asksPlanMode(member(), "join")).toBe(false);
  });
});

describe("what the question shows", () => {
  it("preselects Just dinners for a household that does not exist yet", () => {
    expect(NEW_HOUSEHOLD_PLAN_MODE).toBe("simple");
    expect(shownPlanMode(null, null)).toBe("simple");
  });

  it("follows the saved mode until the person picks", () => {
    expect(shownPlanMode(null, owner("full"))).toBe("full");
    expect(shownPlanMode(null, owner("simple"))).toBe("simple");
  });

  it("shows the person's pick over everything else", () => {
    expect(shownPlanMode("full", null)).toBe("full");
    expect(shownPlanMode("simple", owner("full"))).toBe("simple");
  });
});

describe("Continue when creating a household", () => {
  it("leaves a new household on Just dinners with no extra write", async () => {
    const { value, calls } = deps();
    const result = await submitHouseholdStep(
      { existing: null, action: create, planMode: "simple" },
      value,
    );
    expect(result).toEqual({ ok: true });
    expect(calls).toEqual(["create:Our kitchen", "refresh", "finish"]);
    expect(value.setPlanMode).not.toHaveBeenCalled();
  });

  it("writes Every meal to the new household, after it exists and has been reloaded", async () => {
    const { value, calls } = deps();
    const result = await submitHouseholdStep(
      { existing: null, action: create, planMode: "full" },
      value,
    );
    expect(result).toEqual({ ok: true });
    expect(calls).toEqual(["create:Our kitchen", "refresh", "mode:h-new:full", "finish"]);
  });

  it("trims the name the way the household form always has", async () => {
    const { value, calls } = deps();
    await submitHouseholdStep(
      { existing: null, action: { kind: "create", name: "  Our kitchen  " }, planMode: "simple" },
      value,
    );
    expect(calls[0]).toBe("create:Our kitchen");
  });

  it("asks for a real name and creates nothing without one", async () => {
    const { value, calls } = deps();
    const result = await submitHouseholdStep(
      { existing: null, action: { kind: "create", name: "x" }, planMode: "full" },
      value,
    );
    expect(result).toEqual({
      ok: false,
      error: "Give your household a name of 2 to 40 characters.",
    });
    expect(calls).toEqual([]);
  });

  it("keeps the household when the mode write fails, so Continue never creates a second one", async () => {
    const { value, calls } = deps({
      setPlanMode: vi.fn(async () => {
        throw new IdentityError("unknown");
      }),
    });
    const result = await submitHouseholdStep(
      { existing: null, action: create, planMode: "full" },
      value,
    );
    expect(result).toEqual({ ok: false, error: "Something went wrong. Try again." });
    // The household was reloaded before the write, so the screen now shows it as existing.
    expect(calls).toEqual(["create:Our kitchen", "refresh"]);

    // Continue again: the screen passes the household it now has, and only the write is retried.
    const retry = deps();
    const again = await submitHouseholdStep(
      {
        existing: { id: "h-new", role: "owner", plan_mode: "simple" },
        action: create,
        planMode: "full",
      },
      retry.value,
    );
    expect(again).toEqual({ ok: true });
    expect(retry.calls).toEqual(["mode:h-new:full", "finish"]);
    expect(retry.value.createHousehold).not.toHaveBeenCalled();
  });

  it("shows the database's own words when creating fails", async () => {
    const { value } = deps({
      createHousehold: vi.fn(async () => {
        throw new IdentityError("not_authenticated");
      }),
    });
    const result = await submitHouseholdStep(
      { existing: null, action: create, planMode: "simple" },
      value,
    );
    expect(result).toEqual({ ok: false, error: "Your session has ended. Sign in again." });
  });
});

describe("Continue when joining a household", () => {
  it("makes a member and writes no mode, whatever the question last showed", async () => {
    const { value, calls } = deps();
    const result = await submitHouseholdStep(
      { existing: null, action: join, planMode: "full" },
      value,
    );
    expect(result).toEqual({ ok: true });
    expect(calls).toEqual([`redeem:${INVITE}`, "refresh", "finish"]);
    expect(value.setPlanMode).not.toHaveBeenCalled();
  });

  it("asks for a real invite and joins nothing without one", async () => {
    const { value, calls } = deps();
    const result = await submitHouseholdStep(
      { existing: null, action: { kind: "join", invite: "nope" }, planMode: "simple" },
      value,
    );
    expect(result).toEqual({ ok: false, error: "That does not look like an invite link or code." });
    expect(calls).toEqual([]);
  });

  it("shows the invite error in plain words", async () => {
    const { value } = deps({
      redeemInvite: vi.fn(async () => {
        throw new IdentityError("invite_used");
      }),
    });
    const result = await submitHouseholdStep(
      { existing: null, action: join, planMode: "simple" },
      value,
    );
    expect(result).toEqual({
      ok: false,
      error: "This invite link has already been used. Ask for a new one.",
    });
  });
});

describe("Continue when already in a household", () => {
  it("writes the mode for an owner who changed it, then finishes", async () => {
    const { value, calls } = deps();
    const result = await submitHouseholdStep(
      { existing: owner("simple"), action: create, planMode: "full" },
      value,
    );
    expect(result).toEqual({ ok: true });
    expect(calls).toEqual(["mode:h1:full", "finish"]);
    expect(value.createHousehold).not.toHaveBeenCalled();
    expect(value.refreshHousehold).not.toHaveBeenCalled();
  });

  it("writes Just dinners for an owner who changed back", async () => {
    const { value, calls } = deps();
    await submitHouseholdStep(
      { existing: owner("full"), action: create, planMode: "simple" },
      value,
    );
    expect(calls).toEqual(["mode:h1:simple", "finish"]);
  });

  it("writes nothing for an owner who left the saved mode alone", async () => {
    const { value, calls } = deps();
    await submitHouseholdStep({ existing: owner("full"), action: create, planMode: "full" }, value);
    expect(calls).toEqual(["finish"]);
  });

  it("writes nothing for a member, even if a stale pick says otherwise", async () => {
    const { value, calls } = deps();
    const result = await submitHouseholdStep(
      { existing: member("simple"), action: join, planMode: "full" },
      value,
    );
    expect(result).toEqual({ ok: true });
    expect(calls).toEqual(["finish"]);
    expect(value.setPlanMode).not.toHaveBeenCalled();
  });

  it("says it could not save when the write fails, and does not move on", async () => {
    const { value, calls } = deps({
      setPlanMode: vi.fn(async () => {
        throw new Error("offline");
      }),
    });
    const result = await submitHouseholdStep(
      { existing: owner("simple"), action: create, planMode: "full" },
      value,
    );
    expect(result).toEqual({ ok: false, error: SAVE_FAILED });
    expect(calls).toEqual([]);
  });

  it("says it could not save when saving the step fails", async () => {
    const { value } = deps({
      finish: vi.fn(async () => {
        throw new Error("offline");
      }),
    });
    const result = await submitHouseholdStep(
      { existing: member(), action: join, planMode: "simple" },
      value,
    );
    expect(result).toEqual({ ok: false, error: SAVE_FAILED });
  });
});
