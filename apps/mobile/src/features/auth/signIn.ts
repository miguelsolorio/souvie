// Sign-in flows. Native Apple uses the system sheet and passes the identity token to Supabase.
// Everything else (Google anywhere, Apple on web and Android) uses the OAuth redirect flow with
// PKCE. Magic links and codes go through signInWithOtp. The callback route and the native
// browser session both finish in completeFromUrl.
import type { MpClient } from "@mp/db";
import * as AppleAuthentication from "expo-apple-authentication";
import * as Crypto from "expo-crypto";
import * as Linking from "expo-linking";
import * as WebBrowser from "expo-web-browser";
import { Platform } from "react-native";
import { AuthCallbackError } from "./authMessages";
import { parseAuthCallback } from "./links";

export type SignInOutcome = "signed-in" | "cancelled" | "redirecting";

/** Where Supabase sends the person after OAuth or a magic link. Must be in the redirect allow list. */
export function authRedirectUrl(): string {
  return Linking.createURL("callback");
}

/** Exchanges the `code` in a redirect URL for a session. */
export async function completeFromUrl(client: MpClient, url: string): Promise<void> {
  const { code, error, errorDescription } = parseAuthCallback(url);
  if (error) {
    throw new AuthCallbackError(errorDescription ?? "Sign-in was not completed.");
  }
  if (!code) {
    throw new AuthCallbackError("This sign-in link is missing its code. Request a new one.");
  }
  const result = await client.auth.exchangeCodeForSession(code);
  if (result.error) throw result.error;
}

async function signInWithOAuth(
  client: MpClient,
  provider: "google" | "apple",
): Promise<SignInOutcome> {
  const redirectTo = authRedirectUrl();
  const isWeb = Platform.OS === "web";
  const { data, error } = await client.auth.signInWithOAuth({
    provider,
    options: { redirectTo, skipBrowserRedirect: !isWeb },
  });
  if (error) throw error;
  // On web supabase-js has already sent the page to the provider.
  if (isWeb) return "redirecting";
  if (!data.url) throw new AuthCallbackError("No sign-in address came back. Try again.");

  const result = await WebBrowser.openAuthSessionAsync(data.url, redirectTo);
  if (result.type !== "success") return "cancelled";
  await completeFromUrl(client, result.url);
  return "signed-in";
}

export function signInWithGoogle(client: MpClient): Promise<SignInOutcome> {
  return signInWithOAuth(client, "google");
}

function isAppleCancellation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ERR_REQUEST_CANCELED"
  );
}

/** Apple sends the person's name only on the first authorization, so keep it when it arrives. */
async function rememberAppleName(
  client: MpClient,
  fullName: AppleAuthentication.AppleAuthenticationFullName | null,
): Promise<void> {
  const name = [fullName?.givenName, fullName?.familyName].filter(Boolean).join(" ").trim();
  if (!name) return;
  const { data } = await client.auth.getUser();
  if (!data.user) return;
  // Only fill an empty name. Never overwrite one the person chose.
  await client
    .from("profiles")
    .update({ display_name: name.slice(0, 80) })
    .eq("user_id", data.user.id)
    .is("display_name", null);
}

export async function signInWithApple(client: MpClient): Promise<SignInOutcome> {
  const useNativeSheet = Platform.OS === "ios" && (await AppleAuthentication.isAvailableAsync());
  if (!useNativeSheet) return signInWithOAuth(client, "apple");

  // Apple receives the SHA-256 of a random nonce; Supabase gets the raw nonce and checks the
  // token against it, so a stolen identity token cannot be replayed.
  const rawNonce = Crypto.randomUUID();
  const hashedNonce = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, rawNonce);

  try {
    const credential = await AppleAuthentication.signInAsync({
      requestedScopes: [
        AppleAuthentication.AppleAuthenticationScope.FULL_NAME,
        AppleAuthentication.AppleAuthenticationScope.EMAIL,
      ],
      nonce: hashedNonce,
    });
    if (!credential.identityToken) {
      throw new AuthCallbackError("Apple did not return an identity token. Try again.");
    }
    const { error } = await client.auth.signInWithIdToken({
      provider: "apple",
      token: credential.identityToken,
      nonce: rawNonce,
    });
    if (error) throw error;
    await rememberAppleName(client, credential.fullName);
    return "signed-in";
  } catch (error) {
    if (isAppleCancellation(error)) return "cancelled";
    throw error;
  }
}

/** Emails a sign-in link and a 6 digit code. Creates the account on first use. */
export async function sendMagicLink(client: MpClient, email: string): Promise<void> {
  const { error } = await client.auth.signInWithOtp({
    email: email.trim(),
    options: { emailRedirectTo: authRedirectUrl(), shouldCreateUser: true },
  });
  if (error) throw error;
}

/** The code from the same email, for when the link opens in the wrong place. */
export async function verifyEmailCode(
  client: MpClient,
  email: string,
  code: string,
): Promise<void> {
  const { error } = await client.auth.verifyOtp({
    email: email.trim(),
    token: code.trim(),
    type: "email",
  });
  if (error) throw error;
}
