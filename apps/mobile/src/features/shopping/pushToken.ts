// This device's push token, remembered once PushLifecycle registers it, so signing out can remove
// the push_tokens row before the session ends (RLS needs the signed-in user to delete it). Without
// that, the household's run notifications would keep reaching a phone nobody is signed in on.
//
// Sign-out is "this device only" (useSignOut), so only this device's row goes: the person's other
// phones keep their own rows. No React Native here, so Vitest runs it.

/** Longest a sign-out waits for the delete. Offline, the person still signs out. */
export const FORGET_TIMEOUT_MS = 3_000;

let registered: string | null = null;

export function rememberPushToken(token: string | null): void {
  registered = token;
}

/**
 * Deletes this device's row through `remove` (the signed-in client), then forgets the token. Never
 * throws and never waits more than FORGET_TIMEOUT_MS: a failed delete must not block sign-out.
 */
export async function forgetPushToken(
  remove: (token: string) => PromiseLike<unknown>,
  timeoutMs = FORGET_TIMEOUT_MS,
): Promise<void> {
  const token = registered;
  if (!token) return;
  registered = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.resolve(remove(token)),
      new Promise((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
      }),
    ]);
  } catch {
    // The row stays; Expo reports the token as unregistered later and the worker removes it.
  } finally {
    if (timer) clearTimeout(timer);
  }
}
