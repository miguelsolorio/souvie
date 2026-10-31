// Dev-only snapshot capture tool (WS08). Opens any URL in the Tier 3 WebView host, shows the
// serialized tree, scrubs personal data with a reviewable list of replacements, and hands a
// `*.snapshot.json` to the share sheet so WS10 can commit fixtures. "Run the demo" drives the
// bundled test page through the bridge: navigate, snapshot, click the third tile's Add, type
// "oat milk" into the search box, wait for the slow node, screenshot. Each step's result shows.
//
// Development builds only: release builds leave this file out of the bundle (metro.config.js) and,
// as a second guard, the screen redirects home when __DEV__ is false. Reach it at souvie://snapshot.
import {
  findByRole,
  findByText,
  nearestButton,
  type SnapshotTree,
  type UserRequiredReason,
} from "@mp/retailers";
import { File, Paths } from "expo-file-system";
import { Redirect } from "expo-router";
import { useState } from "react";
import { Image, Platform, Pressable, Share, Text, View } from "react-native";
import { Button } from "../../src/components/Button";
import { Screen, Section } from "../../src/components/Screen";
import { TextField } from "../../src/components/TextField";
import type { BridgeHost } from "../../src/features/tier3/bridgeHost";
import { bytesToBase64 } from "../../src/features/tier3/bytes";
import {
  applyReplacements,
  findPersonalData,
  type Replacement,
  snapshotFileName,
} from "../../src/features/tier3/scrub";
import { WebViewHost } from "../../src/features/tier3/WebViewHost";

// Expo inlines EXPO_PUBLIC_* only when read literally. A public URL replaces the local one later.
const TEST_PAGE_URL = process.env.EXPO_PUBLIC_TIER3_TEST_PAGE_URL || "http://localhost:8790/";

interface Step {
  label: string;
  status: "running" | "ok" | "failed";
  detail: string;
  ms?: number;
}

function outline(tree: SnapshotTree, limit = 400): string {
  const lines: string[] = [];
  const visit = (node: SnapshotTree["root"], depth: number) => {
    if (lines.length >= limit) return;
    const extra = [
      node.text ? `text="${node.text}"` : "",
      node.value !== undefined ? `value="${node.value}"` : "",
    ]
      .filter(Boolean)
      .join(" ");
    lines.push(`${"  ".repeat(depth)}${node.role} "${node.name}" ${extra} [${node.id}]`);
    for (const child of node.children ?? []) visit(child, depth + 1);
  };
  visit(tree.root, 0);
  return lines.join("\n");
}

