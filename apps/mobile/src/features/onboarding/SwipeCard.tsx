import { type CalibrationCard, recipeSourceDomain } from "@mp/core";
import { useRef } from "react";
import { Animated, PanResponder, Text, useWindowDimensions, View } from "react-native";
import { RecipeImage } from "../recipes/RecipeImage";
import { type SwipeSignal, signalForDrag } from "./calibration";
import { titleCase } from "./labels";

/**
 * One recipe to like or skip. Drag it right to like and left to skip, or use the buttons under
 * the deck (the buttons are the accessible way, and the only way with a mouse that cannot drag).
 * The card shows the recipe's own title, picture, and source, nothing we wrote.
 */
export function SwipeCard({
  card,
  onAnswer,
}: {
  card: CalibrationCard;
  onAnswer: (signal: SwipeSignal) => void;
}) {
  const { width } = useWindowDimensions();
  const cardWidth = Math.min(360, width - 48);
  const x = useRef(new Animated.Value(0)).current;
  // The responder is made once; it must call the latest handler.
  const latest = useRef(onAnswer);
  latest.current = onAnswer;

  const responder = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_, g) => Math.abs(g.dx) > 8 && Math.abs(g.dx) > Math.abs(g.dy),
      onPanResponderMove: (_, g) => x.setValue(g.dx),
      onPanResponderRelease: (_, g) => {
        const signal = signalForDrag(g.dx);
        if (!signal) {
          Animated.spring(x, { toValue: 0, useNativeDriver: false }).start();
          return;
        }
        Animated.timing(x, {
          toValue: signal === "like" ? 500 : -500,
          duration: 160,
          useNativeDriver: false,
        }).start(() => latest.current(signal));
      },
      onPanResponderTerminate: () => {
        Animated.spring(x, { toValue: 0, useNativeDriver: false }).start();
      },
    }),
  ).current;

  const rotate = x.interpolate({
    inputRange: [-200, 0, 200],
    outputRange: ["-6deg", "0deg", "6deg"],
  });
  const source = recipeSourceDomain(card.sourceUrl);
  const meta = [
    card.cuisine ? titleCase(card.cuisine) : null,
    card.totalMin ? `${card.totalMin} min` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    // NativeWind does not style Animated.View, so the animated layer carries only layout and the
    // transform, and a plain View inside it carries the look.
    <Animated.View
      testID="swipe-card"
      {...responder.panHandlers}
      style={{ width: cardWidth, alignSelf: "center", transform: [{ translateX: x }, { rotate }] }}
    >
      <View className="overflow-hidden rounded-2xl border border-neutral-200 bg-white">
        <RecipeImage
          imageUrl={card.imageUrl}
          title={card.title}
          width={cardWidth - 2}
          height={180}
        />
        <View className="gap-1.5 p-4">
          <Text accessibilityRole="header" className="text-xl font-semibold text-neutral-900">
            {card.title}
          </Text>
          {meta ? <Text className="text-sm text-neutral-600">{meta}</Text> : null}
          {card.description ? (
            <Text numberOfLines={3} className="text-sm text-neutral-700">
              {card.description}
            </Text>
          ) : null}
          {card.tags.length > 0 ? (
            <Text className="text-xs text-neutral-500">{card.tags.join(", ")}</Text>
          ) : null}
          {source ? <Text className="text-xs text-neutral-500">From {source}</Text> : null}
        </View>
      </View>
    </Animated.View>
  );
}
