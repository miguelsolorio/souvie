// The Mode A browser host (WS08): the retailer's own website in a WebView on the person's phone,
// with the bridge injected, as a BrowserHost the adapters drive (packages/retailers browser/host.ts).
//
// Rules this component keeps (docs/04 §Tier 3, R16):
//   * the user agent is the WebView's own; nothing here sets or changes it
//   * nothing hides automation, solves a human check, or fills a password
//   * only http(s) pages load; links that would leave the app (tel:, intent:, app schemes) do not
//   * screenshots are taken here, by the host (react-native-view-shot, JPEG, quality 60)
import type { UserRequiredReason } from "@mp/retailers";
import { getRandomBytes } from "expo-crypto";
import {
  type ComponentRef,
  type ComponentType,
  forwardRef,
  type RefAttributes,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { type StyleProp, View, type ViewStyle } from "react-native";
import {
  WebView,
  type WebViewMessageEvent,
  type WebViewNavigation,
  type WebViewProps,
} from "react-native-webview";
import { type BridgeHost, type BridgeTransport, createBridgeHost } from "./bridgeHost";
import { newBridgeReceiver, newBridgeToken } from "./bridgeScript";
import { base64ToBytes } from "./bytes";

export interface WebViewHostProps {
  /** The first page. Later pages come through host.navigate(). */
  initialUrl: string;
  /** Hosts the page may be on; leaving them raises onUserRequired("unexpected"). */
  allowedHosts?: readonly string[];
  /** Runs before content loads on every document, ahead of the bridge (session storage restore). */
  restoreScript?: string | null;
  onHost?: (host: BridgeHost) => void;
  onUserRequired?: (reason: UserRequiredReason) => void;
  onNavigation?: (url: string) => void;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

interface WebViewHandle {
  injectJavaScript(script: string): void;
}

interface LoadEvent {
  nativeEvent: { url: string };
}

// react-native-webview 14 declares `class WebView<P = undefined> extends Component<WebViewProps & P>`,
// which makes the default props `never` under strict TypeScript. Type the component directly.
const NativeWebView = WebView as unknown as ComponentType<
  WebViewProps & RefAttributes<WebViewHandle>
>;

/** react-native-view-shot, loaded when a screenshot is taken. Its sources do not typecheck here. */
type CaptureRef = (
  view: unknown,
  options: { format: "jpg"; quality: number; result: "base64" },
) => Promise<string>;

const ALLOWED_SCHEMES = /^(https?:|about:blank)/i;

export const WebViewHost = forwardRef<BridgeHost | null, WebViewHostProps>(function WebViewHost(
  { initialUrl, allowedHosts, restoreScript, onHost, onUserRequired, onNavigation, style, testID },
  ref,
) {
  const webRef = useRef<WebViewHandle>(null);
  const viewRef = useRef<ComponentRef<typeof View>>(null);
  const [source, setSource] = useState({ uri: initialUrl });
  const sourceRef = useRef(source.uri);
  const callbacks = useRef({ onUserRequired, onNavigation });
  callbacks.current = { onUserRequired, onNavigation };

  // One host per mounted WebView, with its own token.
  // biome-ignore lint/correctness/useExhaustiveDependencies: allowedHosts is read once, at mount.
  const host = useMemo(() => {
    const transport: BridgeTransport = {
      evaluate: (script) => webRef.current?.injectJavaScript(script),
      load: (url) => {
        // The same source again would not reload; ask the page to go there instead.
        if (url === sourceRef.current) {
          webRef.current?.injectJavaScript(`window.location.assign(${JSON.stringify(url)});true;`);
          return;
        }
        sourceRef.current = url;
        setSource({ uri: url });
      },
      async capture() {
        const { captureRef } = require("react-native-view-shot") as { captureRef: CaptureRef };
        const b64 = await captureRef(viewRef, { format: "jpg", quality: 0.6, result: "base64" });
        return base64ToBytes(b64);
      },
    };
    const token = newBridgeToken(getRandomBytes);
    const created = createBridgeHost(transport, {
      token,
      receiver: newBridgeReceiver(getRandomBytes, token),
      ...(allowedHosts ? { allowedHosts } : {}),
    });
    created.onUserRequired((reason) => callbacks.current.onUserRequired?.(reason));
    return created;
  }, []);

  useImperativeHandle(ref, () => host, [host]);

  useEffect(() => {
    onHost?.(host);
  }, [host, onHost]);

  useEffect(() => () => host.close(), [host]);

  const beforeContent = restoreScript
    ? `${restoreScript}\n${host.bridgeScript}`
    : host.bridgeScript;

  return (
    <View ref={viewRef} collapsable={false} style={[{ flex: 1 }, style]} testID={testID}>
      <NativeWebView
        ref={webRef}
        source={source}
        originWhitelist={["http://*", "https://*", "about:*"]}
        injectedJavaScriptBeforeContentLoaded={beforeContent}
        injectedJavaScriptBeforeContentLoadedForMainFrameOnly
        javaScriptEnabled
        domStorageEnabled
        setSupportMultipleWindows={false}
        javaScriptCanOpenWindowsAutomatically={false}
        allowsBackForwardNavigationGestures
        onMessage={(event: WebViewMessageEvent) => host.receive(event.nativeEvent.data)}
        onLoadStart={(event: LoadEvent) => host.notifyLoadStart(event.nativeEvent.url)}
        onLoadEnd={(event: LoadEvent) => host.notifyLoadEnd(event.nativeEvent.url)}
        onNavigationStateChange={(state: WebViewNavigation) => {
          host.notifyNavigation(state.url);
          callbacks.current.onNavigation?.(state.url);
        }}
        onShouldStartLoadWithRequest={(request: { url: string }) =>
          ALLOWED_SCHEMES.test(request.url)
        }
      />
    </View>
  );
});
