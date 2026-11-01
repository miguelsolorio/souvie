// The Tier 3 consent screen (WS08). Shown once, in the connect flow, before a household first
// connects a store the agent shops by driving the store's own website (docs/04 §Tier 3). The copy
// is consent.ts, approved at checkpoint 4. The continue button stays disabled until the text has
// been scrolled to the end and the acknowledgment is checked. Accepting writes
// households.tier3_consent through record_tier3_consent, never directly.
import type { Tier3Consent } from "@mp/retailers";
import { useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { Button } from "../../components/Button";
import { type RpcClient, recordTier3Consent, tier3ErrorMessage } from "./api";
import { renderConsentCopy } from "./consent";
import type { Tier3Store } from "./stores";

/** How close to the bottom counts as the end, in points. */
export const END_SLOP = 24;

interface ScrollMetrics {
  contentOffset: { y: number };
  contentSize: { height: number };
  layoutMeasurement: { height: number };
}

export function isScrolledToEnd(m: ScrollMetrics): boolean {
  return m.contentOffset.y + m.layoutMeasurement.height >= m.contentSize.height - END_SLOP;
}

export function ConsentScreen({
  store,
  householdId,
  client,
  onAccepted,
  onCancel,
}: {
  store: Tier3Store;
  householdId: string;
  client: RpcClient;
  onAccepted: (consent: Tier3Consent) => void;
  onCancel?: () => void;
}) {
  const copy = renderConsentCopy(store.name);
  const [reachedEnd, setReachedEnd] = useState(false);
  const [checked, setChecked] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [viewport, setViewport] = useState(0);
  const [content, setContent] = useState(0);

  // Copy that fits without scrolling has been seen to the end.
  const fits = viewport > 0 && content > 0 && content <= viewport + 1;
  const seen = reachedEnd || fits;
  const canContinue = seen && checked && !saving;

  async function accept() {
    if (!canContinue) return;
    setSaving(true);
    setError(null);
    try {
      const consent = await recordTier3Consent(client, householdId, [store.retailer]);
      onAccepted(consent);
    } catch (err) {
      setError(tier3ErrorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <View testID="consent-screen" className="flex-1 gap-4">
      <ScrollView
        testID="consent-scroll"
        className="flex-1"
        contentContainerClassName="gap-5 pb-4"
        scrollEventThrottle={16}
        onLayout={(e) => setViewport(e.nativeEvent.layout.height)}
        onContentSizeChange={(_w, h) => setContent(h)}
        onScroll={(e) => {
          if (!reachedEnd && isScrolledToEnd(e.nativeEvent)) setReachedEnd(true);
        }}
      >
        <Text accessibilityRole="header" className="text-2xl font-bold text-neutral-900">
          {copy.title}
        </Text>
        {copy.sections.map((section) => (
          <View key={section.heading} className="gap-1">
            <Text accessibilityRole="header" className="text-base font-semibold text-neutral-900">
              {section.heading}
            </Text>
            <Text className="text-base leading-6 text-neutral-700">{section.body}</Text>
          </View>
        ))}
        <Pressable
          testID="consent-ack"
          accessibilityRole="checkbox"
          accessibilityState={{ checked }}
          aria-checked={checked}
          accessibilityLabel={copy.acknowledgment}
          onPress={() => setChecked((c) => !c)}
          className="flex-row gap-3 rounded-xl border border-neutral-300 p-3"
        >
          <View
            className={`mt-0.5 h-5 w-5 items-center justify-center rounded border ${checked ? "border-brand bg-brand" : "border-neutral-400 bg-white"}`}
          >
            {checked ? <Text className="text-xs font-bold text-white">✓</Text> : null}
          </View>
          <Text className="flex-1 text-sm leading-5 text-neutral-900">{copy.acknowledgment}</Text>
        </Pressable>
      </ScrollView>

      {!seen ? (
        <Text testID="consent-scroll-hint" className="text-sm text-neutral-600">
          Read to the end to continue.
        </Text>
      ) : null}
      {error ? (
        <Text accessibilityRole="alert" className="text-sm text-red-700">
          {error}
        </Text>
      ) : null}
      <Button
        testID="consent-continue"
        label="Agree and continue"
        loading={saving}
        disabled={!canContinue}
        onPress={() => void accept()}
      />
      {onCancel ? (
        <Button testID="consent-cancel" label="Not now" variant="ghost" onPress={onCancel} />
      ) : null}
    </View>
  );
}
