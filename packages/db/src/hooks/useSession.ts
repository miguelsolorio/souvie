import { type SessionState, useSessionState } from "../context";

/**
 * The current auth session. `status` is `loading` until the stored session has been read, then
 * `signed-in` or `signed-out`. Gate screens on `status`, not on `session` alone, or a signed-in
 * user sees a flash of the sign-in screen on every launch.
 */
export function useSession(): SessionState {
  return useSessionState();
}
