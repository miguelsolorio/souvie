import { describe, expect, it, vi } from "vitest";
import { RetailerAuthError } from "../errors.ts";
import { clock, QFC_STORE, replay, T0, TEST_CONFIG, to } from "./__fixtures__/replay.ts";
import tokenAuthCode from "./__fixtures__/token-authorization-code.json";
import tokenClientCredentials from "./__fixtures__/token-client-credentials.json";
import tokenInvalidGrant from "./__fixtures__/token-invalid-grant.json";
import tokenRefresh from "./__fixtures__/token-refresh.json";
import {
  bannerForChain,
  CustomerTokenCache,
  completeAuthorization,
  createPkcePair,
  createRpcVault,
  KrogerAuth,
  openState,
  type RefreshTokenVault,
  type SaveConnectionInput,
  STATE_TTL_MS,
  sealState,
} from "./auth.ts";
import { KrogerAdapter } from "./KrogerAdapter.ts";

const HOUSEHOLD = "0a000000-0000-4000-8000-00000000000a";
const USER = "a1111111-1111-4111-8111-111111111111";
const TOKEN_PATH = "/v1/connect/oauth2/token";

function mockVault(stored: string | null = "stored-refresh-token") {
  return {
    saveConnection: vi.fn(async (_input: SaveConnectionInput) => ({
      connectionId: "c0000000-0000-4000-8000-0000000000c1",
    })),
    read: vi.fn(async (_connectionId: string): Promise<string | null> => stored),
    rotate: vi.fn(async (_connectionId: string, _refreshToken: string) => {}),
    markNeedsReauth: vi.fn(async (_connectionId: string) => {}),
  } satisfies RefreshTokenVault;
}

async function sha256Url(value: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
  );
  return btoa(String.fromCharCode(...digest))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

describe("bannerForChain", () => {
  it("brands QFC and Fred Meyer stores and nothing else", () => {
    expect(bannerForChain("QFC")).toBe("qfc");
    expect(bannerForChain("FRED")).toBe("fredmeyer");
    expect(bannerForChain("FRED MEYER STORES")).toBe("fredmeyer");
    expect(bannerForChain("KROGER")).toBeUndefined();
    expect(bannerForChain(null)).toBeUndefined();
  });
});

describe("PKCE", () => {
  it("matches the RFC 7636 appendix B test vector", async () => {
    const octets = new Uint8Array([
      116, 24, 223, 180, 151, 153, 224, 37, 79, 250, 96, 125, 216, 173, 187, 186, 22, 212, 37, 77,
      105, 214, 191, 240, 91, 88, 5, 88, 83, 132, 141, 121,
    ]);
    const pair = await createPkcePair(() => octets);
    expect(pair.verifier).toBe("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk");
    expect(pair.challenge).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });
});

describe("authorize URL", () => {
  it("asks for cart.basic:write with PKCE S256 and the QFC banner for a QFC primary store", async () => {
    const adapter = new KrogerAdapter({ ...TEST_CONFIG, now: () => T0 });
    const { authorizeUrl } = await adapter.connect({
      householdId: HOUSEHOLD,
      userId: USER,
      redirectUri: TEST_CONFIG.redirectUri,
      banner: bannerForChain(QFC_STORE.chain),
    });
    if (!authorizeUrl) throw new Error("no authorize URL");

    expect(authorizeUrl).toContain("scope=cart.basic%3Awrite");
    expect(authorizeUrl).toContain("code_challenge_method=S256");
    expect(authorizeUrl).toContain("banner=qfc");

    const url = new URL(authorizeUrl);
    expect(`${url.origin}${url.pathname}`).toBe(
      "https://api.kroger.com/v1/connect/oauth2/authorize",
    );
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("client_id")).toBe(TEST_CONFIG.clientId);
    expect(url.searchParams.get("redirect_uri")).toBe("souvie://oauth/kroger");
    expect(url.searchParams.get("scope")).toBe("cart.basic:write profile.compact");

    // The verifier rides inside the sealed state, and the challenge is its SHA-256.
    const state = await openState(
      url.searchParams.get("state") ?? "",
      TEST_CONFIG.clientSecret,
      T0,
    );
    expect(state).toMatchObject({ householdId: HOUSEHOLD, userId: USER, banner: "qfc" });
    expect(url.searchParams.get("code_challenge")).toBe(await sha256Url(state.verifier));
    // Nothing secret is in the URL in the clear.
    expect(authorizeUrl).not.toContain(state.verifier);
    expect(authorizeUrl).not.toContain(TEST_CONFIG.clientSecret);
  });

  it("leaves the banner out when the chain is not one we brand", async () => {
    const adapter = new KrogerAdapter({ ...TEST_CONFIG, now: () => T0 });
    const { authorizeUrl } = await adapter.connect({
      householdId: HOUSEHOLD,
      userId: USER,
      redirectUri: TEST_CONFIG.redirectUri,
    });
    expect(new URL(authorizeUrl ?? "").searchParams.has("banner")).toBe(false);
  });
});

