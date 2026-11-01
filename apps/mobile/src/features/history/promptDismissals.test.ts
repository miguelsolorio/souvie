import { describe, expect, it } from "vitest";
import { createMemoryStorage, type KeyValueStorage } from "../../lib/storage.types";
import { dismissRun, readDismissed } from "./promptDismissals";

describe("promptDismissals", () => {
  it("starts empty and remembers a dismissal once", () => {
    const storage = createMemoryStorage();
    expect(readDismissed(storage)).toEqual([]);
    expect(dismissRun(storage, "run-1")).toEqual(["run-1"]);
    expect(dismissRun(storage, "run-1")).toEqual(["run-1"]);
    expect(dismissRun(storage, "run-2")).toEqual(["run-1", "run-2"]);
    expect(readDismissed(storage)).toEqual(["run-1", "run-2"]);
  });

  it("keeps only the newest fifty", () => {
    const storage = createMemoryStorage();
    for (let i = 0; i < 60; i++) dismissRun(storage, `run-${i}`);
    const kept = readDismissed(storage);
    expect(kept).toHaveLength(50);
    expect(kept[0]).toBe("run-10");
    expect(kept.at(-1)).toBe("run-59");
  });

  it("reads past text that is not a list of ids", () => {
    const storage = createMemoryStorage();
    storage.setItem("mp-order-prompt-dismissed", "not json");
    expect(readDismissed(storage)).toEqual([]);
    storage.setItem("mp-order-prompt-dismissed", '{"a":1}');
    expect(readDismissed(storage)).toEqual([]);
    storage.setItem("mp-order-prompt-dismissed", '["ok", 3, null, "also"]');
    expect(readDismissed(storage)).toEqual(["ok", "also"]);
  });

  it("works with storage that throws, as a private window can", () => {
    const broken: KeyValueStorage = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
      removeItem: () => {
        throw new Error("blocked");
      },
    };
    expect(readDismissed(broken)).toEqual([]);
    expect(() => dismissRun(broken, "run-1")).not.toThrow();
    expect(dismissRun(broken, "run-1")).toEqual(["run-1"]);
  });
});
