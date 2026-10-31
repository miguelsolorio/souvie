import type { ReactNode } from "react";
import {
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from "react-native";
import { MIN_TARGET, sheetLayout } from "./logic";
import { colors, radius, shadow, textStyle } from "./theme";

export interface SheetProps {
  visible: boolean;
  /** Called by the close button, a tap on the backdrop, Escape on the web, and Back on Android. */
  onClose: () => void;
  /** Shown at the top and used as the dialog's name for screen readers. */
  title: string;
  children: ReactNode;
  /** Padding under the content. Pass the safe-area bottom inset so the home bar never covers it. */
  bottomInset?: number;
  testID?: string;
}

/**
 * Content that rises over the screen: a bottom sheet on a phone, a centered dialog on a wide
 * screen. It traps focus the way the platform's modal does, lifts above the keyboard, and scrolls
 * when it is taller than the screen.
 */
export function Sheet({ visible, onClose, title, children, bottomInset = 0, testID }: SheetProps) {
  const { width } = useWindowDimensions();
  const layout = sheetLayout(width);
  const isDialog = layout === "dialog";

  return (
    <Modal
      visible={visible}
      transparent
      animationType={isDialog ? "fade" : "slide"}
      onRequestClose={onClose}
      statusBarTranslucent
    >
      <KeyboardAvoidingView
        style={styles.fill}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <View style={[styles.root, isDialog ? styles.rootDialog : styles.rootSheet]}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Close"
            onPress={onClose}
            style={styles.backdrop}
            testID={testID ? `${testID}-backdrop` : undefined}
          />
          <View
            testID={testID}
            role="dialog"
            aria-modal
            accessibilityLabel={title}
            accessibilityViewIsModal
            style={[styles.panel, isDialog ? styles.panelDialog : styles.panelSheet]}
          >
            {isDialog ? null : <View style={styles.handle} />}
            <View style={styles.header}>
              <Text accessibilityRole="header" style={styles.title} numberOfLines={2}>
                {title}
              </Text>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Close ${title}`}
                onPress={onClose}
                hitSlop={8}
                style={({ pressed }) => [styles.close, pressed && styles.closePressed]}
                testID={testID ? `${testID}-close` : undefined}
              >
                <Text style={styles.closeGlyph}>Done</Text>
              </Pressable>
            </View>
            <ScrollView
              keyboardShouldPersistTaps="handled"
              contentContainerStyle={[styles.content, { paddingBottom: 20 + bottomInset }]}
            >
              {children}
            </ScrollView>
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  root: { flex: 1, backgroundColor: "rgba(26, 24, 20, 0.45)" },
  rootSheet: { justifyContent: "flex-end" },
  rootDialog: { justifyContent: "center", alignItems: "center", padding: 24 },
  backdrop: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0 },
  panel: {
    backgroundColor: colors.surfaceRaised,
    maxHeight: "92%",
    ...shadow("lg"),
  },
  panelSheet: {
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    width: "100%",
    alignSelf: "center",
  },
  panelDialog: { borderRadius: radius.xl, width: "100%", maxWidth: 520 },
  handle: {
    alignSelf: "center",
    width: 40,
    height: 4,
    marginTop: 8,
    borderRadius: radius.full,
    backgroundColor: colors.border,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    paddingHorizontal: 20,
    paddingTop: 12,
    paddingBottom: 4,
  },
  title: { ...textStyle("title"), flex: 1, color: colors.text },
  close: {
    minHeight: MIN_TARGET,
    justifyContent: "center",
    paddingHorizontal: 12,
    borderRadius: radius.md,
  },
  closePressed: { backgroundColor: colors.surfaceSunken },
  closeGlyph: { ...textStyle("body"), fontWeight: "600", color: colors.textLink },
  content: { paddingHorizontal: 20, paddingTop: 8, gap: 16 },
});
