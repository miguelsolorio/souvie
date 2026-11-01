import { createElement, type ReactElement } from "react";
import { Platform, Text, type TextStyle } from "react-native";

/**
 * No width, no height, out of the flow: it takes no room, and the neighbors do not move. Not
 * `overflow: hidden`: axe reads a zero size box with that as hidden and drops its text from the
 * visible words, which brings back the very mismatch the space is there to fix. A space draws
 * nothing, so there is nothing to clip.
 */
const NO_FOOTPRINT: TextStyle = { position: "absolute", width: 0, height: 0 };

/**
 * A single space for the web, nothing on a phone. Put it between two texts that sit side by side
 * or one above the other inside one control ("Mon" over "Nov 2", a recipe's name over "4
 * servings"):
 *
 *   <Text>Mon</Text><WebSpace /><Text>Nov 2</Text>
 *
 * A browser joins the text of side by side boxes with nothing between them, so a tool that
 * checks the control's spoken name against its visible words (WCAG 2.5.3, label in name; axe's
 * `label-content-name-mismatch`) reads "MonNov 2" and "soup4 servings". The space is a Text
 * because React Native Web rejects a string that is a direct child of a View or a Pressable
 * ("Unexpected text node"). It has no size and is not hidden from assistive technology, so the
 * screen is unchanged and the space still counts toward the name. On iOS and Android it renders
 * null and the tree is exactly what it was.
 */
export function WebSpace(): ReactElement | null {
  if (Platform.OS !== "web") return null;
  return createElement(Text, { style: NO_FOOTPRINT }, " ");
}
