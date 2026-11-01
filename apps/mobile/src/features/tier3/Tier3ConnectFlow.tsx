// The Tier 3 branch of the connect flow (WS08): consent first when the household needs it, then the
// retailer's own sign-in page. A household that already accepted this retailer at the current copy
// version goes straight to sign-in; a new retailer, or a newer CONSENT_VERSION, shows the screen
// again. The sign-in step is passed in, so this file has no native dependency.
import type { Tier3Consent } from "@mp/retailers";
import { type ReactNode, useState } from "react";
import { View } from "react-native";
import type { RpcClient } from "./api";
import { ConsentScreen } from "./ConsentScreen";
import { CONSENT_VERSION, needsConsent } from "./consent";
import type { Tier3Store } from "./stores";

export type ConnectStep = "consent" | "sign_in";

export function firstConnectStep(
  consent: Tier3Consent | null | undefined,
  store: Tier3Store,
  version: string = CONSENT_VERSION,
): ConnectStep {
  return needsConsent(consent, store.retailer, version) ? "consent" : "sign_in";
}

export function Tier3ConnectFlow({
  store,
  householdId,
  consent,
  client,
  version = CONSENT_VERSION,
  renderSignIn,
  onCancel,
  onConsented,
}: {
  store: Tier3Store;
  householdId: string;
  /** The household's stored consent, already loaded. */
  consent: Tier3Consent | null;
  client: RpcClient;
  version?: string;
  renderSignIn: () => ReactNode;
  onCancel?: () => void;
  onConsented?: (consent: Tier3Consent) => void;
}) {
  const [step, setStep] = useState<ConnectStep>(() => firstConnectStep(consent, store, version));

  if (step === "consent") {
    return (
      <ConsentScreen
        store={store}
        householdId={householdId}
        client={client}
        onAccepted={(next) => {
          onConsented?.(next);
          setStep("sign_in");
        }}
        {...(onCancel ? { onCancel } : {})}
      />
    );
  }
  return (
    <View testID="tier3-sign-in" className="flex-1">
      {renderSignIn()}
    </View>
  );
}
