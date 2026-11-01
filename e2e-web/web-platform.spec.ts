import { expect, test } from "@playwright/test";
import { IDS } from "./fixtures/world";
import { openSignedIn, worldSupabase } from "./support/app";
import { watchConsoleErrors } from "./support/consoleErrors";
import { byTestId } from "./support/helpers";
import { jpegSize, solidPng } from "./support/images";

// WS13 acceptance criterion 6, and the platform files: a browser has no camera screen, no share
// sheet and no push. Photo import opens the file picker and runs the same recipe-import pipeline;
// the share sheet gives way to "paste a link"; push gives way to a notice.

const DRAFT = {
  ok: true,
  jobId: "66666666-6666-4666-8666-666666666666",
  path: "vision",
  draft: {
    title: "Lemon pasta from the card",
    servings: 4,
    ingredients: [{ rawText: "12 oz spaghetti" }, { rawText: "2 lemons, zested and juiced" }],
    instructions: ["Boil the pasta.", "Toss with lemon and oil."],
  },
  warnings: [],
};

function photoWorld() {
  const fake = worldSupabase();
  fake.edgeFunction("recipe-import", () => DRAFT);
  return fake;
}

test.describe("photo import in a browser", () => {
  test("opens the file picker, shrinks the photo, and runs the recipe-import pipeline", async ({
    page,
  }) => {
    const fake = photoWorld();
    await openSignedIn(page, fake);
    const watch = watchConsoleErrors(page);
    await page.goto("/recipes/new");
    await byTestId(page, "tab-photo").click();

    const chooser = page.waitForEvent("filechooser");
    await byTestId(page, "photo-library").click();
    // A 3200 by 2000 picture, wider than the 1600 pixels the app keeps.
    await (await chooser).setFiles({
      name: "recipe-card.png",
      mimeType: "image/png",
      buffer: solidPng(3200, 2000, [200, 120, 40]),
    });

    // The photo went to Storage as a JPEG at most 1600 wide, in this household's folder.
    await expect.poll(() => fake.uploads.length).toBe(1);
    const [upload] = fake.uploads;
    expect(upload?.path).toMatch(
      new RegExp(`^recipe-images/${IDS.household}/[0-9a-f-]{36}\\.jpg$`),
    );
    const bytes = upload?.bytes ?? Buffer.alloc(0);
    // Storage gets a multipart body or the raw file; either way the JPEG is in there.
    const start = bytes.indexOf(Buffer.from([0xff, 0xd8, 0xff]));
    expect(start).toBeGreaterThanOrEqual(0);
    expect(jpegSize(bytes.subarray(start))).toEqual({ width: 1600, height: 1000 });

    // The recipe-import function got the stored path, as a draft to review, for this household.
    await expect
      .poll(() => fake.requests.some((r) => r.table === "functions/recipe-import"))
      .toBe(true);
    const request = fake.requests.find((r) => r.table === "functions/recipe-import");
    expect(request?.body).toMatchObject({
      kind: "image",
      save: false,
      householdId: IDS.household,
      input: { path: expect.stringMatching(/^[0-9a-f-]{36}\/[0-9a-f-]{36}\.jpg$/) },
    });

    // The review screen shows what was read.
    await expect(page.getByText("Check the recipe")).toBeVisible();
    await expect(page.getByText(/Here is what we read from the photo/)).toBeVisible();
    await expect(page.getByRole("button", { name: "Save recipe" })).toBeVisible();
    expect(watch.errors()).toEqual([]);
  });

  test("a file that is not a picture is refused with a message, and nothing is uploaded", async ({
    page,
  }) => {
    const fake = photoWorld();
    await openSignedIn(page, fake);
    await page.goto("/recipes/new");
    await byTestId(page, "tab-photo").click();

    const chooser = page.waitForEvent("filechooser");
    await byTestId(page, "photo-library").click();
    await (await chooser).setFiles({
      name: "notes.png",
      mimeType: "image/png",
      buffer: Buffer.from("this is text, not a picture"),
    });

    await expect(page.getByText(/could not be read as a photo/)).toBeVisible();
    expect(fake.uploads).toHaveLength(0);
    // The screen is usable again.
    await expect(byTestId(page, "photo-library")).toBeEnabled();
  });

  test("the camera button opens the same picker, asking a phone's browser for its camera", async ({
    page,
  }) => {
    await openSignedIn(page, photoWorld());
    await page.goto("/recipes/new");
    await byTestId(page, "tab-photo").click();

    const chooser = page.waitForEvent("filechooser");
    await byTestId(page, "photo-camera").click();
    const picker = await chooser;
    // No camera permission screen to walk through, just a file input, with `capture` set.
    expect(await picker.element().getAttribute("capture")).toBe("environment");
  });
});

test.describe("what replaces the phone-only parts", () => {
  test("share sheet: the link tab says to paste, and points at the Paste tab", async ({ page }) => {
    await openSignedIn(page, worldSupabase());
    await page.goto("/recipes/new");

    const hint = byTestId(page, "link-tab-hint");
    await expect(hint).toBeVisible();
    await expect(hint).toContainText("no share sheet on the web");
    await expect(hint).toContainText("paste");
    await expect(byTestId(page, "import-url-input")).toBeVisible();
  });

  test("share sheet: a video link says to paste the caption, never to share the post", async ({
    page,
  }) => {
    await openSignedIn(page, worldSupabase());
    await page.goto("/recipes/new");
    await byTestId(page, "import-url-input").fill("https://www.tiktok.com/@cook/video/123");
    await expect(page.getByText(/We do not download videos/)).toBeVisible();
    await expect(page.getByText(/Paste tab/).first()).toBeVisible();
    await expect(page.getByText(/Share the post into this app/)).toHaveCount(0);
    await expect(byTestId(page, "import-url")).toBeDisabled();
  });

  test("push: the profile says notifications come to the phone app, and nothing registers", async ({
    page,
  }) => {
    const fake = worldSupabase();
    await openSignedIn(page, fake);
    await page.goto("/profile");

    await expect(byTestId(page, "push-unavailable")).toContainText("phone app");
    // No device token is written from a browser.
    expect(fake.writes("push_tokens")).toHaveLength(0);
  });
});
