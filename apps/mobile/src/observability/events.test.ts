// The app's event table is the worker's, word for word: the same names, the same property keys,
// the same buckets. A change on one side that is not on the other fails here.
import { describe, expect, it } from "vitest";
import * as worker from "../../../../services/shopper-worker/src/observability/events";
import { EVENT_KEYS, EVENT_NAMES, sanitizeProps, subtotalBucket } from "./events";

describe("the app's event table", () => {
  it("is the worker's table", () => {
    expect([...EVENT_NAMES]).toEqual([...worker.EVENT_NAMES]);
    expect(EVENT_KEYS).toEqual(worker.EVENT_KEYS);
  });

  it("buckets a subtotal the way the worker does", () => {
    for (const usd of [0, 12.5, 49.99, 50, 99.99, 100, 149.99, 150, 199.99, 200, 1000, null]) {
      expect(subtotalBucket(usd)).toBe(worker.subtotalBucket(usd));
    }
  });

  it("drops what is not on an event's list, exactly as the worker does", () => {
    const props = {
      retailer: "kroger",
      review_edits: 2,
      email: "a@b.test",
      product_name: "Whole milk",
      nested: { x: 1 },
      items: Number.NaN,
    };
    expect(sanitizeProps("run_approved", props)).toEqual({ retailer: "kroger", review_edits: 2 });
    expect(sanitizeProps("run_approved", props)).toEqual(
      worker.sanitizeProps("run_approved", props),
    );
  });
});
