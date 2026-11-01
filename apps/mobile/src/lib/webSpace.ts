import { Platform } from "react-native";

/**
 * A single space for the web, null on a phone. Put it between two texts that sit side by side or
 * one above the other inside one control ("Mon" over "Nov 2", a recipe's name over "4 servings"):
 *
 *   <Text>Mon</Text>{WEB_SPACE}<Text>Nov 2</Text>
 *
 * A browser joins the text of side by side boxes with nothing between them, so a tool that
 * checks the control's spoken name against its visible words (WCAG 2.5.3, label in name; axe's
 * `label-content-name-mismatch`) reads "MonNov 2" and "soup4 servings". Between flex children a
 * whitespace-only text node draws nothing and takes no room, so the screen is unchanged. On iOS
 * and Android the value is null and the tree is exactly what it was.
 */
export const WEB_SPACE: string | null = Platform.OS === "web" ? " " : null;
