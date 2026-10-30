// Retailer connection state for the app (WS07).
//
// Query rules for Kroger data (docs/04 §Kroger terms, the WS00 review note): nothing here sets
// `meta: { persist: true }`, so none of it reaches device storage, and Kroger store and product
// queries keep no copy once the screen lets go of them (gcTime 0). Connections are our own rows,
// read under RLS with explicit columns, because vault_secret_id is not granted to clients.
import { useSupabase } from "@mp/db";
import type { Banner, Modality, Store } from "@mp/retailers";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as WebBrowser from "expo-web-browser";
import { Platform } from "react-native";
import {
  disconnectRetailer,
  findKrogerStores,
  RetailerApiError,
  type RetailerConnection,
  startKrogerAuthorization,
} from "./api";
import { completeKrogerRedirect, KROGER_REDIRECT_URI, rememberConnectChoice } from "./oauth";

const CONNECTION_COLUMNS =
  "id, household_id, user_id, retailer, status, store_id, store_name, modality, last_verified_at";

interface ConnectionRow {
  id: string;
  household_id: string;
  user_id: string;
  retailer: string;
  status: RetailerConnection["status"];
  store_id: string | null;
  store_name: string | null;
  modality: RetailerConnection["modality"];
  last_verified_at: string | null;
}

function toConnection(row: ConnectionRow): RetailerConnection {
  return {
    id: row.id,
    householdId: row.household_id,
    userId: row.user_id,
    retailer: row.retailer,
    status: row.status,
    storeId: row.store_id,
    storeName: row.store_name,
    modality: row.modality,
    lastVerifiedAt: row.last_verified_at,
  };
}

export const retailerConnectionsKey = (householdId: string | undefined) =>
  ["retailer-connections", householdId] as const;

/** The household's Kroger connections, newest state from the server. */
export function useRetailerConnections(householdId: string | undefined) {
  const client = useSupabase();
  return useQuery({
    queryKey: retailerConnectionsKey(householdId),
    enabled: householdId !== undefined,
    queryFn: async (): Promise<RetailerConnection[]> => {
      if (!householdId) return [];
      const { data, error } = await client
        .from("retailer_connections")
        .select(CONNECTION_COLUMNS)
        .eq("household_id", householdId)
        .eq("retailer", "kroger")
        .order("created_at", { ascending: true });
      if (error) throw new Error(error.message);
      return ((data ?? []) as ConnectionRow[]).map(toConnection);
    },
  });
}

/**
 * The connection the app acts on for the signed-in member: their own, else the household's
 * first active one. Only the member's own connection can fill a cart from the app.
 */
export function useRetailerConnection(householdId: string | undefined, userId: string | undefined) {
  const connections = useRetailerConnections(householdId);
  const list = connections.data ?? [];
  const own = list.find((c) => c.userId === userId && c.status !== "revoked") ?? null;
  const household = list.find((c) => c.status === "active") ?? null;
  return { ...connections, own, connection: own ?? household, all: list };
}

export type ConnectOutcome = "connected" | "cancelled";

/**
 * Connect Kroger: asks the function for an authorize URL (PKCE and banner are set there), opens
 * it in the system browser, and hands the redirect back to the function for the token exchange.
 */
export function useConnectKroger(householdId: string | undefined) {
  const client = useSupabase();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (args: {
      banner?: Banner | undefined;
      store?: Pick<Store, "id" | "name"> | null;
      modality?: Modality | null;
    }): Promise<ConnectOutcome> => {
      if (!householdId) throw new RetailerApiError("no_household", "Join a household first.");
      if (Platform.OS === "web") {
        throw new RetailerApiError(
          "unsupported",
          "Connect Kroger from the iOS or Android app. The web app cannot receive the sign-in.",
        );
      }
      const authorizeUrl = await startKrogerAuthorization(client, {
        householdId,
        banner: args.banner,
      });
      rememberConnectChoice(args.store ?? null, args.modality ?? null);
      const result = await WebBrowser.openAuthSessionAsync(authorizeUrl, KROGER_REDIRECT_URI);
      if (result.type !== "success") return "cancelled";
      await completeKrogerRedirect(client, result.url);
      return "connected";
    },
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: retailerConnectionsKey(householdId) }),
  });
}

/** Disconnect: the function deletes the Vault secret and marks the connection revoked. */
export function useDisconnectRetailer(householdId: string | undefined) {
  const client = useSupabase();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (connectionId: string) => disconnectRetailer(client, connectionId),
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: retailerConnectionsKey(householdId) }),
  });
}

/** Store and modality are client-editable columns (RLS: the account holder or an owner). */
export function useUpdateConnection(householdId: string | undefined) {
  const client = useSupabase();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (args: {
      connectionId: string;
      store?: Pick<Store, "id" | "name">;
      modality?: RetailerConnection["modality"];
    }) => {
      const patch: { store_id?: string; store_name?: string; modality?: "pickup" | "delivery" } =
        {};
      if (args.store) {
        patch.store_id = args.store.id;
        patch.store_name = args.store.name;
      }
      if (args.modality) patch.modality = args.modality;
      const { data, error } = await client
        .from("retailer_connections")
        .update(patch)
        .eq("id", args.connectionId)
        .select("id");
      if (error) throw new Error(error.message);
      if (!data || data.length === 0) {
        throw new RetailerApiError(
          "not_allowed",
          "Only the account holder or a household owner can change this.",
        );
      }
    },
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: retailerConnectionsKey(householdId) }),
  });
}

/**
 * QFC and Fred Meyer stores near a ZIP. Location data is shown as returned and dropped as soon
 * as no screen uses it.
 */
export function useKrogerStores(zip: string) {
  const client = useSupabase();
  const ready = /^\d{5}$/.test(zip);
  return useQuery({
    queryKey: ["kroger-stores", zip],
    enabled: ready,
    staleTime: 0,
    gcTime: 0,
    retry: false,
    queryFn: () => findKrogerStores(client, zip),
  });
}
