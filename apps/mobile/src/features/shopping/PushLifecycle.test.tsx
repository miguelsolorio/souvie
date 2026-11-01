// PushLifecycle (the phone's push registration): one registration per launch, none for a person who
// signed out before it finished, a token stored after the session ended is forgotten, and a
// session that ends without a sign-out (revoked from another device) forgets the token by value,
// so the phone stops receiving the household's pushes. react-test-renderer over stand-ins for the
// Expo modules; the SQL these calls reach is tested in supabase/tests/ws11_schedules_notifications.sql.
import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  session: { status: "signed-in", user: { id: "user-a" } } as {
    status: "loading" | "signed-in" | "signed-out";
    user: { id: string } | null;
  },
  client: { id: "client" },
  token: "ExponentPushToken[phone]",
  tokenGate: null as Promise<void> | null,
  registerGate: null as Promise<void> | null,
  registerCalls: [] as Array<{ token: string; platform: string }>,
  forgetCalls: [] as string[],
  permission: { granted: true },
  pushed: [] as string[],
  listener: null as null | ((response: unknown) => void),
}));

vi.mock("react-native", () => ({ Platform: { OS: "ios" } }));

vi.mock("expo-constants", () => ({
  default: { expoConfig: { extra: { eas: { projectId: "project-1" } } } },
}));

vi.mock("expo-router", () => ({ useRouter: () => ({ push: (r: string) => h.pushed.push(r) }) }));

vi.mock("expo-notifications", () => ({
  setNotificationHandler: () => {},
  getPermissionsAsync: async () => h.permission,
  requestPermissionsAsync: async () => h.permission,
  getExpoPushTokenAsync: async () => {
    if (h.tokenGate) await h.tokenGate;
    return { data: h.token };
  },
  addNotificationResponseReceivedListener: (fn: (response: unknown) => void) => {
    h.listener = fn;
    return { remove: () => {} };
  },
}));

vi.mock("@mp/db", () => ({
  useSession: () => h.session,
  useSupabase: () => h.client,
  registerPushToken: async (_client: unknown, token: string, platform: string) => {
    h.registerCalls.push({ token, platform });
    if (h.registerGate) await h.registerGate;
  },
  forgetPushTokenBySecret: async (_client: unknown, token: string) => {
    h.forgetCalls.push(token);
  },
}));

import { PushLifecycle } from "./PushLifecycle.native";
import { currentPushToken, forgetPushToken, rememberPushToken } from "./pushToken";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean; __DEV__?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;
(globalThis as { __DEV__?: boolean }).__DEV__ = false;

function gate() {
  let open: () => void = () => {};
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

async function mount(): Promise<ReactTestRenderer> {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(createElement(PushLifecycle));
  });
  return renderer;
}

async function rerender(renderer: ReactTestRenderer) {
  await act(async () => {
    renderer.update(createElement(PushLifecycle));
  });
}

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

beforeEach(() => {
  h.session = { status: "signed-in", user: { id: "user-a" } };
  h.tokenGate = null;
  h.registerGate = null;
  h.registerCalls = [];
  h.forgetCalls = [];
  h.permission = { granted: true };
  h.pushed = [];
  h.listener = null;
  rememberPushToken(null);
});

describe("registering this phone", () => {
  it("registers the Expo token through register_push_token once per launch", async () => {
    const renderer = await mount();
    await settle();
    expect(h.registerCalls).toEqual([{ token: h.token, platform: "ios" }]);
    expect(currentPushToken()).toBe(h.token);
    // Rendering again for the same person does not register again.
    await rerender(renderer);
    await settle();
    expect(h.registerCalls).toHaveLength(1);
    // The next launch registers again; the function refreshes the row instead of adding one.
    renderer.unmount();
    rememberPushToken(null);
    await mount();
    await settle();
    expect(h.registerCalls).toHaveLength(2);
  });

  it("registers nothing when notifications are not allowed", async () => {
    h.permission = { granted: false };
    await mount();
    await settle();
    expect(h.registerCalls).toEqual([]);
    expect(currentPushToken()).toBeNull();
  });

  it("registers nothing for a person who is not signed in", async () => {
    h.session = { status: "signed-out", user: null };
    await mount();
    await settle();
    expect(h.registerCalls).toEqual([]);
  });
});

describe("signing out before the registration finishes", () => {
  it("stores nothing when the session ends while the permission prompt is still open", async () => {
    const prompt = gate();
    h.tokenGate = prompt.promise;
    const renderer = await mount();
    h.session = { status: "signed-out", user: null };
    await rerender(renderer);
    prompt.open();
    await settle();
    expect(h.registerCalls).toEqual([]);
    expect(h.forgetCalls).toEqual([]);
    expect(currentPushToken()).toBeNull();
  });

  it("forgets by value a token whose registration was still in flight when the session ended", async () => {
    const storing = gate();
    h.registerGate = storing.promise;
    const renderer = await mount();
    await settle();
    expect(h.registerCalls).toHaveLength(1);
    h.session = { status: "signed-out", user: null };
    await rerender(renderer);
    storing.open();
    await settle();
    expect(h.forgetCalls).toEqual([h.token]);
    expect(currentPushToken()).toBeNull();
  });
});

describe("a session that ends without a sign-out", () => {
  it("forgets this phone's token by value, so the phone stops receiving the household's pushes", async () => {
    const renderer = await mount();
    await settle();
    expect(currentPushToken()).toBe(h.token);
    // The account was signed out from another device: the session goes, nobody pressed Sign out.
    h.session = { status: "signed-out", user: null };
    await rerender(renderer);
    await settle();
    expect(h.forgetCalls).toEqual([h.token]);
    expect(currentPushToken()).toBeNull();
  });

  it("leaves it to useSignOut when the person pressed Sign out (already deleted: nothing to forget)", async () => {
    const renderer = await mount();
    await settle();
    // What useSignOut does first: delete the row with the session, which forgets the token.
    await forgetPushToken(async () => {});
    h.session = { status: "signed-out", user: null };
    await rerender(renderer);
    await settle();
    expect(h.forgetCalls).toEqual([]);
  });

  it("registers the next person who signs in on the phone", async () => {
    const renderer = await mount();
    await settle();
    h.session = { status: "signed-out", user: null };
    await rerender(renderer);
    await settle();
    h.session = { status: "signed-in", user: { id: "user-b" } };
    await rerender(renderer);
    await settle();
    expect(h.registerCalls).toEqual([
      { token: h.token, platform: "ios" },
      { token: h.token, platform: "ios" },
    ]);
    expect(currentPushToken()).toBe(h.token);
  });
});

describe("tapping a notification", () => {
  it("opens what it names", async () => {
    await mount();
    const id = "5a000000-0000-4000-8000-0000000000aa";
    h.listener?.({
      notification: { request: { content: { data: { type: "cart_ready", runId: id } } } },
    });
    h.listener?.({
      notification: { request: { content: { data: { type: "schedule_skipped" } } } },
    });
    h.listener?.({ notification: { request: { content: { data: { type: "other" } } } } });
    expect(h.pushed).toEqual([`/shopping/${id}`, "/schedules"]);
  });
});