describe("sealed state", () => {
  const payload = { householdId: HOUSEHOLD, userId: USER, verifier: "v".repeat(43), now: T0 };

  it("round-trips inside the time limit", async () => {
    const state = await sealState(payload, "secret");
    await expect(openState(state, "secret", T0 + STATE_TTL_MS - 1)).resolves.toMatchObject({
      householdId: HOUSEHOLD,
      userId: USER,
    });
  });

  it("rejects a tampered state, a wrong key, and an expired one", async () => {
    const state = await sealState(payload, "secret");
    const tampered = `${state.slice(0, -2)}${state.endsWith("A") ? "B" : "A"}A`;
    await expect(openState(tampered, "secret", T0)).rejects.toMatchObject({
      reason: "invalid_state",
    });
    await expect(openState(state, "other-secret", T0)).rejects.toMatchObject({
      reason: "invalid_state",
    });
    await expect(openState("garbage", "secret", T0)).rejects.toMatchObject({
      reason: "invalid_state",
    });
    await expect(openState(state, "secret", T0 + STATE_TTL_MS + 1)).rejects.toMatchObject({
      reason: "expired_state",
    });
  });
});

describe("code exchange", () => {
  it("exchanges a recorded code response and stores only the refresh token", async () => {
    const { fetch, requests } = replay([
      { method: "POST", path: TOKEN_PATH, respond: tokenAuthCode },
    ]);
    const auth = new KrogerAuth({ ...TEST_CONFIG, fetch, now: () => T0 });
    const vault = mockVault();
    const tokens = new CustomerTokenCache(auth, vault, () => T0);
    const state = await sealState(
      { householdId: HOUSEHOLD, userId: USER, verifier: "the-verifier", banner: "qfc", now: T0 },
      TEST_CONFIG.clientSecret,
    );

    const done = await completeAuthorization(
      {
        code: "recorded-code",
        state,
        userId: USER,
        redirectUri: TEST_CONFIG.redirectUri,
        storeId: QFC_STORE.id,
        storeName: QFC_STORE.name,
        modality: "PICKUP",
      },
      { auth, vault, stateSecret: TEST_CONFIG.clientSecret, now: () => T0, tokens },
    );

    // One token request: authorization_code with the PKCE verifier and the registered redirect.
    const [req] = to(requests, TOKEN_PATH, "POST");
    expect(requests).toHaveLength(1);
    const form = new URLSearchParams(req?.body ?? "");
    expect(Object.fromEntries(form)).toEqual({
      grant_type: "authorization_code",
      code: "recorded-code",
      redirect_uri: "souvie://oauth/kroger",
      code_verifier: "the-verifier",
    });
    expect(req?.headers.get("authorization")).toBe(
      `Basic ${btoa(`${TEST_CONFIG.clientId}:${TEST_CONFIG.clientSecret}`)}`,
    );

    // The vault saw the refresh token and nothing else secret.
    expect(vault.saveConnection).toHaveBeenCalledTimes(1);
    expect(vault.saveConnection).toHaveBeenCalledWith({
      householdId: HOUSEHOLD,
      userId: USER,
      refreshToken: "fixture-customer-refresh-token-1",
      storeId: QFC_STORE.id,
      storeName: QFC_STORE.name,
      modality: "PICKUP",
    });
    const everythingTheVaultSaw = JSON.stringify([
      vault.saveConnection.mock.calls,
      vault.rotate.mock.calls,
      vault.read.mock.calls,
    ]);
    expect(everythingTheVaultSaw).not.toContain("fixture-customer-access-token-1");
    expect(everythingTheVaultSaw).not.toContain(TEST_CONFIG.clientSecret);

    expect(done.handle).toEqual({
      connectionId: "c0000000-0000-4000-8000-0000000000c1",
      retailer: "kroger",
      storeId: QFC_STORE.id,
      modality: "PICKUP",
    });
    expect(done.householdId).toBe(HOUSEHOLD);
    // The access token stays in memory: the next cart call does not need a refresh.
    await expect(tokens.get(done.handle)).resolves.toBe("fixture-customer-access-token-1");
    expect(vault.read).not.toHaveBeenCalled();
  });

  it("refuses a state sealed for another user without calling Kroger", async () => {
    const { fetch, requests } = replay([
      { method: "POST", path: TOKEN_PATH, respond: tokenAuthCode },
    ]);
    const auth = new KrogerAuth({ ...TEST_CONFIG, fetch });
    const vault = mockVault();
    const state = await sealState(
      { householdId: HOUSEHOLD, userId: "someone-else", verifier: "v", now: T0 },
      TEST_CONFIG.clientSecret,
    );
    await expect(
      completeAuthorization(
        { code: "c", state, userId: USER, redirectUri: TEST_CONFIG.redirectUri },
        { auth, vault, stateSecret: TEST_CONFIG.clientSecret, now: () => T0 },
      ),
    ).rejects.toMatchObject({ reason: "state_mismatch" });
    expect(requests).toHaveLength(0);
    expect(vault.saveConnection).not.toHaveBeenCalled();
  });

  it("maps invalid_grant to a reauth error", async () => {
    const { fetch } = replay([{ method: "POST", path: TOKEN_PATH, respond: tokenInvalidGrant }]);
    const auth = new KrogerAuth({ ...TEST_CONFIG, fetch });
    const err = await auth.exchangeCode("old-code", "v", TEST_CONFIG.redirectUri).catch((e) => e);
    expect(err).toBeInstanceOf(RetailerAuthError);
    expect(err).toMatchObject({ reason: "invalid_grant", needsReauth: true });
  });
});

