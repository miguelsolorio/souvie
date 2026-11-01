import type { ReactNode } from "react";
import { View } from "react-native";

/**
 * The page's main landmark on the web and in the desktop app (WS13). A browser page whose content
 * is in no landmark fails axe's `region` rule, and a screen reader user has no "skip to main
 * content". It is a plain full-height box with `role="main"`, so layout is unchanged. The phone
 * version, MainLandmark.native.tsx, adds nothing: iOS and Android have no such landmark.
 */
export function MainLandmark({ children }: { children: ReactNode }) {
  return (
    <View role="main" className="flex-1">
      {children}
    </View>
  );
}
