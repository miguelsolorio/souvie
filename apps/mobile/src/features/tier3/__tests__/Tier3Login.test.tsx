// WS08 fix round, item 7: the sign-in WebView knows the retailer's own hosts, so the host raises
// `unexpected` when sign-in wanders off them. The WebView itself is stood in.
import { createElement } from "react";
import { act, create } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";

const webViewProps = vi.hoisted(() => ({ last: null as Record<string, unknown> | null }));

vi.mock("react-native", () => ({
  View: "View",
  Text: "Text",
  Pressable: "Pressable",
  ActivityIndicator: "ActivityIndicator",
  AppState: { addEventListener: () => ({ remove: () => {} }) },
}));

vi.mock("../WebViewHost", () => ({
  WebViewHost: (props: Record<string, unknown>) => {
    webViewProps.last = props;
    return null;
  },
}));

import type { MpClient } from "@mp/db";
import { tier3Store } from "../stores";
import { Tier3Login } from "../Tier3Login";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("Tier3Login", () => {
  it("opens the store's own site with the retailer's hosts as the allowed hosts", async () => {
    for (const [id, hosts] of [
      ["albertsons", ["safeway.com", "albertsons.com", "haggen.com"]],
      ["costco", ["costco.com"]],
    ] as const) {
      await act(async () => {
        create(
          createElement(Tier3Login, {
            store: tier3Store(id),
            householdId: "0a000000-0000-4000-8000-00000000000a",
            client: {} as MpClient,
            onConnected: () => {},
          }),
        );
      });
      expect(webViewProps.last?.initialUrl).toBe(tier3Store(id).homeUrl);
      expect(webViewProps.last?.allowedHosts).toEqual(hosts);
    }
  });
});
