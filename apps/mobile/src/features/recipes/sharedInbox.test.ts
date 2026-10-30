import { hasEnoughCaptionText, isVideoPlatformUrl } from "@mp/recipe-import/share";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  peekSharedInput,
  setSharedInput,
  subscribeSharedInput,
  takeSharedInput,
  toSharedInput,
} from "./sharedInbox";

afterEach(() => {
  takeSharedInput();
});

describe("toSharedInput", () => {
  it("splits a message into its text and its link", () => {
    expect(
      toSharedInput(
        {
          type: "weburl",
          text: "Check out this reel https://www.instagram.com/reel/abc/?igsh=1",
          webUrl: "https://www.instagram.com/reel/abc/?igsh=1",
        },
        7,
      ),
    ).toEqual({
      text: "Check out this reel",
      url: "https://www.instagram.com/reel/abc/?igsh=1",
      receivedAt: 7,
    });
  });

  it("takes a bare link as a link with no text", () => {
    expect(
      toSharedInput(
        {
          type: "weburl",
          text: "https://vm.tiktok.com/ZM123/",
          webUrl: "https://vm.tiktok.com/ZM123/",
        },
        1,
      ),
    ).toEqual({
      text: "",
      url: "https://vm.tiktok.com/ZM123/",
      receivedAt: 1,
    });
  });

  it("adds the shared page title, which Instagram and TikTok can fill with the caption, once", () => {
    const caption = "Garlic pasta\n8 oz spaghetti\n4 cloves garlic";
    const input = toSharedInput(
      {
        type: "weburl",
        text: "https://www.tiktok.com/@a/video/1",
        webUrl: "https://www.tiktok.com/@a/video/1",
        meta: { title: caption },
      },
      1,
    );
    expect(input?.text).toBe(caption);
    expect(hasEnoughCaptionText(input?.text ?? "")).toBe(true);
    const duplicated = toSharedInput({ type: "text", text: caption, meta: { title: caption } }, 1);
    expect(duplicated?.text).toBe(caption);
  });

  it("takes plain text with no link", () => {
    expect(toSharedInput({ type: "text", text: "2 eggs\n1 cup flour" }, 1)).toEqual({
      text: "2 eggs\n1 cup flour",
      url: null,
      receivedAt: 1,
    });
  });

  it("ignores photos, videos, files, and empty shares", () => {
    expect(toSharedInput({ type: "media", text: null, webUrl: null })).toBeNull();
    expect(toSharedInput({ type: "file" })).toBeNull();
    expect(toSharedInput({ type: "text", text: "   " })).toBeNull();
    expect(toSharedInput({})).toBeNull();
  });

  it("lets the add screen tell a video post from an ordinary page", () => {
    const post = toSharedInput({ type: "weburl", text: "https://www.tiktok.com/@a/video/1" });
    const page = toSharedInput({
      type: "weburl",
      text: "https://www.bbcgoodfood.com/recipes/focaccia",
    });
    expect(isVideoPlatformUrl(post?.url ?? "")).toBe(true);
    expect(isVideoPlatformUrl(page?.url ?? "")).toBe(false);
  });
});

describe("the inbox", () => {
  const input = { text: "2 eggs", url: null, receivedAt: 1 };

  it("holds one item until it is taken", () => {
    expect(peekSharedInput()).toBeNull();
    setSharedInput(input);
    expect(peekSharedInput()).toBe(input);
    expect(peekSharedInput()).toBe(input);
    expect(takeSharedInput()).toBe(input);
    expect(peekSharedInput()).toBeNull();
    expect(takeSharedInput()).toBeNull();
  });

  it("tells subscribers when something arrives and when it is taken, until they unsubscribe", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeSharedInput(listener);
    setSharedInput(input);
    takeSharedInput();
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
    setSharedInput(input);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("replaces an unread item with the newer one", () => {
    setSharedInput(input);
    const newer = { text: "3 eggs", url: null, receivedAt: 2 };
    setSharedInput(newer);
    expect(takeSharedInput()).toBe(newer);
  });
});
