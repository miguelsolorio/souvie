// This device's push token, and what keeps it from outliving the person who registered it (WS09,
// extended by WS11). Pushes name a household's store and total, so a phone must stop receiving them
// the moment nobody in that household is signed in on it. Three ways a registration can end:
//
//   * the person signs out: useSignOut deletes this device's push_tokens row first, while the
//     session can still do it (RLS needs the signed-in user). If a registration is still in
//     flight, the sign-out waits for it (bounded), so the row it is about to make is the row that
//     gets deleted.
//   * the session ends without the app signing out (the account was signed out elsewhere, the
//     refresh token was revoked): PushLifecycle sees the session go and forgets the token by value
//     with forget_push_token, which needs no session.
//   * everything above fails (offline): the next person to sign in on this phone registers the same
//     token, and register_push_token moves it to them.
//
// No React Native here, so Vitest runs it.

/** Longest a sign-out waits for the delete (and for a registration in flight). Offline, the person still signs out. */
export const FORGET_TIMEOUT_MS = 3_000;

let registered: string | null = null;
let inFlight: Promise<unknown> | null = null;

export function rememberPushToken(token: string | null): void {
  registered = token;
}

/** The token this device registered and has not forgotten, for the code that must clean it up. */
export function currentPushToken(): string | null {
  return registered;
}

/**
 * Marks a registration as in flight until it settles, so a sign-out can wait for it. Pass the
 * whole attempt (permission, token, the call that stores it).
 */
export function trackRegistration<T>(work: Promise<T>): Promise<T> {
  const tracked = work.then(
    () => undefined,
    () => undefined,
  );
  inFlight = tracked;
  void tracked.then(() => {
    if (inFlight === tracked) inFlight = null;
  });
  return work;
}

function within(work: Promise<unknown>, timeoutMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    work.then(
      () => undefined,
      () => undefined,
    ),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/**
 * Removes this device's token with `remove`, then forgets it. Waits for a registration in flight
 * first, so the row it makes is not left behind. Never throws and never waits more than
 * `timeoutMs` in all: a failed delete must not block sign-out.
 */
export async function forgetPushToken(
  remove: (token: string) => PromiseLike<unknown>,
  timeoutMs = FORGET_TIMEOUT_MS,
): Promise<void> {
  const started = Date.now();
  if (inFlight) await within(inFlight, timeoutMs);
  const token = registered;
  if (!token) return;
  registered = null;
  const left = Math.max(0, timeoutMs - (Date.now() - started));
  await within(
    Promise.resolve().then(() => remove(token)),
    left,
  );
}

export interface RegisterDeps {
  /** Asks for permission and returns this device's Expo token, or null when there is none to have. */
  getToken: () => Promise<string | null>;
  /** Stores the token for the signed-in person (register_push_token). Rejects on failure. */
  register: (token: string) => Promise<void>;
  /** Forgets a token by value, with no session (forget_push_token). */
  forgetBySecret: (token: string) => Promise<void>;
  /** True once the person this attempt is for is no longer signed in. */
  isCancelled: () => boolean;
}

/**
 * One registration attempt. The token is remembered before the call that stores it, so a sign-out
 * that starts now deletes it even though the call has not answered. If the session ended while
 * the call was in flight, the row it made is forgotten by value instead of left for the next
 * person to find.
 */
export async function registerDevice(deps: RegisterDeps): Promise<string | null> {
  const token = await deps.getToken();
  // Signed out before there was a token: nothing was stored, so nothing needs cleaning.
  if (!token || deps.isCancelled()) return null;
  rememberPushToken(token);
  try {
    await deps.register(token);
  } catch {
    if (registered === token) registered = null;
    return null;
  }
  if (deps.isCancelled()) {
    if (registered === token) registered = null;
    await deps.forgetBySecret(token).catch(() => undefined);
    return null;
  }
  return token;
}
