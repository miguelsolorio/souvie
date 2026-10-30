import { describe, expect, it } from "vitest";
import {
  AdapterModality,
  fromAdapterModality,
  Modality,
  RetailerId,
  toAdapterModality,
} from "./retail.ts";

describe("retail enums", () => {
  it("accept the Postgres enum values and reject others", () => {
    expect(RetailerId.parse("kroger")).toBe("kroger");
    expect(RetailerId.safeParse("walmart").success).toBe(false);
    expect(Modality.parse("pickup")).toBe("pickup");
    expect(Modality.safeParse("PICKUP").success).toBe(false);
    expect(AdapterModality.parse("DELIVERY")).toBe("DELIVERY");
    expect(AdapterModality.safeParse("delivery").success).toBe(false);
  });

  it("convert between the stored and the adapter spelling without loss", () => {
    for (const stored of Modality.options) {
      expect(fromAdapterModality(toAdapterModality(stored))).toBe(stored);
    }
    for (const wire of AdapterModality.options) {
      expect(toAdapterModality(fromAdapterModality(wire))).toBe(wire);
    }
  });
});
