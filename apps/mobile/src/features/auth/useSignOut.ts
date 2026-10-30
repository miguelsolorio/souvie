import { useSupabase } from "@mp/db";
import { useMutation } from "@tanstack/react-query";

/**
 * Signs out this device only. supabase-js defaults to scope "global", which ends the person's
 * session on every device; "local" ends just this one. The session change sends the person to
 * the sign-in screen through SessionGuard.
 */
export function useSignOut(options: { onError?: () => void } = {}) {
  const client = useSupabase();
  return useMutation({
    mutationFn: async () => {
      const { error } = await client.auth.signOut({ scope: "local" });
      if (error) throw error;
    },
    onError: options.onError,
  });
}
