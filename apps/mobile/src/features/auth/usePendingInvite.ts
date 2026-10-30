import { useEffect, useState } from "react";
import { getPendingInvite } from "./pendingInvite";

/** Reads the invite token that is waiting for sign-in to finish, once, on mount. */
export function usePendingInvite(): { loading: boolean; token: string | null } {
  const [state, setState] = useState<{ loading: boolean; token: string | null }>({
    loading: true,
    token: null,
  });

  useEffect(() => {
    let active = true;
    getPendingInvite()
      .then((token) => {
        if (active) setState({ loading: false, token });
      })
      .catch(() => {
        if (active) setState({ loading: false, token: null });
      });
    return () => {
      active = false;
    };
  }, []);

  return state;
}
