import { ONBOARDING_STEP_COUNT } from "@mp/core";
import { useLocalSearchParams } from "expo-router";
import type { ReactNode } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Button } from "../../components/Button";
import { ErrorText } from "../../components/Screen";
import { isEditParam } from "./onboardingState";
import { noticeFromParam, noticeText } from "./planRecheck";

/**
 * The frame every onboarding screen sits in: a progress line, a back button, a title, the form,
 * and a Continue button. The column is readable on wide (web) screens.
 */
export function OnboardingFrame({
  step,
  title,
  subtitle,
  onBack,
  onContinue,
  continueLabel = "Continue",
  canContinue = true,
  busy = false,
  error,
  footer,
  children,
}: {
  step: number;
  title: string;
  subtitle?: string;
  onBack?: (() => void) | undefined;
  /** Omit on a screen that has its own primary actions (the swipe deck). */
  onContinue?: (() => void) | undefined;
  continueLabel?: string;
  canContinue?: boolean;
  busy?: boolean;
  error?: string | null;
  footer?: ReactNode;
  children: ReactNode;
}) {
  const percent = Math.round((step / ONBOARDING_STEP_COUNT) * 100);
  // Opened from household settings by someone who already finished: no "step n of 8" to count.
  const { edit, notice } = useLocalSearchParams<{ edit?: string; notice?: string }>();
  const editing = isEditParam(edit);
  return (
    <SafeAreaView className="flex-1 bg-white">
      <ScrollView
        keyboardShouldPersistTaps="handled"
        contentContainerClassName="flex-grow px-6 py-6"
      >
        <View className="w-full max-w-md gap-6 self-center">
          <View className="gap-2">
            <View className="flex-row items-center justify-between">
              {onBack ? (
                <Pressable
                  testID="onboarding-back"
                  accessibilityRole="button"
                  accessibilityLabel="Back"
                  onPress={onBack}
                  hitSlop={12}
                >
                  <Text className="text-base font-medium text-brand">Back</Text>
                </Pressable>
              ) : (
                <View />
              )}
              <Text testID="onboarding-progress-label" className="text-sm text-neutral-500">
                {editing ? "Editing food preferences" : `Step ${step} of ${ONBOARDING_STEP_COUNT}`}
              </Text>
            </View>
            {editing ? null : (
              <View
                accessibilityRole="progressbar"
                accessibilityValue={{ min: 0, max: ONBOARDING_STEP_COUNT, now: step }}
                className="h-1.5 overflow-hidden rounded-full bg-neutral-200"
              >
                <View className="h-full rounded-full bg-brand" style={{ width: `${percent}%` }} />
              </View>
            )}
          </View>

          <View className="gap-2">
            <Text accessibilityRole="header" className="text-3xl font-bold text-neutral-900">
              {title}
            </Text>
            {subtitle ? <Text className="text-base text-neutral-600">{subtitle}</Text> : null}
          </View>

          {editing ? <RecheckNoticeLine value={notice} /> : null}

          {children}

          <View className="gap-3 pb-4">
            <ErrorText>{error}</ErrorText>
            {onContinue ? (
              <Button
                testID="onboarding-continue"
                label={continueLabel}
                loading={busy}
                disabled={!canContinue}
                onPress={onContinue}
              />
            ) : null}
            {footer}
          </View>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

/** A pill that toggles. Used for diets, allergens, cuisines, and equipment. */
export function Chip({
  label,
  selected,
  onPress,
  testID,
  tone = "default",
  disabled = false,
}: {
  label: string;
  selected: boolean;
  onPress: () => void;
  testID?: string;
  tone?: "default" | "alert";
  disabled?: boolean;
}) {
  const on = tone === "alert" ? "border-red-600 bg-red-50" : "border-brand bg-brand/10";
  return (
    <Pressable
      testID={testID}
      accessibilityRole="checkbox"
      accessibilityLabel={label}
      accessibilityState={{ checked: selected, disabled }}
      aria-checked={selected}
      disabled={disabled}
      onPress={onPress}
      className={`min-h-11 justify-center rounded-full border px-4 py-2 ${
        selected ? on : "border-neutral-300 bg-white"
      } ${disabled ? "opacity-50" : ""}`}
    >
      <Text
        className={`text-sm ${selected ? "font-semibold text-neutral-900" : "text-neutral-800"}`}
      >
        {label}
      </Text>
    </Pressable>
  );
}

export function ChipGroup({ children }: { children: ReactNode }) {
  return <View className="flex-row flex-wrap gap-2">{children}</View>;
}

/** One choice out of a few, with a line of explanation. */
export function OptionRow({
  label,
  description,
  selected,
  onPress,
  testID,
}: {
  label: string;
  description?: string;
  selected: boolean;
  onPress: () => void;
  testID?: string;
}) {
  return (
    <Pressable
      testID={testID}
      accessibilityRole="radio"
      accessibilityLabel={description ? `${label}. ${description}` : label}
      accessibilityState={{ selected }}
      aria-checked={selected}
      onPress={onPress}
      className={`min-h-12 gap-0.5 rounded-xl border p-3 ${
        selected ? "border-brand bg-brand/5" : "border-neutral-200 bg-white"
      }`}
    >
      <Text className="text-base font-medium text-neutral-900">{label}</Text>
      {description ? <Text className="text-sm text-neutral-600">{description}</Text> : null}
    </Pressable>
  );
}

/** A number with minus and plus buttons. */
export function NumberStepper({
  label,
  value,
  min,
  max,
  step = 1,
  onChange,
  format,
  testID,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (value: number) => void;
  format?: (value: number) => string;
  testID?: string;
}) {
  const clamp = (n: number) => Math.min(Math.max(n, min), max);
  return (
    <View className="flex-row items-center justify-between gap-3 rounded-xl border border-neutral-200 px-4 py-3">
      <Text className="flex-1 text-base text-neutral-900">{label}</Text>
      <View className="flex-row items-center gap-3">
        <Pressable
          testID={testID ? `${testID}-minus` : undefined}
          accessibilityRole="button"
          accessibilityLabel={`Fewer ${label}`}
          accessibilityState={{ disabled: value <= min }}
          disabled={value <= min}
          onPress={() => onChange(clamp(value - step))}
          className={`h-11 w-11 items-center justify-center rounded-full border border-neutral-300 ${
            value <= min ? "opacity-40" : ""
          }`}
        >
          <Text className="text-xl text-neutral-900">-</Text>
        </Pressable>
        <Text
          testID={testID ? `${testID}-value` : undefined}
          accessibilityLiveRegion="polite"
          className="min-w-12 text-center text-lg font-semibold text-neutral-900"
        >
          {format ? format(value) : value}
        </Text>
        <Pressable
          testID={testID ? `${testID}-plus` : undefined}
          accessibilityRole="button"
          accessibilityLabel={`More ${label}`}
          accessibilityState={{ disabled: value >= max }}
          disabled={value >= max}
          onPress={() => onChange(clamp(value + step))}
          className={`h-11 w-11 items-center justify-center rounded-full border border-neutral-300 ${
            value >= max ? "opacity-40" : ""
          }`}
        >
          <Text className="text-xl text-neutral-900">+</Text>
        </Pressable>
      </View>
    </View>
  );
}

export function SectionLabel({ children }: { children: string }) {
  return (
    <Text accessibilityRole="header" className="text-lg font-semibold text-neutral-900">
      {children}
    </Text>
  );
}

/** Small print under a control. */
export function Note({ children }: { children: ReactNode }) {
  return <Text className="text-sm text-neutral-500">{children}</Text>;
}

/**
 * One line telling the person what re-checking their planned weeks did ("Your week was updated."
 * or "Your plan already fits."). `value` is the `notice` query parameter; with none, nothing shows.
 */
export function RecheckNoticeLine({ value }: { value: string | string[] | undefined }) {
  const notice = noticeFromParam(value);
  if (!notice) return null;
  return (
    <Text
      testID="plan-recheck-notice"
      accessibilityLiveRegion="polite"
      className="rounded-xl bg-neutral-100 px-4 py-3 text-sm text-neutral-800"
    >
      {noticeText(notice)}
    </Text>
  );
}
