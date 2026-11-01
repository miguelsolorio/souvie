import { describe, expect, it } from "vitest";
import * as web from "./shareCapability";
import * as native from "./shareCapability.native";

// Both files must keep R11: a video is never downloaded, whichever platform says so.
describe("shareCapability", () => {
  it("both platforms refuse to download videos", () => {
    expect(web.VIDEO_LINK_ADVICE).toMatch(/^We do not download videos/);
    expect(native.VIDEO_LINK_ADVICE).toMatch(/^We do not download videos/);
  });

  it("the web build points at pasting and never at a share sheet that does not exist", () => {
    expect(web.LINK_TAB_HINT).toMatch(/paste/i);
    expect(web.VIDEO_LINK_ADVICE).not.toMatch(/share the post/i);
  });

  it('the web hint does not say "on the web", because the desktop app shows it too', () => {
    expect(web.LINK_TAB_HINT).not.toMatch(/on the web/i);
  });

  it("the phone build needs no hint, because a post can be shared into the app", () => {
    expect(native.LINK_TAB_HINT).toBeNull();
    expect(native.VIDEO_LINK_ADVICE).toMatch(/share the post into this app/i);
  });

  it("uses no em dashes, per the copy style", () => {
    for (const text of [web.LINK_TAB_HINT, web.VIDEO_LINK_ADVICE, native.VIDEO_LINK_ADVICE]) {
      expect(text ?? "").not.toContain("—");
    }
  });
});
