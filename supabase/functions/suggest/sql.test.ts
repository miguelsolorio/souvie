import { describe, expect, it, vi } from "vitest";
import { type PgClient, runnerOf } from "./sql.ts";

describe("runnerOf", () => {
  it("passes text and a copy of the parameters to the driver and returns its rows", async () => {
    const unsafe = vi.fn(async () => [{ n: 1 }]);
    const pg: PgClient = { unsafe, begin: async () => undefined as never };
    const params = ["a", ["b"]];
    const rows = await runnerOf(pg).query<{ n: number }>("select 1", params);
    expect(rows).toEqual([{ n: 1 }]);
    expect(unsafe).toHaveBeenCalledWith("select 1", ["a", ["b"]]);
    expect(unsafe.mock.calls[0]?.[1]).not.toBe(params);
  });

  it("runs a transaction on the driver's transaction handle", async () => {
    const txUnsafe = vi.fn(async () => [{ id: "plan" }]);
    const tx: PgClient = { unsafe: txUnsafe, begin: async () => undefined as never };
    const outerUnsafe = vi.fn(async () => []);
    const pg: PgClient = {
      unsafe: outerUnsafe,
      begin: async (fn) => fn(tx),
    };
    const result = await runnerOf(pg).transaction(async (inner) => {
      return inner.query<{ id: string }>("insert", []);
    });
    expect(result).toEqual([{ id: "plan" }]);
    expect(txUnsafe).toHaveBeenCalledTimes(1);
    expect(outerUnsafe).not.toHaveBeenCalled();
  });

  it("lets a failure inside a transaction reach the caller", async () => {
    const pg: PgClient = {
      unsafe: async () => [],
      begin: async (fn) => fn({ unsafe: async () => [], begin: async () => undefined as never }),
    };
    await expect(
      runnerOf(pg).transaction(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
  });
});
