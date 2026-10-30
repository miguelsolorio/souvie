import type { Session, User } from "@supabase/supabase-js";
import {
  createContext,
  createElement,
  type ReactElement,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import type { MpClient } from "./client";

export type SessionStatus = "loading" | "signed-in" | "signed-out";

export interface SessionState {
  session: Session | null;
  user: User | null;
  /** `loading` until the stored session has been read once. */
  status: SessionStatus;
}

interface DbContextValue {
  client: MpClient;
  sessionState: SessionState;
}

const DbContext = createContext<DbContextValue | null>(null);

function toState(session: Session | null, loaded: boolean): SessionState {
  if (!loaded) return { session: null, user: null, status: "loading" };
  return session
    ? { session, user: session.user, status: "signed-in" }
    : { session: null, user: null, status: "signed-out" };
}

/**
 * Gives the tree the supabase client and the current auth session. Mount it once, near the root,
 * inside the TanStack Query provider. It is the only place that subscribes to auth changes.
 */
export function SupabaseProvider(props: { client: MpClient; children?: ReactNode }): ReactElement {
  const { client, children } = props;
  const [state, setState] = useState<{ session: Session | null; loaded: boolean }>({
    session: null,
    loaded: false,
  });

  useEffect(() => {
    let active = true;
    client.auth
      .getSession()
      .then(({ data }) => {
        if (active)
          setState((prev) => (prev.loaded ? prev : { session: data.session, loaded: true }));
      })
      .catch(() => {
        if (active) setState((prev) => (prev.loaded ? prev : { session: null, loaded: true }));
      });
    const { data } = client.auth.onAuthStateChange((_event, session) => {
      if (active) setState({ session, loaded: true });
    });
    return () => {
      active = false;
      data.subscription.unsubscribe();
    };
  }, [client]);

  const value = useMemo<DbContextValue>(
    () => ({ client, sessionState: toState(state.session, state.loaded) }),
    [client, state],
  );
  return createElement(DbContext.Provider, { value }, children);
}

function useDbContext(): DbContextValue {
  const value = useContext(DbContext);
  if (!value) throw new Error("SupabaseProvider is missing. Mount it at the root of the app.");
  return value;
}

/** The typed supabase client from the nearest SupabaseProvider. */
export function useSupabase(): MpClient {
  return useDbContext().client;
}

/** The session state from the nearest SupabaseProvider. Prefer the `useSession` hook. */
export function useSessionState(): SessionState {
  return useDbContext().sessionState;
}