describe("customer tokens", () => {
  const conn = { connectionId: "conn-1", retailer: "kroger" as const, storeId: null };

  it("refreshes from Vault, rotates the reissued refresh token, and keeps the access token in memory", async () => {
    const c = clock();
    const { fetch, requests } = replay([
      { method: "POST", path: TOKEN_PATH, respond: tokenRefresh },
    ]);
    const auth = new KrogerAuth({ ...TEST_CONFIG, fetch, now: c.now });
    const vault = mockVault();
    const tokens = new CustomerTokenCache(auth, vault, c.now);

    await expect(tokens.get(conn)).resolves.toBe("fixture-customer-access-token-2");
    expect(Object.fromEntries(new URLSearchParams(requests[0]?.body ?? ""))).toEqual({
      grant_type: "refresh_token",
      refresh_token: "stored-refresh-token",
    });
    expect(vault.rotate).toHaveBeenCalledWith("conn-1", "fixture-customer-refresh-token-2");

    // Still valid 20 minutes later: no second refresh.
    c.advance(20 * 60 * 1000);
    await tokens.get(conn);
    expect(requests).toHaveLength(1);
    // Within a minute of the 30-minute expiry: refresh again.
    c.advance(9.5 * 60 * 1000);
    await tokens.get(conn);
    expect(requests).toHaveLength(2);
  });

  it("shares one refresh between concurrent callers", async () => {
    const { fetch, requests } = replay([
      { method: "POST", path: TOKEN_PATH, respond: tokenRefresh },
    ]);
    const auth = new KrogerAuth({ ...TEST_CONFIG, fetch });
    const tokens = new CustomerTokenCache(auth, mockVault());
    await Promise.all([tokens.get(conn), tokens.get(conn), tokens.refresh(conn)]);
    expect(requests).toHaveLength(1);
  });

  it("flips the connection to needs_reauth when Kroger refuses the refresh token", async () => {
    const { fetch } = replay([{ method: "POST", path: TOKEN_PATH, respond: tokenInvalidGrant }]);
    const auth = new KrogerAuth({ ...TEST_CONFIG, fetch });
    const vault = mockVault();
    const tokens = new CustomerTokenCache(auth, vault);
    const err = await tokens.get(conn).catch((e) => e);
    expect(err).toBeInstanceOf(RetailerAuthError);
    expect(err).toMatchObject({ connectionId: "conn-1", needsReauth: true });
    expect(vault.markNeedsReauth).toHaveBeenCalledWith("conn-1");
    expect(vault.rotate).not.toHaveBeenCalled();
  });

  it("fails without a network call when Vault has no token", async () => {
    const { fetch, requests } = replay([]);
    const tokens = new CustomerTokenCache(
      new KrogerAuth({ ...TEST_CONFIG, fetch }),
      mockVault(null),
    );
    await expect(tokens.get(conn)).rejects.toMatchObject({ reason: "missing_token" });
    expect(requests).toHaveLength(0);
  });
});

