// The sign-in step of the Tier 3 connect flow (WS08). The retailer's own website opens in the
// WebView and the person signs in there, typing their own password into the retailer's own field.
// We never read it. Once the page reads as signed in, "Finish connecting" creates the
// browser_session connection, saves the session encrypted on this phone, and clears the plaintext
// copy from the WebView.
import type { MpClient } from "@mp/db";
import type { SnapshotTree, UserRequiredReason } from "@mp/retailers";
import { useCallback, useEffect, useRef, useState } from "react";
import { Text, View } from "react-native";
import { Button } from "../../components/Button";
import { connectBrowserSession, tier3ErrorMessage } from "./api";
import type { BridgeHost } from "./bridgeHost";
import type { Tier3Store } from "./stores";
import { appTier3SessionDeps, createTier3Session, looksSignedIn } from "./useTier3Session";
import { WebViewHost } from "./WebViewHost";

const REASON_TEXT: Record<UserRequiredReason, string> = {
  login: "Sign in on the store's page.",
  captcha: "The store wants to check you are a person. Finish the check on the page.",
  mfa: "Enter the code the store sent you.",
  unexpected: "This page is not on the store's own site.",
};

export function Tier3Login({
  store,
  householdId,
  client,
  onConnected,
  onCancel,
  signedInCheck = looksSignedIn,
}: {
  store: Tier3Store;
  householdId: string;
  client: MpClient;
  onConnected: (connectionId: string) => void;
  onCancel?: () => void;
  /** WS10 site recipes can pass a sharper check than the generic one. */
  signedInCheck?: (tree: SnapshotTree, url: string) => boolean;
}) {
  const [host, setHost] = useState<BridgeHost | null>(null);
  const [signedIn, setSignedIn] = useState(false);
  const [reason, setReason] = useState<UserRequiredReason | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const checking = useRef(false);

  const check = useCallback(async () => {
    if (!host || checking.current || !host.isReady()) return;
    checking.current = true;
    try {
      const tree = await host.snapshot({ maxNodes: 800 });
      setSignedIn(signedInCheck(tree, tree.url));
    } catch {
      // The page is between documents; the next tick tries again.
    } finally {
      checking.current = false;
    }
  }, [host, signedInCheck]);

  useEffect(() => {
    const timer = setInterval(() => void check(), 2000);
    return () => clearInterval(timer);
  }, [check]);

  async function finish() {
    if (!host) return;
    setBusy(true);
    setError(null);
    try {
      const connectionId = await connectBrowserSession(client, householdId, store.retailer);
      const session = createTier3Session(
        { connectionId, retailer: store.retailer },
        appTier3SessionDeps(),
      );
      await session.signedIn(host);
      // The session now lives encrypted on the phone; nothing of it stays in the WebView.
      await session.save(host, { clear: true });
      onConnected(connectionId);
    } catch (err) {
      setError(tier3ErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <View className="flex-1 gap-3" testID="tier3-login">
      <Text className="text-sm text-neutral-700">
        {reason ? REASON_TEXT[reason] : `Sign in to ${store.name} on their page below.`} Souvie
        never sees your password.
      </Text>
      <View className="h-[480px] overflow-hidden rounded-xl border border-neutral-200">
        <WebViewHost
          initialUrl={store.homeUrl}
          onHost={setHost}
          onUserRequired={setReason}
          onNavigation={() => void check()}
        />
      </View>
      {error ? (
        <Text accessibilityRole="alert" className="text-sm text-red-700">
          {error}
        </Text>
      ) : null}
      <Button
        testID="tier3-finish"
        label={signedIn ? "Finish connecting" : "Waiting for you to sign in"}
        loading={busy}
        disabled={!signedIn}
        onPress={() => void finish()}
      />
      {onCancel ? <Button label="Cancel" variant="ghost" onPress={onCancel} /> : null}
    </View>
  );
}
