// useSignOut (WS09 hook, tested here since the WS09 review found nothing did): signing out deletes
// this device's push token row before the session ends. Remove the call from useSignOut and these
// tests fail. Also the two ways it can go wrong: a registration still in flight, and a delete that
// fails or hangs.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement } from "react";
import { act, create } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  events: [] as string[],
  deleteResult: { error: null } as { error: unknown },
  deleteHangs: false,
  signOutResult: { error: null } as { error: unknown },
  signOutArgs: [] as unknown[],
  rpcCalls: [] as Array<{ fn: string; args: unknown }>,
}));

vi.mock("@mp/db", () => ({
  useSupabase: () => ({
    from: (table: string) => ({
      delete: () => ({
        eq: (column: string, value: string) => {
          h.events.push(`delete ${table} ${column}=${value}`);
          return h.deleteHangs ? new Promise(() => {}) : Promise.resolve(h.deleteResult);
        },
      }),
    }),
    auth: {
      signOut: async (options: unknown) => {
        h.events.push("signOut");
        h.signOutArgs.push(options);
        return h.signOutResult;
      },
    },
    rpc: (fn: string, args: unknown) => {
      h.events.push(`rpc ${fn}`);
      h.rpcCalls.push({ fn, args });
      return Promise.resolve({ data: null, error: null });
    },
  }),
}));

import { registerDevice, rememberPushToken, trackRegistration } from "../shopping/pushToken";
import { useSignOut } from "./useSignOut";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const TOKEN = "ExponentPushToken[this-phone]";

function mountHook() {
  let hook: ReturnType<typeof useSignOut> | null = null;
  function Probe() {
    hook = useSignOut();
    return null;
  }
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  act(() => {
    create(createElement(QueryClientProvider, { client }, createElement(Probe)));
  });
  return () => {
    if (!hook) throw new Error("hook not rendered");
    return hook;
  };
}

beforeEach(() => {
  h.events = [];
  h.deleteResult = { error: null };
  h.deleteHangs = false;
  h.signOutResult = { error: null };
  h.signOutArgs = [];
  h.rpcCalls = [];
  rememberPushToken(null);
});

afterEach(() => {
  vi.useRealTimers();
  rememberPushToken(null);
});

describe("useSignOut and this device's push token", () => {
  it("deletes this device's token row, and only then ends the session, on this device only", async () => {
    rememberPushToken(TOKEN);
    const current = mountHook();
    await act(async () => {
      await current().mutateAsync();
    });
    expect(h.events).toEqual([`delete push_tokens token=${TOKEN}`, "signOut"]);
    expect(h.signOutArgs).toEqual([{ scope: "local" }]);
  });

  it("deletes the row once: a second sign-out on the same device has nothing left to delete", async () => {
    rememberPushToken(TOKEN);
    const current = mountHook();
    await act(async () => {
      await current().mutateAsync();
      await current().mutateAsync();
    });
    expect(h.events.filter((e) => e.startsWith("delete"))).toHaveLength(1);
  });

  it("still signs out on a device that never registered (web, no permission)", async () => {
    const current = mountHook();
    await act(async () => {
      await current().mutateAsync();
    });
    expect(h.events).toEqual(["signOut"]);
  });

  it("signs out even when the delete fails, and forgets the token by value afterwards", async () => {
    rememberPushToken(TOKEN);
    h.deleteResult = { error: { message: "TypeError: Failed to fetch" } };
    const current = mountHook();
    await act(async () => {
      await current().mutateAsync();
    });
    expect(h.events).toEqual([
      `delete push_tokens token=${TOKEN}`,
      "signOut",
      "rpc forget_push_token",
    ]);
    expect(h.rpcCalls).toEqual([{ fn: "forget_push_token", args: { p_token: TOKEN } }]);
  });

  it("does not wait longer than a few seconds for a delete that hangs", async () => {
    vi.useFakeTimers();
    rememberPushToken(TOKEN);
    h.deleteHangs = true;
    const current = mountHook();
    let done = false;
    let started!: Promise<void>;
    await act(async () => {
      started = current()
        .mutateAsync()
        .then(() => {
          done = true;
        });
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(done).toBe(false);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_500);
      await started;
    });
    expect(done).toBe(true);
    expect(h.events).toEqual([`delete push_tokens token=${TOKEN}`, "signOut"]);
  });

  it("passes a sign-out error on", async () => {
    h.signOutResult = { error: new Error("network") };
    const current = mountHook();
    await act(async () => {
      await expect(current().mutateAsync()).rejects.toThrow("network");
    });
  });
});

describe("signing out before the registration finishes", () => {
  it("waits for the registration in flight, then deletes the row it made", async () => {
    let finish: () => void = () => {};
    const stored = new Promise<void>((resolve) => {
      finish = resolve;
    });
    trackRegistration(
      registerDevice({
        getToken: async () => TOKEN,
        register: () => stored,
        forgetBySecret: async () => {},
        isCancelled: () => false,
      }),
    );
    const current = mountHook();
    let signedOut = false;
    let started!: Promise<void>;
    await act(async () => {
      started = current()
        .mutateAsync()
        .then(() => {
          signedOut = true;
        });
      await Promise.resolve();
    });
    // The token is registered but not yet stored: the sign-out holds back.
    expect(h.events).toEqual([]);
    expect(signedOut).toBe(false);
    await act(async () => {
      finish();
      await started;
    });
    expect(signedOut).toBe(true);
    expect(h.events).toEqual([`delete push_tokens token=${TOKEN}`, "signOut"]);
  });

  it("does not hold sign-out hostage to a registration that never answers", async () => {
    vi.useFakeTimers();
    trackRegistration(
      registerDevice({
        getToken: async () => TOKEN,
        register: () => new Promise<void>(() => {}),
        forgetBySecret: async () => {},
        isCancelled: () => false,
      }),
    );
    const current = mountHook();
    let started!: Promise<void>;
    await act(async () => {
      started = current()
        .mutateAsync()
        .then(() => undefined);
      await vi.advanceTimersByTimeAsync(3_500);
      await started;
    });
    // The row it was making is deleted as soon as the wait runs out, and the session ends.
    expect(h.events).toEqual([`delete push_tokens token=${TOKEN}`, "signOut"]);
  });
});