describe("refresh races between processes", () => {
  const conn = { connectionId: "conn-1", retailer: "kroger" as const, storeId: null };
  const sleep = vi.fn(async (_ms: number) => {});

  /** Kroger as seen by the loser: R1 is already spent, R2 (the winner's) still works. */
  function kroger() {
    return replay([
      {
        method: "POST",
        path: TOKEN_PATH,
        respond: (req) =>
          new URLSearchParams(req.body ?? "").get("refresh_token") === "R1"
            ? tokenInvalidGrant
            : tokenRefresh,
      },
    ]);
  }

  /** A vault whose reads return `reads` in turn, repeating the last. */
  function racingVault(reads: (string | null)[]) {
    let n = 0;
    return {
      saveConnection: vi.fn(async (_input: SaveConnectionInput) => ({ connectionId: "conn-1" })),
      read: vi.fn(async (_id: string) => reads[Math.min(n++, reads.length - 1)] ?? null),
      rotate: vi.fn(async (_id: string, _token: string) => {}),
      markNeedsReauth: vi.fn(async (_id: string) => {}),
    } satisfies RefreshTokenVault;
  }

  it("retries once with the token the winner stored, and does not flag reauth", async () => {
    const { fetch, requests } = kroger();
    const vault = racingVault(["R1", "R2"]);
    const tokens = new CustomerTokenCache(
      new KrogerAuth({ ...TEST_CONFIG, fetch }),
      vault,
      Date.now,
      {
        sleep,
      },
    );
    await expect(tokens.get(conn)).resolves.toBe("fixture-customer-access-token-2");
    expect(requests.map((r) => new URLSearchParams(r.body ?? "").get("refresh_token"))).toEqual([
      "R1",
      "R2",
    ]);
    expect(vault.markNeedsReauth).not.toHaveBeenCalled();
    expect(vault.rotate).toHaveBeenCalledWith("conn-1", "fixture-customer-refresh-token-2");
  });

  it("waits once for a winner whose Vault write has not landed yet", async () => {
    const { fetch } = kroger();
    const vault = racingVault(["R1", "R1", "R2"]);
    const tokens = new CustomerTokenCache(
      new KrogerAuth({ ...TEST_CONFIG, fetch }),
      vault,
      Date.now,
      {
        sleep,
        rereadDelayMs: 250,
      },
    );
    await expect(tokens.get(conn)).resolves.toBe("fixture-customer-access-token-2");
    expect(sleep).toHaveBeenLastCalledWith(250);
    expect(vault.markNeedsReauth).not.toHaveBeenCalled();
  });

  it("flags reauth only when Vault still holds the token Kroger refused", async () => {
    const { fetch, requests } = kroger();
    const vault = racingVault(["R1"]);
    const tokens = new CustomerTokenCache(
      new KrogerAuth({ ...TEST_CONFIG, fetch }),
      vault,
      Date.now,
      {
        sleep,
      },
    );
    await expect(tokens.get(conn)).rejects.toMatchObject({
      reason: "invalid_grant",
      needsReauth: true,
    });
    expect(requests).toHaveLength(1);
    expect(vault.read).toHaveBeenCalledTimes(3);
    expect(vault.markNeedsReauth).toHaveBeenCalledWith("conn-1");
  });

  it("flags reauth when the replacement is refused too, without a third try", async () => {
    const { fetch, requests } = replay([
      { method: "POST", path: TOKEN_PATH, respond: tokenInvalidGrant },
    ]);
    const vault = racingVault(["R1", "R2"]);
    const tokens = new CustomerTokenCache(
      new KrogerAuth({ ...TEST_CONFIG, fetch }),
      vault,
      Date.now,
      {
        sleep,
      },
    );
    await expect(tokens.get(conn)).rejects.toMatchObject({ needsReauth: true });
    expect(requests).toHaveLength(2);
    expect(vault.markNeedsReauth).toHaveBeenCalledTimes(1);
  });
});

