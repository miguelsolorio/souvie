// Database access for retailer-oauth (WS07). Service role only, because every write here goes
// through the security definer functions in the ws07_retail migration, and those are granted to
// the service role alone. Every query names its columns (never vault_secret_id) and is scoped by
// an id the handler has already checked against the caller (docs/05-security-privacy.md).

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Rpc } from "../../../packages/retailers/src/kroger/index.ts";

/** A connection as the app may see it. No secret id. */
export interface ConnectionRow {
  id: string;
  household_id: string;
  user_id: string;
  retailer: string;
  auth_type: string;
  status: "active" | "needs_reauth" | "revoked";
  store_id: string | null;
  store_name: string | null;
  modality: "pickup" | "delivery";
  last_verified_at: string | null;
}

export const CONNECTION_COLUMNS =
  "id, household_id, user_id, retailer, auth_type, status, store_id, store_name, modality, last_verified_at";

export interface RetailerStore {
  isMember(householdId: string, userId: string): Promise<boolean>;
  connection(connectionId: string): Promise<ConnectionRow | null>;
  /** retailer_disconnect: deletes the Vault secret and marks the row revoked. */
  disconnect(connectionId: string, actorUserId: string): Promise<void>;
}

export class SupabaseRetailerStore implements RetailerStore {
  constructor(private readonly db: SupabaseClient) {}

  async isMember(householdId: string, userId: string): Promise<boolean> {
    const { data, error } = await this.db
      .from("household_members")
      .select("household_id")
      .eq("household_id", householdId)
      .eq("user_id", userId)
      .limit(1);
    if (error) throw new Error(`membership lookup failed: ${error.message}`);
    return (data ?? []).length > 0;
  }

  async connection(connectionId: string): Promise<ConnectionRow | null> {
    const { data, error } = await this.db
      .from("retailer_connections")
      .select(CONNECTION_COLUMNS)
      .eq("id", connectionId)
      .maybeSingle();
    if (error) throw new Error(`connection lookup failed: ${error.message}`);
    return (data as ConnectionRow | null) ?? null;
  }

  async disconnect(connectionId: string, actorUserId: string): Promise<void> {
    const { error } = await this.db.rpc("retailer_disconnect", {
      p_connection_id: connectionId,
      p_actor_user_id: actorUserId,
    });
    if (error) throw new Error(error.message);
  }
}

/** supabase-js rpc as the retailers package's Rpc. */
export function rpcOf(db: SupabaseClient): Rpc {
  return (fn, args) => db.rpc(fn, args);
}
