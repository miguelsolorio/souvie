import { afterEach, describe, expect, it, vi } from "vitest";
import { Heartbeat } from "./heartbeat.ts";
import { recorder } from "./testing/fixtures.ts";

afterEach(() => {
  vi.useRealTimers();
});

describe("heartbeat timing", () => {
  it("beats at least every WORKER_HEARTBEAT_SECONDS while it holds a run", async () => {
    vi.useFakeTimers();
    const beats: number[] = [];
    const heartbeat = new Heartbeat({
      store: {
        heartbeat: async (ids) => {
          beats.push(Date.now());
          return ids.length;
        },
        sweepStale: async () => [],
      },
      queue: { setVisibility: async () => {} },
      log: recorder(),
      intervalSeconds: 10,
    });
    heartbeat.hold("run-1", "msg-1");
    heartbeat.start();
    await vi.advanceTimersByTimeAsync(35_000);
    heartbeat.stop();
    expect(beats).toHaveLength(3);
    const gaps = beats.slice(1).map((t, i) => t - (beats[i] ?? 0));
    expect(gaps.every((gap) => gap <= 10_000)).toBe(true);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(beats).toHaveLength(3);
  });
});
