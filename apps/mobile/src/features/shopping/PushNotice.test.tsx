import { describe, expect, it, vi } from "vitest";
import { renderScreen } from "../../testing/renderScreen";

vi.mock("react-native", () => import("../../testing/reactNativeStub"));
vi.mock("react-native-safe-area-context", async () => {
  const { View } = await import("../../testing/reactNativeStub");
  return { SafeAreaView: View };
});

import { PUSH_UNAVAILABLE_NOTICE, PushNotice } from "./PushNotice";
import { PushNotice as PhonePushNotice } from "./PushNotice.native";

describe("PushNotice", () => {
  it("tells a web visitor that push comes to the phone app", () => {
    const screen = renderScreen(<PushNotice />);
    expect(screen.has("push-unavailable")).toBe(true);
    expect(screen.html).toContain(PUSH_UNAVAILABLE_NOTICE);
    expect(PUSH_UNAVAILABLE_NOTICE).not.toContain("—");
  });

  it("draws nothing on a phone, where push works", () => {
    expect(PhonePushNotice()).toBeNull();
  });
});
