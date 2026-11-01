import { describe, expect, it, vi } from "vitest";
import {
  createPickRecipePhoto,
  fitWithin,
  type PhotoDeps,
  UNREADABLE_PHOTO,
} from "./pickRecipePhoto";
import { JPEG_QUALITY, MAX_WIDTH_PX } from "./pickRecipePhoto.types";

describe("fitWithin", () => {
  it("leaves a photo that is narrow enough alone", () => {
    expect(fitWithin(800, 600, 1600)).toEqual({ width: 800, height: 600 });
    expect(fitWithin(1600, 900, 1600)).toEqual({ width: 1600, height: 900 });
  });

  it("scales a wide photo down to the maximum width and keeps its proportions", () => {
    expect(fitWithin(4000, 3000, 1600)).toEqual({ width: 1600, height: 1200 });
    expect(fitWithin(3024, 4032, 1600)).toEqual({ width: 1600, height: 2133 });
  });

  it("never rounds the height to zero", () => {
    expect(fitWithin(100_000, 10, 1600).height).toBe(1);
  });
});

function deps(overrides: Partial<PhotoDeps> = {}): PhotoDeps {
  const file = new Blob(["raw"], { type: "image/png" });
  return {
    chooseFile: vi.fn(async () => file),
    measure: vi.fn(async () => ({ width: 4000, height: 3000 })),
    encode: vi.fn(async () => new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xd9])])),
    ...overrides,
  };
}

describe("pickRecipePhoto (web)", () => {
  it("returns null when the picker is closed without a file", async () => {
    const d = deps({ chooseFile: vi.fn(async () => null) });
    expect(await createPickRecipePhoto(d)("library")).toBeNull();
    expect(d.measure).not.toHaveBeenCalled();
  });

  it("asks for the camera on a phone's browser only for the camera source", async () => {
    const d = deps();
    await createPickRecipePhoto(d)("camera");
    expect(d.chooseFile).toHaveBeenLastCalledWith(true);
    await createPickRecipePhoto(d)("library");
    expect(d.chooseFile).toHaveBeenLastCalledWith(false);
  });

  it("shrinks to 1600 wide and hands back JPEG bytes", async () => {
    const d = deps();
    const photo = await createPickRecipePhoto(d)("library");
    expect(d.encode).toHaveBeenCalledWith(expect.any(Blob), MAX_WIDTH_PX, 1200, JPEG_QUALITY);
    expect(photo?.contentType).toBe("image/jpeg");
    expect([...new Uint8Array(photo?.bytes ?? new ArrayBuffer(0))]).toEqual([
      0xff, 0xd8, 0xff, 0xd9,
    ]);
  });

  it("keeps a small photo at its own size", async () => {
    const d = deps({ measure: vi.fn(async () => ({ width: 640, height: 480 })) });
    await createPickRecipePhoto(d)("library");
    expect(d.encode).toHaveBeenCalledWith(expect.any(Blob), 640, 480, JPEG_QUALITY);
  });

  it("says so when the file is not an image the browser can read", async () => {
    const unreadable = deps({
      measure: vi.fn(async () => {
        throw new Error("decode failed");
      }),
    });
    await expect(createPickRecipePhoto(unreadable)("library")).rejects.toThrow(UNREADABLE_PHOTO);

    const unencodable = deps({
      encode: vi.fn(async () => {
        throw new Error("encode failed");
      }),
    });
    await expect(createPickRecipePhoto(unencodable)("library")).rejects.toThrow(UNREADABLE_PHOTO);
  });
});
