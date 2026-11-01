// The "Did you place this order?" prompt on a run's screen, the confirmation sheet it opens, and
// how the run screen mounts both (WS12). Rendered with react-native stood in and the hooks mocked.
// One render and no effects (see renderScreen.ts), so these cover what is shown for given data and
// what each button calls; the form's checks are in orderForm.test.ts.
import type { RunForOrder } from "@mp/db";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import ShoppingRunScreen from "../../../app/(app)/shopping/[id]";
import { renderScreen } from "../../testing/renderScreen";
import { ConfirmOrderSheet } from "./ConfirmOrderSheet";
import { OrderPrompt } from "./OrderPrompt";

const RUN = "f2000000-0000-4000-8000-0000000000a1";

const h = vi.hoisted(() => ({
  router: { push: vi.fn() },
  run: { data: undefined as unknown, isPending: false, isError: false },
  order: { data: undefined as unknown, isPending: false, isError: false },
  confirm: {
    mutate: vi.fn(),
    reset: vi.fn(),
    isPending: false,
    error: null as unknown,
  },
  params: { id: "f2000000-0000-4000-8000-0000000000a1" },
}));

vi.mock("react-native", () => import("../../testing/reactNativeStub"));
vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));
vi.mock("expo-router", () => ({
  useRouter: () => h.router,
  useLocalSearchParams: () => h.params,
}));
vi.mock("@mp/db", () => ({
  useRunForOrder: () => h.run,
  useRunOrder: () => h.order,
  useConfirmOrder: () => h.confirm,
  orderErrorMessage: (error: unknown) => `words for ${(error as { code?: string }).code}`,
}));
// The run screen's own body is WS09's. Here it only has to draw the slot it was handed.
vi.mock("../shopping/RunDetail", () => ({
  RunDetail: ({ runId, actions }: { runId: string; actions?: ReactNode }) => (
    <section data-run={runId}>{actions}</section>
  ),
}));

const readyRun = (over: Partial<RunForOrder> = {}): RunForOrder => ({
  id: RUN,
  status: "cart_ready",
  retailer: "kroger",
  store_name: "Mock QFC Duvall",
  subtotal_usd: 98,
  approved_at: "2026-11-02T17:00:00+00:00",
  finished_at: "2026-11-02T17:05:00+00:00",
  modality: "pickup",
  ...over,
});

const placed = {
  id: "52000000-0000-4000-8000-0000000000a1",
  total_usd: 100,
  modality: "pickup",
  status: "confirmed",
  slot_start: null,
  slot_end: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  h.run = { data: readyRun(), isPending: false, isError: false };
  h.order = { data: null, isPending: false, isError: false };
  h.confirm.isPending = false;
  h.confirm.error = null;
});

describe("the prompt on a run", () => {
  it("asks 'Did you place this order?' once the cart is ready and nobody confirmed one", () => {
    const screen = renderScreen(<OrderPrompt runId={RUN} />);
    expect(screen.has("order-prompt")).toBe(true);
    expect(screen.html).toContain("Did you place this order?");
    expect(screen.html).toContain("Mock QFC Duvall");
    expect(screen.has("order-prompt-yes")).toBe(true);
    expect(screen.has("order-confirmed")).toBe(false);
  });

  it("asks and never says the order was placed (R19)", () => {
    const { html } = renderScreen(<OrderPrompt runId={RUN} />);
    expect(html).toContain("A ready cart is not an order until you say so.");
    expect(html).not.toMatch(/order (is|was|has been) placed/i);
  });

  it("asks for a run that was checked out too", () => {
    h.run = { data: readyRun({ status: "checked_out" }), isPending: false, isError: false };
    expect(renderScreen(<OrderPrompt runId={RUN} />).has("order-prompt")).toBe(true);
  });

  it("says nothing for a run that is not ready, never approved, or failed", () => {
    for (const status of ["queued", "running", "needs_review", "failed", "cancelled"]) {
      h.run = { data: readyRun({ status }), isPending: false, isError: false };
      expect(renderScreen(<OrderPrompt runId={RUN} />).html, status).toBe("");
    }
    h.run = { data: readyRun({ approved_at: null }), isPending: false, isError: false };
    expect(renderScreen(<OrderPrompt runId={RUN} />).html).toBe("");
  });

  it("says nothing while it does not know, or when the order could not be looked up", () => {
    h.run = { data: undefined, isPending: true, isError: false };
    expect(renderScreen(<OrderPrompt runId={RUN} />).html).toBe("");
    h.run = { data: readyRun(), isPending: false, isError: false };
    h.order = { data: undefined, isPending: true, isError: false };
    expect(renderScreen(<OrderPrompt runId={RUN} />).html).toBe("");
    h.order = { data: undefined, isPending: false, isError: true };
    expect(renderScreen(<OrderPrompt runId={RUN} />).html).toBe("");
    h.run = { data: null, isPending: false, isError: false };
    h.order = { data: null, isPending: false, isError: false };
    expect(renderScreen(<OrderPrompt runId={RUN} />).html).toBe("");
  });

  it("shows the order instead once one is confirmed, and opens it", () => {
    h.order = { data: placed, isPending: false, isError: false };
    const screen = renderScreen(<OrderPrompt runId={RUN} />);
    expect(screen.has("order-prompt")).toBe(false);
    expect(screen.has("order-confirmed")).toBe(true);
    expect(screen.html).toContain("Order confirmed");
    expect(screen.props("order-confirmed-summary").children).toBeDefined();
    expect(screen.html).toContain("$100.00");
    screen.press("order-confirmed-open");
    expect(h.router.push).toHaveBeenCalledWith(`/history/orders/${placed.id}`);
  });

  it("says a cancelled order is cancelled", () => {
    h.order = { data: { ...placed, status: "cancelled" }, isPending: false, isError: false };
    expect(renderScreen(<OrderPrompt runId={RUN} />).html).toContain("Order cancelled");
  });
});

