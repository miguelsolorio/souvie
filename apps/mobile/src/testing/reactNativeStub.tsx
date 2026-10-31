// A stand-in for `react-native` in screen tests (vitest, Node, no device and no DOM).
//
// A test mocks the module with it:
//
//   vi.mock("react-native", () => import("../../testing/reactNativeStub"));
//
// and renders with `renderScreen` (./renderScreen.ts). Every component here draws a plain HTML
// element, so React's server renderer can turn a screen into markup. A component with a `testID`
// also records its props in `rendered`, which is how a test "presses" a button: it calls the
// `onPress` the screen passed in. The server renderer renders once and runs no effects, so this
// covers what a screen shows for given data and what its handlers call, not what happens after a
// state change.
import { createElement, isValidElement, type ReactElement, type ReactNode } from "react";

export interface StubProps {
  children?: ReactNode;
  testID?: string;
  accessibilityLabel?: string;
  accessibilityState?: { selected?: boolean; disabled?: boolean; busy?: boolean };
  disabled?: boolean;
  onPress?: () => void;
  onChangeText?: (text: string) => void;
  value?: string;
  [prop: string]: unknown;
}

/** Props of every element drawn with a `testID` in the last render, keyed by that id. */
export const rendered = new Map<string, StubProps>();

export function resetRendered(): void {
  rendered.clear();
}

function host(tag: string) {
  return function Host(props: StubProps): ReactElement {
    const { children, testID, accessibilityLabel, accessibilityState, value } = props;
    if (testID) rendered.set(testID, props);
    return createElement(
      tag,
      {
        "data-testid": testID,
        "aria-label": accessibilityLabel,
        "aria-selected": accessibilityState?.selected,
        "aria-disabled": props.disabled || accessibilityState?.disabled || undefined,
        ...(tag === "input" ? { defaultValue: value } : {}),
      },
      tag === "input" ? undefined : children,
    );
  };
}

export const View = host("div");
export const ScrollView = host("div");
export const KeyboardAvoidingView = host("div");
export const Text = host("span");
export const Image = host("span");
export const ActivityIndicator = host("span");
export const Pressable = host("button");
export const TextInput = host("input");

/** Draws its children only while visible, like the real one. */
export function Modal({ visible, children }: StubProps): ReactElement | null {
  return visible ? createElement("div", { "data-modal": true }, children) : null;
}

type ListPart = ReactElement | (() => ReactElement | null) | null | undefined;

function part(node: ListPart): ReactNode {
  if (!node) return null;
  return isValidElement(node) ? node : createElement(node);
}

/** Draws the header, then every row (or the empty component), all at once. */
export function FlatList<T>(props: {
  data: readonly T[];
  renderItem: (info: { item: T; index: number }) => ReactElement | null;
  keyExtractor?: (item: T, index: number) => string;
  ListHeaderComponent?: ListPart;
  ListEmptyComponent?: ListPart;
  testID?: string;
}): ReactElement {
  const { data, renderItem, keyExtractor, testID } = props;
  if (testID) rendered.set(testID, props as unknown as StubProps);
  return createElement(
    "div",
    { "data-testid": testID },
    part(props.ListHeaderComponent),
    data.length === 0
      ? part(props.ListEmptyComponent)
      : data.map((item, index) =>
          createElement(
            "div",
            { key: keyExtractor ? keyExtractor(item, index) : index },
            renderItem({ item, index }),
          ),
        ),
  );
}

export const StyleSheet = {
  create: <T extends object>(styles: T): T => styles,
  flatten: (style: unknown) => style,
  absoluteFill: {},
  hairlineWidth: 1,
};

export const Platform = {
  OS: "web" as const,
  select: <T,>(choices: { web?: T; default?: T }): T | undefined => choices.web ?? choices.default,
};

/** A 390 px wide phone, the width the brief's screenshots use. */
export function useWindowDimensions() {
  return { width: 390, height: 844, scale: 1, fontScale: 1 };
}
