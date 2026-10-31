// Renders a screen to markup and lets a test press its buttons. See ./reactNativeStub.tsx.
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { rendered, resetRendered, type StubProps } from "./reactNativeStub";

export interface RenderedScreen {
  html: string;
  /** Every `testID` drawn, in the order it appears on screen. */
  ids: string[];
  /** Whether something with this `testID` is on screen. */
  has: (testID: string) => boolean;
  /** The props the screen gave the element with this `testID`. Throws when it is not on screen. */
  props: (testID: string) => StubProps;
  /** Calls the element's `onPress`, as a tap would. Throws when it is not on screen. */
  press: (testID: string) => void;
}

export function renderScreen(element: ReactElement): RenderedScreen {
  resetRendered();
  const html = renderToStaticMarkup(element);
  const ids = [...html.matchAll(/data-testid="([^"]+)"/g)].map((match) => match[1] ?? "");
  const props = (testID: string): StubProps => {
    const found = rendered.get(testID);
    if (!found)
      throw new Error(`Nothing with testID "${testID}" on screen. Drawn: ${ids.join(", ")}`);
    return found;
  };
  return {
    html,
    ids,
    has: (testID) => rendered.has(testID),
    props,
    press: (testID) => {
      const { onPress } = props(testID);
      if (!onPress) throw new Error(`"${testID}" has no onPress`);
      onPress();
    },
  };
}