function SnapshotTool() {
  const [draftUrl, setDraftUrl] = useState(TEST_PAGE_URL);
  const [pageUrl, setPageUrl] = useState(TEST_PAGE_URL);
  const [host, setHost] = useState<BridgeHost | null>(null);
  const [steps, setSteps] = useState<Step[]>([]);
  const [tree, setTree] = useState<SnapshotTree | null>(null);
  const [shot, setShot] = useState<string | null>(null);
  const [reasons, setReasons] = useState<UserRequiredReason[]>([]);
  const [review, setReview] = useState<{ list: Replacement[]; accepted: Set<number> } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function step<T>(label: string, run: () => Promise<T>, describe: (v: T) => string) {
    const started = Date.now();
    setSteps((s) => [...s, { label, status: "running", detail: "" }]);
    try {
      const value = await run();
      const done: Step = { label, status: "ok", detail: describe(value), ms: Date.now() - started };
      setSteps((s) => [...s.slice(0, -1), done]);
      return value;
    } catch (err) {
      const failed: Step = {
        label,
        status: "failed",
        detail: err instanceof Error ? err.message : String(err),
        ms: Date.now() - started,
      };
      setSteps((s) => [...s.slice(0, -1), failed]);
      throw err;
    }
  }

  async function runDemo() {
    if (!host) return;
    setSteps([]);
    setShot(null);
    try {
      await step(
        "navigate",
        () => host.navigate(TEST_PAGE_URL),
        () => TEST_PAGE_URL,
      );
      const first = await step(
        "snapshot",
        () => host.snapshot(),
        (t) => `${t.nodeCount} nodes`,
      );
      setTree(first);
      const tile = findByRole(first, "article")[2];
      const add = tile ? nearestButton(first, tile.id, "Add") : null;
      if (!add) throw new Error("no Add button in the third tile");
      await step(
        "click third tile's Add",
        () => host.click(add.id),
        () => add.id,
      );
      const afterClick = await host.snapshot();
      const cart = findByText(afterClick, /^Cart:/)[0];
      setSteps((s) => [
        ...s,
        { label: "cart", status: "ok", detail: cart?.text ?? cart?.name ?? "?" },
      ]);
      const [box] = findByRole(afterClick, "searchbox");
      if (!box) throw new Error("no search box");
      await step(
        'type "oat milk"',
        () => host.type(box.id, "oat milk", { clear: true }),
        () => box.id,
      );
      await step(
        "waitFor the slow node",
        () =>
          host.waitFor((t) => findByText(t, 'Showing results for "oat milk"').length > 0, 10_000),
        () => 'Showing results for "oat milk"',
      );
      const bytes = await step(
        "screenshot",
        () => host.screenshot(),
        (b) => `${b.length} bytes JPEG`,
      );
      setShot(bytesToBase64(bytes));
      setTree(await host.snapshot());
    } catch {
      // The failed step shows its error.
    }
  }

  async function capture() {
    if (!host) return;
    try {
      const t = await step(
        "snapshot",
        () => host.snapshot(),
        (v) => `${v.nodeCount} nodes`,
      );
      setTree(t);
      const list = findPersonalData(t);
      setReview({ list, accepted: new Set(list.map((r) => r.index)) });
    } catch {
      // shown in the steps list
    }
  }

  async function share() {
    if (!tree || !review) return;
    const clean = applyReplacements(tree, review.list, review.accepted);
    const name = snapshotFileName(clean);
    const json = `${JSON.stringify(clean, null, 2)}\n`;
    try {
      if (Platform.OS === "ios") {
        const file = new File(Paths.cache, name);
        file.create({ overwrite: true });
        file.write(json);
        await Share.share({ url: file.uri });
      } else {
        await Share.share({ title: name, message: json });
      }
      setNotice(`Shared ${name}`);
    } catch (err) {
      setNotice(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <Screen title="Snapshot tool" subtitle="Development only. The Tier 3 host on any page.">
      <Section title="Page">
        <TextField
          label="URL"
          value={draftUrl}
          onChangeText={setDraftUrl}
          autoCapitalize="none"
          testID="snapshot-url"
        />
        <View className="flex-row gap-2">
          <View className="flex-1">
            <Button
              label="Open"
              variant="secondary"
              onPress={() => {
                if (host && draftUrl === pageUrl) void host.navigate(draftUrl).catch(() => {});
                setPageUrl(draftUrl);
              }}
              testID="snapshot-open"
            />
          </View>
          <View className="flex-1">
            <Button label="Run the demo" onPress={() => void runDemo()} testID="snapshot-demo" />
          </View>
        </View>
        <View className="h-[420px] overflow-hidden rounded-xl border border-neutral-200">
          <WebViewHost
            key={pageUrl}
            initialUrl={pageUrl}
            onHost={setHost}
            onUserRequired={(r) => setReasons((all) => [...all, r])}
            testID="snapshot-webview"
          />
        </View>
        {reasons.length ? (
          <Text className="text-sm text-amber-700" testID="snapshot-reasons">
            User required: {reasons.join(", ")}
          </Text>
        ) : null}
      </Section>

      <Section title="Steps">
        {steps.length === 0 ? (
          <Text className="text-sm text-neutral-600">Run the demo or take a snapshot.</Text>
        ) : null}
        {steps.map((s, i) => (
          <Text
            // biome-ignore lint/suspicious/noArrayIndexKey: steps are appended, never reordered.
            key={i}
            testID={`snapshot-step-${i}`}
            className={`font-mono text-xs ${s.status === "failed" ? "text-red-700" : "text-neutral-800"}`}
          >
            {s.status === "ok" ? "ok  " : s.status === "failed" ? "FAIL" : "... "} {s.label}
            {s.ms !== undefined ? ` (${s.ms} ms)` : ""}: {s.detail}
          </Text>
        ))}
        {shot ? (
          <Image
            source={{ uri: `data:image/jpeg;base64,${shot}` }}
            style={{ width: "100%", height: 220 }}
            resizeMode="contain"
            accessibilityLabel="Screenshot taken by the host"
          />
        ) : null}
      </Section>

      <Section title="Fixture">
        <Button label="Snapshot and scrub" variant="secondary" onPress={() => void capture()} />
        {review ? (
          <View className="gap-2">
            <Text className="text-sm text-neutral-700">
              {review.list.length === 0
                ? "Nothing personal found. Check the tree yourself before sharing."
                : "Replacements (tap to keep the original):"}
            </Text>
            {review.list.map((r) => {
              const on = review.accepted.has(r.index);
              return (
                <Pressable
                  key={r.index}
                  accessibilityRole="checkbox"
                  accessibilityState={{ checked: on }}
                  onPress={() =>
                    setReview((cur) => {
                      if (!cur) return cur;
                      const next = new Set(cur.accepted);
                      if (on) next.delete(r.index);
                      else next.add(r.index);
                      return { ...cur, accepted: next };
                    })
                  }
                  className="rounded-lg border border-neutral-200 p-2"
                >
                  <Text className="text-xs text-neutral-500">
                    {on ? "[x]" : "[ ]"} {r.kinds.join(", ")} in {r.field}
                  </Text>
                  <Text className="text-xs text-neutral-900">
                    {r.original} {"->"} {r.replacement || "(empty)"}
                  </Text>
                </Pressable>
              );
            })}
            <Button label="Share .snapshot.json" onPress={() => void share()} />
          </View>
        ) : null}
        {notice ? <Text className="text-sm text-neutral-700">{notice}</Text> : null}
        {tree ? (
          <Text selectable className="font-mono text-[10px] text-neutral-800">
            {outline(tree)}
          </Text>
        ) : null}
      </Section>
    </Screen>
  );
}

export default function SnapshotScreen() {
  if (!__DEV__) return <Redirect href="/" />;
  return <SnapshotTool />;
}