describe("app token", () => {
  it("is fetched once and reused until a minute before it expires", async () => {
    const c = clock();
    const { fetch, requests } = replay([
      { method: "POST", path: TOKEN_PATH, respond: tokenClientCredentials },
    ]);
    const auth = new KrogerAuth({ ...TEST_CONFIG, fetch, now: c.now });
    await Promise.all([auth.appToken(), auth.appToken()]);
    c.advance(28 * 60 * 1000);
    await auth.appToken();
    expect(requests).toHaveLength(1);
    expect(new URLSearchParams(requests[0]?.body ?? "").get("scope")).toBe("product.compact");
    expect(new URLSearchParams(requests[0]?.body ?? "").get("grant_type")).toBe(
      "client_credentials",
    );
    c.advance(90 * 1000);
    await auth.appToken();
    expect(requests).toHaveLength(2);
  });
});

describe("createRpcVault", () => {
  it("calls the WS07 SQL functions with only the refresh token", async () => {
    const rpc = vi.fn(async (fn: string) => ({
      data: fn === "retailer_save_oauth_connection" ? "conn-9" : "refresh-xyz",
      error: null,
    }));
    const vault = createRpcVault(rpc);
    await expect(
      vault.saveConnection({
        householdId: HOUSEHOLD,
        userId: USER,
        refreshToken: "refresh-abc",
        modality: "DELIVERY",
      }),
    ).resolves.toEqual({ connectionId: "conn-9" });
    expect(rpc).toHaveBeenLastCalledWith("retailer_save_oauth_connection", {
      p_household_id: HOUSEHOLD,
      p_user_id: USER,
      p_retailer: "kroger",
      p_refresh_token: "refresh-abc",
      p_store_id: null,
      p_store_name: null,
      p_modality: "delivery",
    });
    await expect(vault.read("conn-9")).resolves.toBe("refresh-xyz");
    await vault.rotate("conn-9", "refresh-new");
    expect(rpc).toHaveBeenLastCalledWith("retailer_rotate_refresh_token", {
      p_connection_id: "conn-9",
      p_refresh_token: "refresh-new",
    });
    await vault.markNeedsReauth("conn-9");
    expect(rpc).toHaveBeenLastCalledWith("retailer_mark_needs_reauth", {
      p_connection_id: "conn-9",
    });
  });

  it("surfaces database errors", async () => {
    const vault = createRpcVault(async () => ({ data: null, error: { message: "not_a_member" } }));
    await expect(
      vault.saveConnection({ householdId: HOUSEHOLD, userId: USER, refreshToken: "r" }),
    ).rejects.toThrow("not_a_member");
  });
});
