import { useSupabase } from "@mp/db";
import { useState } from "react";
import { Text, View } from "react-native";
import { Button } from "../../components/Button";
import { TextField } from "../../components/TextField";
import { describeAuthError, isPlausibleEmail } from "./authMessages";
import { sendMagicLink, verifyEmailCode } from "./signIn";

/**
 * Email sign-in. The message carries a link and a 6 digit code. Opening the link signs in through
 * the callback route; typing the code signs in right here, which helps when the link opens in a
 * browser that does not hold the sign-in request (PKCE needs the same device and browser).
 */
export function EmailSignIn({ onError }: { onError: (message: string | null) => void }) {
  const client = useSupabase();
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [busy, setBusy] = useState<"send" | "verify" | null>(null);

  async function send() {
    onError(null);
    if (!isPlausibleEmail(email)) {
      onError("Enter a valid email address.");
      return;
    }
    setBusy("send");
    try {
      await sendMagicLink(client, email);
      setSentTo(email.trim());
      setCode("");
    } catch (error) {
      onError(describeAuthError(error));
    } finally {
      setBusy(null);
    }
  }

  async function verify() {
    if (!sentTo) return;
    onError(null);
    setBusy("verify");
    try {
      await verifyEmailCode(client, sentTo, code);
    } catch (error) {
      onError(describeAuthError(error));
    } finally {
      setBusy(null);
    }
  }

  if (sentTo) {
    return (
      <View className="gap-4">
        <View className="gap-1">
          <Text testID="magic-link-sent" className="text-base font-semibold text-neutral-900">
            Check your email
          </Text>
          <Text className="text-base text-neutral-600">
            We sent a sign-in link to {sentTo}. Open it on this device. Or enter the 6 digit code
            from the same email.
          </Text>
        </View>
        <TextField
          label="6 digit code"
          value={code}
          onChangeText={(text) => setCode(text.replace(/\D/g, "").slice(0, 6))}
          keyboardType="number-pad"
          autoComplete="one-time-code"
          textContentType="oneTimeCode"
          maxLength={6}
          testID="email-code"
        />
        <Button
          label="Sign in with code"
          loading={busy === "verify"}
          disabled={code.length !== 6 || busy !== null}
          onPress={() => void verify()}
        />
        <Button
          label="Use a different email"
          variant="ghost"
          disabled={busy !== null}
          onPress={() => {
            onError(null);
            setSentTo(null);
          }}
        />
      </View>
    );
  }

  return (
    <View className="gap-3">
      <TextField
        label="Email"
        value={email}
        onChangeText={setEmail}
        placeholder="you@example.com"
        keyboardType="email-address"
        autoCapitalize="none"
        autoComplete="email"
        autoCorrect={false}
        textContentType="emailAddress"
        returnKeyType="send"
        onSubmitEditing={() => void send()}
        testID="email-input"
      />
      <Button
        testID="send-magic-link"
        label="Email me a sign-in link"
        variant="secondary"
        loading={busy === "send"}
        disabled={busy !== null || email.trim().length === 0}
        onPress={() => void send()}
      />
    </View>
  );
}
