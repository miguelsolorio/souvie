import { afterEach, describe, expect, it } from "vitest";
import {
  currentPushToken,
  forgetPushToken,
  type RegisterDeps,
  registerDevice,
  rememberPushToken,
  trackRegistration,
} from "./pushToken";

afterEach(() => {
  rememberPushToken(null);
});

describe("this device's push token on sign-out", () => {
  it("deletes the registered row once, then has nothing left to delete", async () => {
    const removed: string[] = [];
    rememberPushToken("ExponentPushToken[device]");
    await forgetPushToken(async (token) => {
      removed.push(token);
    });
    await forgetPushToken(async (token) => {
      removed.push(token);
    });
    expect(removed).toEqual(["ExponentPushToken[device]"]);
  });

  it("does nothing on a device that never registered (web, no permission)", async () => {
    let called = false;
    await forgetPushToken(async () => {
      called = true;
    });
    expect(called).toBe(false);
  });

  it("never blocks sign-out: a failing or hanging delete is let go", async () => {
    rememberPushToken("ExponentPushToken[a]");
    await expect(
      forgetPushToken(async () => {
        throw new Error("offline");
      }),
    ).resolves.toBeUndefined();
    rememberPushToken("ExponentPushToken[b]");
    const started = Date.now();
    await forgetPushToken(() => new Promise(() => {}), 20);
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});

describe("registering a device", () => {
  const TOKEN = "ExponentPushToken[phone]";
  const deps = (over: Partial<RegisterDeps> = {}): RegisterDeps & { forgotten: string[] } => {
    const forgotten: string[] = [];
    return {
      getToken: async () => TOKEN,
      register: async () => {},
      forgetBySecret: async (token) => {
        forgotten.push(token);
      },
      isCancelled: () => false,
      forgotten,
      ...over,
    };
  };

  it("remembers the token once it is stored, for the sign-out to delete", async () => {
    const d = deps();
    expect(await registerDevice(d)).toBe(TOKEN);
    expect(currentPushToken()).toBe(TOKEN);
    expect(d.forgotten).toEqual([]);
  });

  it("remembers it before the call that stores it answers, so a sign-out in that gap deletes it", async () => {
    let seen: string | null = null;
    await registerDevice(
      deps({
        register: async () => {
          seen = currentPushToken();
        },
      }),
    );
    expect(seen).toBe(TOKEN);
  });

  it("stores nothing when the session ended before there was a token", async () => {
    const stored: string[] = [];
    const d = deps({
      register: async (token) => {
        stored.push(token);
      },
      isCancelled: () => true,
    });
    expect(await registerDevice(d)).toBeNull();
    expect(stored).toEqual([]);
    expect(d.forgotten).toEqual([]);
    expect(currentPushToken()).toBeNull();
  });

  it("forgets by value a token stored after the session ended", async () => {
    let cancelled = false;
    const d = deps({
      register: async () => {
        cancelled = true; // the person signed out while the call was in flight
      },
      isCancelled: () => cancelled,
    });
    expect(await registerDevice(d)).toBeNull();
    expect(d.forgotten).toEqual([TOKEN]);
    expect(currentPushToken()).toBeNull();
  });

  it("forgets a token that failed to store and does not throw", async () => {
    const d = deps({
      register: async () => {
        throw new Error("offline");
      },
    });
    expect(await registerDevice(d)).toBeNull();
    expect(currentPushToken()).toBeNull();
  });

  it("has nothing to register when permission is denied", async () => {
    expect(await registerDevice(deps({ getToken: async () => null }))).toBeNull();
    expect(currentPushToken()).toBeNull();
  });

  it("makes a sign-out wait for a registration in flight", async () => {
    let finish: () => void = () => {};
    const stored = new Promise<void>((resolve) => {
      finish = resolve;
    });
    trackRegistration(registerDevice(deps({ register: () => stored })));
    const removed: string[] = [];
    const forgetting = forgetPushToken(async (token) => {
      removed.push(token);
    });
    await Promise.resolve();
    expect(removed).toEqual([]);
    finish();
    await forgetting;
    expect(removed).toEqual([TOKEN]);
  });
});
