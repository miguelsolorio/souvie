import { useSupabase } from "@mp/db";
import { useRouter } from "expo-router";
import { useEffect, useState } from "react";
import { Text, View } from "react-native";
import { Button } from "../../src/components/Button";
import { LoadingScreen } from "../../src/components/Screen";
import { HOME_ROUTE } from "../../src/features/auth/routes";
import {
  answerCard,
  type CalibrationState,
  currentCard,
  isFinished,
  progressOf,
  skipRest,
  startCalibration,
  undoAnswer,
} from "../../src/features/onboarding/calibration";
import { saveCalibrationFeedback } from "../../src/features/onboarding/calibrationApi";
import { Note, OnboardingFrame } from "../../src/features/onboarding/components";
import { SwipeCard } from "../../src/features/onboarding/SwipeCard";
import { SuggestError, suggestErrorMessage } from "../../src/features/onboarding/suggestApi";
import { useOnboarding } from "../../src/features/onboarding/useOnboarding";
import { useStepNav } from "../../src/features/onboarding/useStepNav";
import { useCalibrationCards, useSuggestWeek } from "../../src/features/onboarding/useSuggestWeek";

type Phase = "swiping" | "saving" | "drafting" | "draft-failed";

/**
 * Screen 8: twelve recipes to like or skip, then the first week's plan. The swipes are saved as
 * recipe_feedback, onboarding is marked complete, and `suggest` drafts the first week (it also
 * builds the taste profile from the likes). If the draft fails the person is not stuck: their
 * answers are saved, and they can retry or go on to the planner.
 */
export default function CalibrateStep() {
  const client = useSupabase();
  const router = useRouter();
  const { userId, householdId, saveStep } = useOnboarding();
  const { goBack } = useStepNav(8);
  const cards = useCalibrationCards();
  const suggest = useSuggestWeek();

  const [deck, setDeck] = useState<CalibrationState | null>(null);
  const [phase, setPhase] = useState<Phase>("swiping");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (cards.data && deck === null) setDeck(startCalibration(cards.data.cards));
  }, [cards.data, deck]);

  const goHome = () => router.replace(HOME_ROUTE);

  async function draft(): Promise<void> {
    setPhase("drafting");
    setError(null);
    try {
      await suggest.mutateAsync({ mode: "draft" });
      goHome();
    } catch (cause) {
      // Nothing to plan from yet is not a failure of the person's setup. The planner explains it.
      if (cause instanceof SuggestError && cause.code === "no_candidates") {
        goHome();
        return;
      }
      setError(suggestErrorMessage(cause));
      setPhase("draft-failed");
    }
  }

  async function finish(state: CalibrationState) {
    if (!householdId || !userId) return;
    setPhase("saving");
    setError(null);
    try {
      await saveCalibrationFeedback(client, { householdId, userId, answers: state.answers });
      await saveStep({ step: 8 });
    } catch {
      setError("We could not save your answers. Check your connection and try again.");
      setPhase("swiping");
      return;
    }
    if (state.cards.length === 0) {
      goHome();
      return;
    }
    await draft();
  }

  if (cards.isPending || (cards.data && deck === null)) {
    return <LoadingScreen label="Picking recipes for you" />;
  }

  if (cards.isError || !deck) {
    return (
      <OnboardingFrame
        step={8}
        title="Taste check"
        onBack={goBack}
        onContinue={() => void cards.refetch()}
        continueLabel="Try again"
        error={suggestErrorMessage(cards.error)}
        footer={
          <Button
            label="Skip this step"
            variant="ghost"
            onPress={() => void finish(startCalibration([]))}
          />
        }
      >
        <Note>We could not load recipes to show you.</Note>
      </OnboardingFrame>
    );
  }

  // The household has no recipe that fits yet: say so and let the person finish.
  if (deck.cards.length === 0) {
    return (
      <OnboardingFrame
        step={8}
        title="Almost done"
        subtitle="We do not have recipes to show you yet."
        onBack={goBack}
        onContinue={() => void finish(deck)}
        continueLabel="Finish setup"
        busy={phase === "saving"}
        error={error}
      >
        <Note>
          Add a few recipes from the Recipes tab (paste a link, or share one from another app) and
          we will plan your first week from them.
        </Note>
      </OnboardingFrame>
    );
  }

  if (phase === "saving" || phase === "drafting") {
    return (
      <LoadingScreen
        label={phase === "saving" ? "Saving your answers" : "Planning your first week"}
      />
    );
  }

  if (phase === "draft-failed") {
    return (
      <OnboardingFrame
        step={8}
        title="Your answers are saved"
        subtitle="We could not plan your week just now."
        onContinue={() => void draft()}
        continueLabel="Try again"
        error={error}
        footer={<Button testID="go-home" label="Go to my week" variant="ghost" onPress={goHome} />}
      >
        <Note>You can ask for a plan again from the planner at any time.</Note>
      </OnboardingFrame>
    );
  }

  const card = currentCard(deck);
  const { answered, total } = progressOf(deck);
  const finished = isFinished(deck);

  return (
    <OnboardingFrame
      step={8}
      title="What looks good?"
      subtitle="Like the dinners you would cook and pass on the rest. This teaches us your taste."
      onBack={goBack}
      error={error}
      onContinue={finished ? () => void finish(deck) : undefined}
      continueLabel="See my week"
      footer={
        finished ? null : (
          <Button
            testID="skip-the-rest"
            label="Skip the rest"
            variant="ghost"
            onPress={() => setDeck(skipRest(deck))}
          />
        )
      }
    >
      <View className="gap-4">
        <Text
          testID="calibration-progress"
          accessibilityLiveRegion="polite"
          className="text-center text-sm text-neutral-500"
        >
          {answered} of {total}
        </Text>
        {card ? (
          <>
            <SwipeCard
              key={card.recipeId}
              card={card}
              onAnswer={(signal) =>
                setDeck((current) => (current ? answerCard(current, signal) : current))
              }
            />
            <View className="flex-row gap-3 self-center">
              <View className="w-36">
                <Button
                  testID="swipe-dislike"
                  label="Not for me"
                  variant="secondary"
                  onPress={() => setDeck(answerCard(deck, "dislike"))}
                />
              </View>
              <View className="w-36">
                <Button
                  testID="swipe-like"
                  label="Like"
                  onPress={() => setDeck(answerCard(deck, "like"))}
                />
              </View>
            </View>
          </>
        ) : (
          <Note>
            {deck.endedEarly
              ? `You answered ${answered} of ${total}. That is enough to get started.`
              : "That is all of them. Thank you."}
          </Note>
        )}
        {answered > 0 ? (
          <Button
            testID="swipe-undo"
            label="Undo last"
            variant="ghost"
            onPress={() => setDeck(undoAnswer(deck))}
          />
        ) : null}
      </View>
    </OnboardingFrame>
  );
}
