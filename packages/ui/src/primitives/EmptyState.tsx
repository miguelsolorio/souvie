import type { ReactNode } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { MIN_TARGET } from "./logic";
import { colors, radius, textStyle } from "./theme";

export interface EmptyStateProps {
  title: string;
  message?: string;
  /** A short glyph or any element shown above the title. Decorative: hidden from screen readers. */
  icon?: ReactNode;
  action?: { label: string; onPress: () => void; testID?: string };
  testID?: string;
}

/** What to show where a list or a grid has nothing in it yet: say why, and offer the next step. */
export function EmptyState({ title, message, icon, action, testID }: EmptyStateProps) {
  return (
    <View testID={testID} style={styles.box}>
      {icon ? (
        <View
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          style={styles.icon}
        >
          {typeof icon === "string" ? <Text style={styles.glyph}>{icon}</Text> : icon}
        </View>
      ) : null}
      <Text accessibilityRole="header" style={styles.title}>
        {title}
      </Text>
      {message ? <Text style={styles.message}>{message}</Text> : null}
      {action ? (
        <Pressable
          testID={action.testID}
          accessibilityRole="button"
          accessibilityLabel={action.label}
          onPress={action.onPress}
          style={({ pressed }) => [styles.action, pressed && styles.actionPressed]}
        >
          <Text style={styles.actionText}>{action.label}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  box: { alignItems: "center", gap: 8, paddingVertical: 32, paddingHorizontal: 24 },
  icon: { marginBottom: 4 },
  glyph: { fontSize: 36, lineHeight: 44 },
  title: { ...textStyle("title"), textAlign: "center", color: colors.text },
  message: { ...textStyle("body"), textAlign: "center", color: colors.textMuted, maxWidth: 360 },
  action: {
    marginTop: 8,
    minHeight: MIN_TARGET,
    justifyContent: "center",
    paddingHorizontal: 20,
    borderRadius: radius.lg,
    backgroundColor: colors.primary,
  },
  actionPressed: { backgroundColor: colors.primaryPressed },
  actionText: { ...textStyle("body"), fontWeight: "600", color: colors.textOnPrimary },
});
