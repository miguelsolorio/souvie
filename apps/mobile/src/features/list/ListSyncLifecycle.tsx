import { acquireListQueue, useHousehold, useSupabase } from "@mp/db";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { AppState } from "react-native";
import "./queueStorage";

interface OnlineEvents {
  addEventListener?: (type: string, listener: () => void) => void;
  removeEventListener?: (type: string, listener: () => void) => void;
}

/**
 * Keeps the grocery list's replay queue moving whichever screen is open. Mounted once for the whole
 * signed-in app: it picks up writes an earlier session left on the device as soon as the household
 * is known, and sends them again when the app comes back to the foreground or the browser reports
 * it is online. (The queue also retries on its own timer, and every Realtime reconnect kicks it.)
 *
 * There is no network-status library in the app yet, so a dead connection is discovered by a send
 * failing, not by an event. That costs one failed request per retry and nothing else.
 */
export function ListSyncLifecycle() {
  const client = useSupabase();
  const queryClient = useQueryClient();
  const household = useHousehold();
  const householdId = household.data?.id;

  useEffect(() => {
    if (!householdId) return;
    const queue = acquireListQueue(client, queryClient, householdId);
    const kick = () => queue.kick();
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") kick();
    });
    const events = globalThis as unknown as OnlineEvents;
    events.addEventListener?.("online", kick);
    return () => {
      subscription.remove();
      events.removeEventListener?.("online", kick);
    };
  }, [client, queryClient, householdId]);

  return null;
}
