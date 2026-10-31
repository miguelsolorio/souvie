// Test helper (WS08): a "mocked WebView" for the bridge tests. It plays the WebView's part over
// jsdom: loads the bundled test page, injects the bridge before content loads (like
// injectedJavaScriptBeforeContentLoaded) and again on load end, hands page messages to the host
// asynchronously (like the native bridge hop), and records every message in both directions.
/// <reference types="node" />
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";
import { type BridgeHost, type BridgeTransport, createBridgeHost } from "../bridgeHost";

const HERE = dirname(fileURLToPath(import.meta.url));
/** This folder, for tests that read files next to the feature. */
export const HERE_ROOT = HERE;
export const TEST_PAGE_PATH = join(HERE, "..", "test-page", "index.html");
export const TEST_PAGE_HTML = readFileSync(TEST_PAGE_PATH, "utf8");
export const TEST_PAGE_URL = "http://localhost:8790/";
export const TEST_TOKEN = "testtoken0123456789";
export const TEST_RECEIVER = "__mpTier3Bridge_receiver0123456789";
/** What capture() returns: the JPEG start and end markers around a few bytes. */
export const FAKE_JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9]);

export interface PageHarness {
  host: BridgeHost;
  /** The current document's window. */
  window(): JSDOM["window"];
  /** Every message the page posted (parsed JSON), in order. */
  posted: Record<string, unknown>[];
  /** Every script the host evaluated in the page, in order. */
  evaluated: string[];
  loads: string[];
  close(): void;
}

export interface HarnessOptions {
  html?: string;
  allowedHosts?: readonly string[];
  requestTimeoutMs?: number;
  /**
   * How the native channel looks in the page. "android" (default): window.ReactNativeWebView with
   * its own postMessage. "ios": react-native-webview's iOS shape, a window.ReactNativeWebView
   * wrapper that calls window.webkit.messageHandlers.ReactNativeWebView.postMessage at call time
   * (apple/RNCWebViewImpl.m), with the WebKit message handler as the native end.
   */
  platform?: "android" | "ios";
}

export function createPageHarness(options: HarnessOptions = {}): PageHarness {
  const html = options.html ?? TEST_PAGE_HTML;
  let dom: JSDOM | null = null;
  const posted: Record<string, unknown>[] = [];
  const evaluated: string[] = [];
  const loads: string[] = [];
  let host: BridgeHost;

  const transport: BridgeTransport = {
    evaluate(script) {
      evaluated.push(script);
      dom?.window.eval(script);
    },
    load(url) {
      loads.push(url);
      dom?.window.close();
      host.notifyLoadStart(url);
      dom = new JSDOM(html, {
        url,
        runScripts: "dangerously",
        pretendToBeVisual: true,
        beforeParse(window) {
          const native = {
            postMessage(data: string) {
              posted.push(JSON.parse(data) as Record<string, unknown>);
              setTimeout(() => host.receive(data), 0);
            },
          };
          const w = window as unknown as {
            ReactNativeWebView: unknown;
            webkit: unknown;
            eval(code: string): unknown;
          };
          if (options.platform === "ios") {
            w.webkit = { messageHandlers: { ReactNativeWebView: native } };
            // react-native-webview's postMessageScript, in shape.
            w.eval(`
              window.ReactNativeWebView = window.ReactNativeWebView || {};
              window.ReactNativeWebView.postMessage = function (data) {
                window.webkit.messageHandlers.ReactNativeWebView.postMessage(String(data));
              };
            `);
          } else {
            w.ReactNativeWebView = native;
          }
          // injectedJavaScriptBeforeContentLoaded
          window.eval(host.bridgeScript);
        },
      });
      const current = dom;
      current.window.addEventListener("load", () => {
        if (dom === current) host.notifyLoadEnd(url);
      });
    },
    async capture() {
      return FAKE_JPEG;
    },
  };

  host = createBridgeHost(transport, {
    token: TEST_TOKEN,
    receiver: TEST_RECEIVER,
    requestTimeoutMs: options.requestTimeoutMs ?? 5_000,
    ...(options.allowedHosts ? { allowedHosts: options.allowedHosts } : {}),
  });

  return {
    host,
    window: () => {
      if (!dom) throw new Error("no page loaded");
      return dom.window;
    },
    posted,
    evaluated,
    loads,
    close() {
      host.close();
      dom?.window.close();
      dom = null;
    },
  };
}
