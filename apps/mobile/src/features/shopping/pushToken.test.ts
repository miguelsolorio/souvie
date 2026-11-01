import { afterEach, describe, expect, it } from "vitest";
import { forgetPushToken, rememberPushToken } from "./pushToken";

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
