// The planner opens a week from the on-device cache when the phone is offline, and the cached plan
// is keyed by household id. So the id has to be on the device too: this opts the active-household
// query (the one WS01's useHousehold runs) into the persisted cache. Without it a cold start with
// no signal has a plan it cannot name. Only ["household", "active", userId] is persisted; the
// roster and everything else under ["household"] stays off the device.
import { queryClient } from "../../lib/queryClient";

queryClient.setQueryDefaults(["household", "active"], { meta: { persist: true } });
