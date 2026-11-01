import type { MpClient } from "@mp/db";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Sign-in on the web and in the desktop app (WS13). The desktop window cannot take an OAuth
// redirect, so the provider opens in the system browser and the way back is souvie://callback.

const h = vi.hoisted(() => ({
  desktop: false,
  os: "web",
  opened: [] as string[],
}));

vi.mock("react-native", () => ({
  Platform: {
    get OS() {
      return h.os;
    },
  },
}));
vi.mock("expo-apple-authentication", () => ({
  AppleAuthenticationScope: { FULL_NAME: 0, EMAIL: 1 },
  isAvailableAsync: vi.fn(async () => false),
  signInAsync: vi.fn(),
}));
vi.mock("expo-crypto", () => ({
  randomUUID: () => "nonce",
  digestStringAsync: vi.fn(async () => "hash"),
  CryptoDigestAlgorithm: { SHA256: "SHA-256" },
}));
vi.mock("expo-linking", () => ({
  createURL: (path: string) => `http://localhost:8081/${path}`,
}));
vi.mock("expo-web-browser", () => ({ openAuthSessionAsync: vi.fn() }));
vi.mock("../../lib/desktop", () => ({
  isDesktopShell: () => h.desktop,
  openInSystemBrowser: async (url: string) => {
    h.opened.push(url);
  },
}));

import { authRedirectUrl, DESKTOP_AUTH_REDIRECT, sendMagicLink, signInWithGoogle } from "./signIn";

function fakeClient(
  url: string | null = "https://abc.supabase.co/auth/v1/authorize?provider=google",
) {
  const signInWithOAuth = vi.fn(async () => ({ data: { url }, error: null }));
  const signInWithOtp = vi.fn(async () => ({ error: null }));
  return {
    client: { auth: { signInWithOAuth, signInWithOtp } } as unknown as MpClient,
    signInWithOAuth,
    signInWithOtp,
  };
}

beforeEach(() => {
  h.desktop = false;
  h.os = "web";
  h.opened.length = 0;
});

describe("authRedirectUrl", () => {
  it("is this site's /callback in a browser", () => {
    expect(authRedirectUrl()).toBe("http://localhost:8081/callback");
  });

  it("is souvie://callback in the desktop app, which the allow list already holds", () => {
    h.desktop = true;
    expect(DESKTOP_AUTH_REDIRECT).toBe("souvie://callback");
    expect(authRedirectUrl()).toBe("souvie://callback");
  });
});

describe("Google sign-in", () => {
  it("in a browser lets supabase-js send the page to Google, and opens nothing itself", async () => {
    const { client, signInWithOAuth } = fakeClient();
    await expect(signInWithGoogle(client)).resolves.toBe("redirecting");
    expect(signInWithOAuth).toHaveBeenCalledWith({
      provider: "google",
      options: { redirectTo: "http://localhost:8081/callback", skipBrowserRedirect: false },
    });
    expect(h.opened).toEqual([]);
  });

  it("in the desktop app opens Google in the system browser and comes back by deep link", async () => {
    h.desktop = true;
    const { client, signInWithOAuth } = fakeClient();
    await expect(signInWithGoogle(client)).resolves.toBe("redirecting");
    expect(signInWithOAuth).toHaveBeenCalledWith({
      provider: "google",
      options: { redirectTo: "souvie://callback", skipBrowserRedirect: true },
    });
    expect(h.opened).toEqual(["https://abc.supabase.co/auth/v1/authorize?provider=google"]);
  });

  it("in the desktop app says so when no sign-in address came back", async () => {
    h.desktop = true;
    const { client } = fakeClient(null);
    await expect(signInWithGoogle(client)).rejects.toThrow(/No sign-in address/);
    expect(h.opened).toEqual([]);
  });
});

describe("magic link", () => {
  it("asks for a link that returns to /callback in a browser", async () => {
    const { client, signInWithOtp } = fakeClient();
    await sendMagicLink(client, " cook@example.test ");
    expect(signInWithOtp).toHaveBeenCalledWith({
      email: "cook@example.test",
      options: { emailRedirectTo: "http://localhost:8081/callback", shouldCreateUser: true },
    });
  });

  it("asks for a link that returns to the desktop app by deep link", async () => {
    h.desktop = true;
    const { client, signInWithOtp } = fakeClient();
    await sendMagicLink(client, "cook@example.test");
    expect(signInWithOtp).toHaveBeenCalledWith({
      email: "cook@example.test",
      options: { emailRedirectTo: "souvie://callback", shouldCreateUser: true },
    });
  });
});
