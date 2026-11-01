// Tier 3 data for the app (WS08): the household's consent, its browser-session connections, and the
// RPCs that change them. Everything goes through the anon key under RLS or the security-definer
// functions in 20261031110000_ws08_tier3.sql; nothing here can read a Vault secret id.
import type { MpClient } from "@mp/db";
import type { Tier3Consent, Tier3RetailerId } from "@mp/retailers";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CONSENT_VERSION, parseConsent } from "./consent";
import { appSessionVault } from "./secureSession";

/** The slice of the client the consent screen needs, so tests can pass a fake. */
export type RpcClient = Pick<MpClient, "rpc">;

export interface Tier3Connection {
  id: string;
  householdId: string;
  userId: string;
  retailer: Tier3RetailerId;
  status: "active" | "needs_reauth" | "revoked";
  storeName: string | null;
  lastVerifiedAt: string | null;
}

export class Tier3ApiError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "Tier3ApiError";
    this.code = code;
  }
}

const MESSAGES: Record<string, string> = {
  not_a_member: "You are not a member of this household.",
  consent_required: "Agree to the terms for this store first.",
  stale_consent: "The terms for this store changed. Agree to them again first.",
  not_allowed: "Only the person who connected this store can do that.",
  connection_revoked: "This store was disconnected. Connect it again.",
};

function apiError(error: { message: string }): Tier3ApiError {
  const code = Object.keys(MESSAGES).find((k) => error.message.includes(k)) ?? "internal_error";
  return new Tier3ApiError(code, MESSAGES[code] ?? "Something went wrong. Try again.");
}

export function tier3ErrorMessage(error: unknown): string {
  return error instanceof Tier3ApiError || error instanceof Error
    ? error.message
    : "Something went wrong. Try again.";
}

/**
 * record_tier3_consent. At the copy version already stored, the list becomes the union of what was
 * there and `retailers`; at a different version it is replaced by `retailers` alone, because the
 * other retailers were accepted only at the old copy.
 */
export async function recordTier3Consent(
  client: RpcClient,
  householdId: string,
  retailers: readonly Tier3RetailerId[],
  copyVersion: string = CONSENT_VERSION,
): Promise<Tier3Consent> {
  const { data, error } = await client.rpc("record_tier3_consent", {
    household_id: householdId,
    retailers: [...retailers],
    copy_version: copyVersion,
  });
  if (error) throw apiError(error);
  const consent = parseConsent(data);
  if (!consent)
    throw new Tier3ApiError("internal_error", "The server sent an answer we could not read.");
  return consent;
}

/** revoke_browser_connection: deletes the connection's Vault key and marks it revoked. */
export async function revokeBrowserConnection(
  client: RpcClient,
  connectionId: string,
): Promise<void> {
  const { error } = await client.rpc("revoke_browser_connection", { connection_id: connectionId });
  if (error) throw apiError(error);
}

/** connect_browser_session: the member's connection, created or re-activated, with its Vault key. */
export async function connectBrowserSession(
  client: RpcClient,
  householdId: string,
  retailer: Tier3RetailerId,
): Promise<string> {
  const { data, error } = await client.rpc("connect_browser_session", {
    household_id: householdId,
    retailer,
  });
  if (error) throw apiError(error);
  if (typeof data !== "string")
    throw new Tier3ApiError("internal_error", "No connection came back.");
  return data;
}

export const tier3ConsentKey = (householdId: string | undefined) =>
  ["tier3-consent", householdId] as const;
export const tier3ConnectionsKey = (householdId: string | undefined) =>
  ["tier3-connections", householdId] as const;

export function useTier3Consent(client: MpClient, householdId: string | undefined) {
  return useQuery({
    queryKey: tier3ConsentKey(householdId),
    enabled: householdId !== undefined,
    queryFn: async (): Promise<Tier3Consent | null> => {
      if (!householdId) return null;
      const { data, error } = await client
        .from("households")
        .select("tier3_consent")
        .eq("id", householdId)
        .maybeSingle();
      if (error) throw apiError(error);
      return parseConsent(data?.tier3_consent ?? null);
    },
  });
}

const COLUMNS = "id, household_id, user_id, retailer, status, store_name, last_verified_at";

export function useTier3Connections(client: MpClient, householdId: string | undefined) {
  return useQuery({
    queryKey: tier3ConnectionsKey(householdId),
    enabled: householdId !== undefined,
    queryFn: async (): Promise<Tier3Connection[]> => {
      if (!householdId) return [];
      const { data, error } = await client
        .from("retailer_connections")
        .select(COLUMNS)
        .eq("household_id", householdId)
        .eq("auth_type", "browser_session")
        .in("retailer", ["safeway", "costco"])
        .order("created_at", { ascending: true });
      if (error) throw apiError(error);
      return (data ?? []).map((row) => ({
        id: row.id,
        householdId: row.household_id,
        userId: row.user_id,
        retailer: row.retailer as Tier3RetailerId,
        status: row.status,
        storeName: row.store_name,
        lastVerifiedAt: row.last_verified_at,
      }));
    },
  });
}

/**
 * Disconnect a Tier 3 store: clears the WebView cookie store and the secure-store entry on this
 * phone, then deletes the Vault key and marks the connection revoked (secureSession.wipeSession).
 */
export function useDisconnectTier3(householdId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (connectionId: string) => appSessionVault().wipeSession(connectionId),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: tier3ConnectionsKey(householdId) });
      void queryClient.invalidateQueries({ queryKey: ["retailer-connections", householdId] });
    },
  });
}
