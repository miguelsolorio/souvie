import { useSupabase } from "@mp/db";
import { useMutation } from "@tanstack/react-query";
import { forgetPushToken } from "../shopping/pushToken";

/**
 * Signs out this device only. supabase-js defaults to scope "global", which ends the person's
 * session on every device; "local" ends just this one. The session change sends the person to
 * the sign-in screen through SessionGuard. First, while the session can still delete it, this
 * device's push_tokens row goes, so run notifications stop reaching a signed-out phone.
 */
export function useSignOut(options: { onError?: () => void } = {}) {
  const client = useSupabase();
  return useMutation({
    mutationFn: async () => {
      await forgetPushToken((token) => client.from("push_tokens").delete().eq("token", token));
      const { error } = await client.auth.signOut({ scope: "local" });
      if (error) throw error;
    },
    onError: options.onError,
  });
}
