import { Text } from "react-native";
import { Section } from "../../components/Screen";

/** What the web and desktop app say about push notifications. Exported for the test. */
export const PUSH_UNAVAILABLE_NOTICE =
  "Push notifications come to the Souvie phone app. Here, open Shopping runs to see when a cart is ready.";

/**
 * A settings notice for the web and desktop app (WS13): they register no push token, so no push
 * reaches them, and the profile screen says so. The phone version, PushNotice.native.tsx, draws
 * nothing, because the phone does get pushes (PushLifecycle.native.tsx).
 */
export function PushNotice() {
  return (
    <Section title="Notifications">
      <Text testID="push-unavailable" className="text-base text-neutral-700">
        {PUSH_UNAVAILABLE_NOTICE}
      </Text>
    </Section>
  );
}
