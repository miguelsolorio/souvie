import { acquireListQueue, startListSync, useHousehold, useSession, useSupabase } from "@mp/db";
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
 * signed-in app: it picks up writes the signed-in person left on the device in an earlier session
 * as soon as the household is known, and sends them again when the app comes back to the foreground
 * or the browser reports it is online. (The queue also retries on its own timer, and every Realtime
 * reconnect kicks it.)
 *
 * The queue is the signed-in person's. On sign-out, or when a different person signs in, the effect
 * below ends: the old person's loop and retry timer stop and their operations stay parked on the
 * device under their own key, never sent for anyone else, and replayed when that person signs in
 * again. The new person starts their own queue.
 *
 * There is no network-status library in the app yet, so a dead connection is discovered by a send
 * failing, not by an event. That costs one failed request per retry and nothing else.
 */
export function ListSyncLifecycle() {
  const client = useSupabase();
  const queryClient = useQueryClient();
  const household = useHousehold();
  const { user } = useSession();
  const householdId = household.data?.id;
  const userId = user?.id;

  useEffect(() => {
    if (!householdId || !userId) return;
    const owner = { householdId, userId };
    const stop = startListSync(client, queryClient, owner);
    const kick = () => acquireListQueue(client, queryClient, owner).kick();
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") kick();
    });
    const events = globalThis as unknown as OnlineEvents;
    events.addEventListener?.("online", kick);
    return () => {
      subscription.remove();
      events.removeEventListener?.("online", kick);
      stop();
    };
  }, [client, queryClient, householdId, userId]);

  return null;
}
