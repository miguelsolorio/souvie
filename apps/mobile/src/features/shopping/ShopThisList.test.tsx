// WS15: "Shop this list" sits behind the shopping_agent_enabled kill switch (docs/05 §Incident
// basics). On unless PostHog says off: the button shows, and with the switch off it does not.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderScreen } from "../../testing/renderScreen";

const h = vi.hoisted(() => ({
  flag: true,
  connection: { id: "c1", status: "active", storeName: "QFC Duvall" } as unknown,
  mutate: vi.fn(),
}));

vi.mock("react-native", () => import("../../testing/reactNativeStub"));
vi.mock("expo-router", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@mp/db", () => ({
  useHousehold: () => ({ data: { id: "h1" } }),
  useSession: () => ({ user: { id: "u1" } }),
}));
vi.mock("../retailers/useRetailerConnection", () => ({
  useRetailerConnection: () => ({ connection: h.connection }),
}));
vi.mock("./useShoppingRun", () => ({
  useStartRun: () => ({ mutate: h.mutate, isPending: false, error: null }),
}));
vi.mock("../../observability/useFlag", () => ({ useFlag: () => h.flag }));

import { ShopThisList } from "./ShopThisList";

beforeEach(() => {
  h.flag = true;
  h.connection = { id: "c1", status: "active", storeName: "QFC Duvall" };
  h.mutate.mockReset();
});

describe("ShopThisList and the kill switch", () => {
  it("offers the button when the flag is on, and starts a run on a tap", () => {
    const screen = renderScreen(<ShopThisList listId="l1" />);
    expect(screen.has("shop-this-list")).toBe(true);
    expect(screen.has("shop-paused")).toBe(false);
    screen.press("shop-this-list");
    expect(h.mutate).toHaveBeenCalledWith({ listId: "l1", connectionId: "c1" }, expect.any(Object));
  });

  it("hides the button, and says shopping is paused, when PostHog switches the agent off", () => {
    h.flag = false;
    const screen = renderScreen(<ShopThisList listId="l1" />);
    expect(screen.has("shop-this-list")).toBe(false);
    expect(screen.has("shop-paused")).toBe(true);
    expect(screen.html).toContain("Shopping is paused right now");
  });

  it("still asks for a store first when the flag is on and there is none", () => {
    h.connection = null;
    const screen = renderScreen(<ShopThisList listId="l1" />);
    expect(screen.has("shop-no-store")).toBe(true);
  });
});
