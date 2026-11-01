import { useSupabase } from "@mp/db";
import { useMutation } from "@tanstack/react-query";
import { forgetPushToken } from "../shopping/pushToken";

/**
 * Signs out this device only. supabase-js defaults to scope "global", which ends the person's
 * session on every device; "local" ends just this one. The session change sends the person to
 * the sign-in screen through SessionGuard. First, while the session can still delete it, this
 * device's push_tokens row goes, so run notifications stop reaching a signed-out phone. A
 * registration still in flight is waited for (pushToken.ts), and a delete that fails is retried by
 * token value once the session has ended (forget_push_token needs no session).
 */
export function useSignOut(options: { onError?: () => void } = {}) {
  const client = useSupabase();
  return useMutation({
    mutationFn: async () => {
      const notDeleted: string[] = [];
      await forgetPushToken(async (token) => {
        const { error } = await client.from("push_tokens").delete().eq("token", token);
        if (error) notDeleted.push(token);
      });
      const { error } = await client.auth.signOut({ scope: "local" });
      // Best effort and not waited for: the person is signing out either way.
      for (const token of notDeleted) {
        void Promise.resolve(client.rpc("forget_push_token", { p_token: token })).catch(
          () => undefined,
        );
      }
      if (error) throw error;
    },
    onError: options.onError,
  });
}
