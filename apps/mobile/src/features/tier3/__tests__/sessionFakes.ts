// Test helpers (WS08) for the session tests: an in-memory expo-secure-store, a cookie jar, the real
// AES-GCM over Web Crypto, and the real Supabase key functions on PGlite (the migration itself,
// through supabase/functions/llm-proxy/testing/db.ts), so a test sees the key come from Vault and
// the connection go to revoked.
import { vi } from "vitest";
import {
  createTier3TestDb,
  type Tier3TestDb,
} from "../../../../../../supabase/functions/llm-proxy/testing/db.ts";
import {
  type Cookie,
  type CookieJar,
  type SecureStoreLike,
  type SessionCipher,
  type SessionKeyService,
  webCryptoCipher,
} from "../secureSession";
import { isAllowedCookieDomain } from "../stores";

export const ALICE = "a1111111-1111-4111-8111-111111111111";
export const CAROL = "c3333333-3333-4333-8333-333333333333";
export const HOUSEHOLD = "0a000000-0000-4000-8000-00000000000a";

export function memorySecureStore(available = true) {
  const items = new Map<string, string>();
  const store: SecureStoreLike & { items: Map<string, string> } = {
    items,
    isAvailableAsync: vi.fn(async () => available),
    getItemAsync: vi.fn(async (key: string) => items.get(key) ?? null),
    setItemAsync: vi.fn(async (key: string, value: string) => {
      items.set(key, value);
    }),
    deleteItemAsync: vi.fn(async (key: string) => {
      items.delete(key);
    }),
  };
  return store;
}

export function fakeCookieJar(initial: Cookie[] = []) {
  let cookies = [...initial];
  const jar: CookieJar & { all(): Cookie[]; set(next: Cookie[]): void } = {
    all: () => [...cookies],
    set: (next) => {
      cookies = [...next];
    },
    read: vi.fn(async (domains: readonly string[]) =>
      cookies.filter((c) => isAllowedCookieDomain(c.domain, domains)),
    ),
    write: vi.fn(async (next: readonly Cookie[]) => {
      for (const c of next) {
        cookies = cookies.filter(
          (x) => !(x.name === c.name && x.domain === c.domain && x.path === c.path),
        );
        cookies.push(c);
      }
    }),
    clearDomains: vi.fn(async (domains: readonly string[]) => {
      cookies = cookies.filter((c) => !isAllowedCookieDomain(c.domain, domains));
    }),
    clearAll: vi.fn(async () => {
      cookies = [];
    }),
  };
  return jar;
}

export function nodeCipher(): SessionCipher {
  return webCryptoCipher(globalThis.crypto.subtle, (n) =>
    globalThis.crypto.getRandomValues(new Uint8Array(n)),
  );
}

export interface SeededDb {
  t: Tier3TestDb;
  /** Records consent and connects alice's browser session; returns the connection id. */
  connect(retailer?: "safeway" | "costco"): Promise<string>;
  keysFor(sub: string): SessionKeyService;
  status(connectionId: string): Promise<string>;
  vaultSecretCount(connectionId: string): Promise<number>;
}

export async function seededDb(): Promise<SeededDb> {
  const t = await createTier3TestDb();
  await t.exec(`
    insert into auth.users (id, email) values
      ('${ALICE}', 'alice@example.test'), ('${CAROL}', 'carol@example.test');
    insert into public.households (id, name, created_by) values ('${HOUSEHOLD}', 'Alice House', '${ALICE}');
    insert into public.household_members (household_id, user_id, role) values
      ('${HOUSEHOLD}', '${ALICE}', 'owner'), ('${HOUSEHOLD}', '${CAROL}', 'member');
  `);
  const rpc = async (sub: string, sql: string, params: unknown[]) =>
    t.run({ sub }, async (q) => (await q<{ v: unknown }>(sql, params))[0]?.v);
  return {
    t,
    async connect(retailer = "safeway") {
      await rpc(ALICE, "select public.record_tier3_consent($1, $2, $3) as v", [
        HOUSEHOLD,
        [retailer],
        "2026-10-31",
      ]);
      return String(
        await rpc(ALICE, "select public.connect_browser_session($1, $2) as v", [
          HOUSEHOLD,
          retailer,
        ]),
      );
    },
    keysFor(sub) {
      return {
        fetchKey: async (id) =>
          String(await rpc(sub, "select public.connection_session_key($1) as v", [id])),
        revoke: async (id) => {
          await rpc(sub, "select public.revoke_browser_connection($1) as v", [id]);
        },
      };
    },
    async status(id) {
      const rows = await t.query<{ status: string }>(
        "select status::text as status from public.retailer_connections where id = $1",
        [id],
      );
      return rows[0]?.status ?? "missing";
    },
    async vaultSecretCount(id) {
      const rows = await t.query<{ n: number }>(
        "select count(*)::int as n from vault.secrets where name like $1",
        [`retailer_connection:${id}:%`],
      );
      return rows[0]?.n ?? 0;
    },
  };
}