describe("the sheet", () => {
  const sheet = (visible = true, run = readyRun()) =>
    renderScreen(<ConfirmOrderSheet runId={RUN} run={run} visible={visible} onClose={vi.fn()} />);

  it("is closed until opened", () => {
    expect(sheet(false).html).toBe("");
  });

  it("opens with the run's subtotal as the total and its connection's modality", () => {
    const screen = sheet(true, readyRun({ subtotal_usd: 98, modality: "delivery" }));
    expect(screen.has("confirm-order-sheet")).toBe(true);
    expect(screen.props("confirm-total").value).toBe("98.00");
    expect(screen.props("confirm-delivery").accessibilityState?.selected).toBe(true);
    expect(screen.props("confirm-pickup").accessibilityState?.selected).toBe(false);
    expect(screen.html).toContain("Mock QFC Duvall");
  });

  it("starts with an empty total when the run has no subtotal, and no window", () => {
    const screen = sheet(true, readyRun({ subtotal_usd: null, modality: null }));
    expect(screen.props("confirm-total").value).toBe("");
    expect(screen.props("confirm-pickup").accessibilityState?.selected).toBe(true);
    expect(screen.has("confirm-window")).toBe(false);
  });

  it("sends the entered total with the run's modality when 'Yes, I placed it' is tapped", () => {
    sheet().press("confirm-order-submit");
    expect(h.confirm.mutate).toHaveBeenCalledTimes(1);
    expect(h.confirm.mutate.mock.calls[0]?.[0]).toEqual({ total: 98, modality: "pickup" });
  });

  it("sends nothing when the total cannot be read", () => {
    sheet(true, readyRun({ subtotal_usd: null })).press("confirm-order-submit");
    expect(h.confirm.mutate).not.toHaveBeenCalled();
  });

  it("closes without sending anything on 'Not yet'", () => {
    const onClose = vi.fn();
    const screen = renderScreen(
      <ConfirmOrderSheet runId={RUN} run={readyRun()} visible onClose={onClose} />,
    );
    screen.press("confirm-order-cancel");
    expect(onClose).toHaveBeenCalled();
    expect(h.confirm.mutate).not.toHaveBeenCalled();
  });

  it("closes itself when the order was already confirmed, and on success", () => {
    const onClose = vi.fn();
    const screen = renderScreen(
      <ConfirmOrderSheet runId={RUN} run={readyRun()} visible onClose={onClose} />,
    );
    screen.press("confirm-order-submit");
    const options = h.confirm.mutate.mock.calls[0]?.[1] as {
      onSuccess: () => void;
      onError: (error: { code: string }) => void;
    };
    options.onSuccess();
    expect(onClose).toHaveBeenCalledTimes(1);
    options.onError({ code: "run_not_confirmable" });
    expect(onClose).toHaveBeenCalledTimes(1);
    options.onError({ code: "already_confirmed" });
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("shows a refusal in words", () => {
    h.confirm.error = { code: "run_not_confirmable" };
    expect(sheet().html).toContain("words for run_not_confirmable");
  });
});

describe("the run screen", () => {
  it("mounts the prompt through RunDetail's actions slot", () => {
    const screen = renderScreen(<ShoppingRunScreen />);
    expect(screen.html).toContain(`data-run="${RUN}"`);
    expect(screen.has("order-prompt")).toBe(true);
  });

  it("shows nothing extra for a run that is still being shopped", () => {
    h.run = { data: readyRun({ status: "running" }), isPending: false, isError: false };
    const screen = renderScreen(<ShoppingRunScreen />);
    expect(screen.has("order-prompt")).toBe(false);
    expect(screen.has("order-confirmed")).toBe(false);
  });
});
