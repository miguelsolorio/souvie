import type { ReactNode } from "react";
import { ActivityIndicator, ScrollView, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

/** A scrolling, safe-area screen with a readable column on wide (web) viewports. */
export function Screen({
  title,
  subtitle,
  children,
}: {
  title?: string;
  subtitle?: string;
  children: ReactNode;
}) {
  return (
    <SafeAreaView className="flex-1 bg-white">
      <ScrollView
        keyboardShouldPersistTaps="handled"
        contentContainerClassName="flex-grow px-6 py-8"
      >
        <View className="w-full max-w-md gap-6 self-center">
          {title ? (
            <View className="gap-2">
              <Text accessibilityRole="header" className="text-3xl font-bold text-neutral-900">
                {title}
              </Text>
              {subtitle ? <Text className="text-base text-neutral-600">{subtitle}</Text> : null}
            </View>
          ) : null}
          {children}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

export function LoadingScreen({ label }: { label?: string }) {
  return (
    <View className="flex-1 items-center justify-center gap-3 bg-white">
      <ActivityIndicator color="#2F6B4F" />
      {label ? <Text className="text-sm text-neutral-500">{label}</Text> : null}
    </View>
  );
}

/** A section heading plus its content, used by the settings screens. */
export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <View className="gap-3">
      <Text accessibilityRole="header" className="text-lg font-semibold text-neutral-900">
        {title}
      </Text>
      {children}
    </View>
  );
}

export function ErrorText({ children }: { children?: string | null }) {
  if (!children) return null;
  return (
    <Text accessibilityRole="alert" className="text-sm text-red-700">
      {children}
    </Text>
  );
}
