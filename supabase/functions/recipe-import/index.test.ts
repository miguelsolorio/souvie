import { describe, expect, it, vi } from "vitest";
import { LlmError } from "../../../packages/llm/src/index.ts";
import type { ModelExtract } from "../../../packages/recipe-import/src/index.ts";
import {
  HOURLY_IMPORT_LIMIT,
  handleRecipeImport,
  isHouseholdImagePath,
  MAX_IMAGE_BYTES,
  type Runtime,
} from "./handler.ts";
import {
  type DownloadedImage,
  type DuplicateCheck,
  DuplicateSaveError,
  type ExistingRecipe,
  type HouseholdLookup,
  type ImportStore,
  type JobUpdate,
  type NewJob,
  type SaveRecipeInput,
} from "./store.ts";

// supabase-js is only needed by the real runtime; the tests inject their own.
vi.mock("./client.ts", () => ({ createClient: vi.fn() }));

const HOUSEHOLD = "0a000000-0000-4000-8000-00000000000a";
const OTHER_HOUSEHOLD = "0b000000-0000-4000-8000-00000000000b";
const USER = "a1111111-1111-4111-8111-111111111111";
const AUTH = "Bearer user-jwt";

const RECIPE_LD = {
  "@context": "https://schema.org",
  "@type": "Recipe",
  name: "Lemon Chicken",
  image: ["https://example.test/chicken.jpg"],
  recipeYield: "4",
  recipeIngredient: ["8 chicken thighs", "1 lemon, sliced"],
  recipeInstructions: [{ "@type": "HowToStep", text: "Roast." }],
};
const RECIPE_HTML = `<html><head><script type="application/ld+json">${JSON.stringify(RECIPE_LD)}</script></head><body></body></html>`;

const MODEL_ANSWER = {
  found: true,
  title: "Pancakes",
  description: null,
  servings: 4,
  prep_minutes: 5,
  cook_minutes: 10,
  ingredients: [
    { text: "2 cups flour", group: null },
    { text: "1 cup milk", group: null },
  ],
  steps: ["Whisk.", "Fry."],
  tags: [],
  cuisine: null,
};

class FakeStore implements ImportStore {
  household: HouseholdLookup = { kind: "ok", householdId: HOUSEHOLD };
  recentJobs = 0;
  image: DownloadedImage | null = { bytes: new Uint8Array([1, 2, 3]), contentType: "image/jpeg" };
  failSave = false;
  jobs: Array<{ id: string; job: NewJob; update?: JobUpdate }> = [];
  saved: SaveRecipeInput[] = [];
  resolveCalls: Array<{ requested: string | undefined }> = [];
  downloaded: string[] = [];
  /** Live recipes the household already has: by normalized link, or by title. */
  existing: Array<{ recipeId: string; sourceUrlNormalized?: string; title?: string }> = [];
  lookups: DuplicateCheck[] = [];
  failLookup = false;
  /** A recipe another request saved between the lookup and the insert. */
  raceWith: { recipeId: string; sourceUrlNormalized: string } | null = null;

  async findDuplicate(
    _auth: string,
    _household: string,
    check: DuplicateCheck,
  ): Promise<ExistingRecipe | null> {
    this.lookups.push(check);
    if (this.failLookup) throw new Error("lookup down");
    if (check.sourceUrlNormalized) {
      const hit = this.existing.find((e) => e.sourceUrlNormalized === check.sourceUrlNormalized);
      return hit ? { recipeId: hit.recipeId, matchedBy: "url" } : null;
    }
    const title = check.title;
    if (title) {
      const hit = this.existing.find((e) => e.title !== undefined && title.isSame(e.title));
      return hit ? { recipeId: hit.recipeId, matchedBy: "title" } : null;
    }
    return null;
  }
  async resolveHousehold(_auth: string, _user: string, requested: string | undefined) {
    this.resolveCalls.push({ requested });
    return this.household;
  }
  async recentJobCount() {
    return this.recentJobs;
  }
  async createJob(job: NewJob) {
    const id = `job-${this.jobs.length + 1}`;
    this.jobs.push({ id, job });
    return id;
  }
  async finishJob(jobId: string, _household: string, update: JobUpdate) {
    const entry = this.jobs.find((j) => j.id === jobId);
    if (entry) entry.update = update;
  }
  async saveRecipe(_auth: string, input: SaveRecipeInput) {
    if (this.failSave) throw new Error("db down");
    if (this.raceWith) {
      this.existing.push(this.raceWith);
      throw new DuplicateSaveError();
    }
    this.saved.push(input);
    return "5ec1be00-0000-4000-8000-000000000001";
  }
  async downloadImage(_auth: string, path: string) {
    this.downloaded.push(path);
    return this.image;
  }
  async spentSince() {
    return 0;
  }
}

function runtime(over: Partial<Runtime> & { store?: FakeStore; answers?: unknown[] } = {}): {
  rt: Runtime;
  store: FakeStore;
  modelCalls: Array<Parameters<ModelExtract>[1]>;
} {
  const store = over.store ?? new FakeStore();
  const modelCalls: Array<Parameters<ModelExtract>[1]> = [];
  const answers = over.answers ?? [MODEL_ANSWER];
  const model: ModelExtract = async (schema, request) => {
    modelCalls.push(request as never);
    const next = answers.shift() ?? MODEL_ANSWER;
    if (next instanceof Error) throw next;
    return {
      value: schema.parse(next),
      model: "claude-sonnet-5-5",
      attempts: 1,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      costUsd: 0,
    };
  };
  const rt: Runtime = {
    authenticate: async (header) => (header === AUTH ? { userId: USER } : null),
    store,
    modelFor: () => model,
    now: () => new Date("2026-10-30T12:00:00Z"),
    fetch: (async () =>
      new Response(RECIPE_HTML, { headers: { "content-type": "text/html" } })) as typeof fetch,
    ...over,
  };
  return { rt, store, modelCalls };
}

function post(body: unknown, headers: Record<string, string> = { authorization: AUTH }) {
  return new Request("https://fn.test/recipe-import", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

async function call(rt: Runtime, body: unknown, headers?: Record<string, string>) {
  const res = await handleRecipeImport(post(body, headers), rt);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe("request handling", () => {
  it("answers CORS preflight and rejects other methods", async () => {
    const { rt } = runtime();
    expect(
      (await handleRecipeImport(new Request("https://fn.test/", { method: "OPTIONS" }), rt)).status,
    ).toBe(204);
    const get = await handleRecipeImport(new Request("https://fn.test/", { method: "GET" }), rt);
    expect(get.status).toBe(405);
    expect(get.headers.get("allow")).toBe("POST, OPTIONS");
  });

  it("requires a valid bearer token", async () => {
    const { rt, store } = runtime();
    expect((await call(rt, { kind: "url", input: "https://example.test/r" }, {})).status).toBe(401);
    expect(
      (
        await call(
          rt,
          { kind: "url", input: "https://example.test/r" },
          { authorization: "Bearer nope" },
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await call(
          rt,
          { kind: "url", input: "https://example.test/r" },
          { authorization: "Token x" },
        )
      ).status,
    ).toBe(401);
    expect(store.jobs).toHaveLength(0);
    const broken = runtime({
      authenticate: async () => {
        throw new Error("auth down");
      },
    }).rt;
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect((await call(broken, { kind: "url", input: "https://example.test/r" })).status).toBe(401);
  });

  it("rejects bad JSON, bad shapes, and oversized bodies", async () => {
    const { rt, store } = runtime();
    expect((await call(rt, "{not json")).body).toMatchObject({
      ok: false,
      error: "invalid_request",
    });
    const bad = await call(rt, { kind: "video", input: "x" });
    expect(bad.status).toBe(400);
    expect(bad.body).toMatchObject({ ok: false, error: "invalid_request" });
    expect((await call(rt, { kind: "url", input: "javascript:alert(1)" })).status).toBe(400);
    expect((await call(rt, { kind: "text", input: "short" })).status).toBe(400);
    expect(
      (await call(rt, { kind: "url", input: `https://example.test/${"a".repeat(300_000)}` }))
        .status,
    ).toBe(413);
    expect(store.jobs).toHaveLength(0);
  });

  it("requires household membership", async () => {
    const none = runtime();
    none.store.household = { kind: "none" };
    expect(await call(none.rt, { kind: "url", input: "https://example.test/r" })).toMatchObject({
      status: 400,
      body: { ok: false, error: "no_household" },
    });
    const stranger = runtime();
    stranger.store.household = { kind: "not_member" };
    expect(
      await call(stranger.rt, {
        kind: "url",
        input: "https://example.test/r",
        householdId: OTHER_HOUSEHOLD,
      }),
    ).toMatchObject({ status: 403, body: { ok: false, error: "not_a_member" } });
    expect(stranger.store.resolveCalls[0]?.requested).toBe(OTHER_HOUSEHOLD);
    expect(stranger.store.jobs).toHaveLength(0);
  });

  it("rate limits a household that imports too fast", async () => {
    const { rt, store } = runtime();
    store.recentJobs = HOURLY_IMPORT_LIMIT;
    expect(await call(rt, { kind: "url", input: "https://example.test/r" })).toMatchObject({
      status: 200,
      body: { ok: false, error: "rate_limited" },
    });
    expect(store.jobs).toHaveLength(0);
  });
});

describe("url imports", () => {
  it("creates a job, saves a url recipe with attribution, and closes the job", async () => {
    const { rt, store, modelCalls } = runtime();
    const { status, body } = await call(rt, {
      kind: "url",
      input: "https://example.test/lemon-chicken?utm_source=x",
    });

    expect(status).toBe(200);
    expect(body).toMatchObject({
      ok: true,
      jobId: "job-1",
      path: "jsonld",
      recipeId: "5ec1be00-0000-4000-8000-000000000001",
      warnings: [],
    });
    expect(modelCalls).toHaveLength(0);

    expect(store.jobs[0]?.job).toEqual({
      householdId: HOUSEHOLD,
      kind: "url",
      // The cleaned link, as recipes.source_url gets it: no tracking parameters survive in the job.
      input: { url: "https://example.test/lemon-chicken" },
    });
    expect(store.jobs[0]?.update).toEqual({
      status: "done",
      resultRecipeId: "5ec1be00-0000-4000-8000-000000000001",
    });

    const saved = store.saved[0];
    expect(saved?.householdId).toBe(HOUSEHOLD);
    expect(saved?.sourceType).toBe("url");
    expect(saved?.sourceUrl).toBe("https://example.test/lemon-chicken");
    expect(saved?.recipe.title).toBe("Lemon Chicken");
    expect(saved?.recipe.ingredients.map((i) => i.rawText)).toEqual([
      "8 chicken thighs",
      "1 lemon, sliced",
    ]);
  });

  it("returns the draft and writes no recipe when save is false", async () => {
    const { rt, store } = runtime();
    const { body } = await call(rt, { kind: "url", input: "https://example.test/r", save: false });
    expect(body).toMatchObject({ ok: true, path: "jsonld", draft: { title: "Lemon Chicken" } });
    expect(body).not.toHaveProperty("recipeId");
    expect(store.saved).toHaveLength(0);
    expect(store.jobs[0]?.update).toEqual({ status: "done" });
  });

  it("reports a refused site as a failed job and an ok:false body, not an HTTP error", async () => {
    const { rt, store } = runtime({
      fetch: (async () => new Response("no", { status: 403 })) as typeof fetch,
    });
    const { status, body } = await call(rt, {
      kind: "url",
      input: "https://www.allrecipes.com/recipe/1/x",
    });
    expect(status).toBe(200);
    expect(body).toMatchObject({ ok: false, error: "blocked", jobId: "job-1" });
    expect(store.jobs[0]?.update).toMatchObject({ status: "failed" });
    expect(store.jobs[0]?.update?.error).toMatch(/^blocked/);
    expect(store.saved).toHaveLength(0);
  });

  it("makes no request to a video platform", async () => {
    const fetchMock = vi.fn();
    const { rt, store } = runtime({ fetch: fetchMock as never });
    for (const input of [
      "https://www.instagram.com/reel/x/",
      "https://www.tiktok.com/@a/video/1",
    ]) {
      expect((await call(rt, { kind: "url", input })).body).toMatchObject({
        ok: false,
        error: "video_platform",
      });
    }
    expect(fetchMock).not.toHaveBeenCalled();
    expect(store.saved).toHaveLength(0);
  });

  it("uses the model when the page has no structured recipe", async () => {
    const page = `<html><body><article>${"A short story about pancakes. ".repeat(10)}<h2>Ingredients</h2><ul><li>2 cups flour</li><li>1 cup milk</li></ul><h2>Method</h2><ol><li>Whisk.</li><li>Fry.</li></ol></article></body></html>`;
    const { rt, store, modelCalls } = runtime({
      fetch: (async () =>
        new Response(page, { headers: { "content-type": "text/html" } })) as typeof fetch,
    });
    const { body } = await call(rt, { kind: "url", input: "https://blog.test/pancakes" });
    expect(body).toMatchObject({ ok: true, path: "llm" });
    expect(modelCalls).toHaveLength(1);
    expect(modelCalls[0]).toMatchObject({
      kind: "extract_recipe",
      promptVersion: "recipe-extract.v1",
    });
    expect(store.saved[0]?.sourceType).toBe("url");
  });

  it("says so when the page needs a model and none is configured", async () => {
    const page = `<html><body><article>${"A short story about pancakes. ".repeat(10)}<h2>Ingredients</h2><ul><li>2 cups flour</li></ul></article></body></html>`;
    const { rt } = runtime({
      modelFor: () => undefined,
      fetch: (async () =>
        new Response(page, { headers: { "content-type": "text/html" } })) as typeof fetch,
    });
    expect(
      (await call(rt, { kind: "url", input: "https://blog.test/pancakes" })).body,
    ).toMatchObject({
      ok: false,
      error: "model_unavailable",
    });
  });

  it("reports save_failed with a 500 when the database write fails, and closes the job", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { rt, store } = runtime();
    store.failSave = true;
    const { status, body } = await call(rt, { kind: "url", input: "https://example.test/r" });
    expect(status).toBe(500);
    expect(body).toMatchObject({ ok: false, error: "save_failed", jobId: "job-1" });
    expect(store.jobs[0]?.update).toMatchObject({ status: "failed" });
  });
});

describe("text and caption imports", () => {
  it("saves pasted text as a text recipe", async () => {
    const { rt, store } = runtime();
    const pasted = "Pancakes\n2 cups flour\n1 cup milk\nWhisk. Fry.";
    const { body } = await call(rt, { kind: "text", input: pasted });
    expect(body).toMatchObject({ ok: true, path: "text", recipeId: expect.any(String) });
    expect(store.saved[0]).toMatchObject({ sourceType: "text" });
    expect(store.saved[0]?.recipe.title).toBe("Pancakes");
    // The job keeps the length, never the text.
    expect(store.jobs[0]?.job).toMatchObject({ kind: "text", input: { length: pasted.length } });
    expect(JSON.stringify(store.jobs[0]?.job)).not.toContain("flour");
  });

  it("saves a caption with its post link as a video recipe with attribution", async () => {
    const { rt, store } = runtime();
    const { body } = await call(rt, {
      kind: "caption",
      input: "Pancakes\n2 cups flour\n1 cup milk\n1 egg",
      sourceUrl: "https://www.tiktok.com/@cook/video/1",
    });
    expect(body).toMatchObject({ ok: true, path: "caption" });
    expect(store.saved[0]).toMatchObject({
      sourceType: "video",
      sourceUrl: "https://www.tiktok.com/@cook/video/1",
    });
    expect(store.jobs[0]?.job.kind).toBe("caption");
  });

  it("stores a caption's post link without tracking parameters or fragment, in the job, the recipe, and the draft", async () => {
    const link =
      "https://www.instagram.com/reel/abc/?igsh=SECRET123&utm_source=ig_web_copy_link#top";
    const clean = "https://www.instagram.com/reel/abc/";
    const input = "Pancakes\n2 cups flour\n1 cup milk\n1 egg";

    const saved = runtime();
    await call(saved.rt, { kind: "caption", input, sourceUrl: link });
    expect(saved.store.jobs[0]?.job.input).toEqual({ length: input.length, sourceUrl: clean });
    expect(saved.store.saved[0]).toMatchObject({ sourceType: "video", sourceUrl: clean });
    expect(JSON.stringify(saved.store.jobs[0]?.job)).not.toContain("SECRET123");

    const draft = runtime();
    const { body } = await call(draft.rt, { kind: "caption", input, sourceUrl: link, save: false });
    expect(body).toMatchObject({ ok: true, draft: { sourceUrl: clean } });
    expect(JSON.stringify(draft.store.jobs[0]?.job)).not.toContain("SECRET123");
  });

  it("keeps a url import's job input free of tracking parameters too", async () => {
    const { rt, store } = runtime();
    await call(rt, {
      kind: "url",
      input: "https://example.test/lemon-chicken?fbclid=SECRET456&gclid=SECRET789&page=2#reviews",
    });
    const input = JSON.stringify(store.jobs[0]?.job.input);
    expect(input).not.toContain("SECRET");
    expect(input).toContain("https://example.test/lemon-chicken?page=2");
    expect(input).not.toContain("#reviews");
  });

  it("saves a caption without a link as a text recipe", async () => {
    const { rt, store } = runtime();
    await call(rt, { kind: "caption", input: "Pancakes\n2 cups flour\n1 cup milk\n1 egg" });
    expect(store.saved[0]?.sourceType).toBe("text");
  });

  it("returns the caption draft for review, carrying the post link", async () => {
    const { rt, store } = runtime();
    const { body } = await call(rt, {
      kind: "caption",
      input: "Pancakes\n2 cups flour\n1 cup milk\n1 egg",
      sourceUrl: "https://www.instagram.com/reel/abc/",
      save: false,
    });
    expect(body).toMatchObject({
      ok: true,
      draft: { sourceUrl: "https://www.instagram.com/reel/abc/" },
    });
    expect(store.saved).toHaveLength(0);
  });

  it("answers not_enough_text for a caption with no ingredients, without calling the model or the network", async () => {
    const fetchMock = vi.fn();
    const { rt, modelCalls, store } = runtime({ fetch: fetchMock as never });
    const { status, body } = await call(rt, {
      kind: "caption",
      input: "So good!! Link in bio #foodtok #yum",
      sourceUrl: "https://www.tiktok.com/@cook/video/1",
    });
    expect(status).toBe(200);
    expect(body).toMatchObject({ ok: false, error: "not_enough_text" });
    expect(modelCalls).toHaveLength(0);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(store.jobs[0]?.update).toMatchObject({ status: "failed" });
  });

  it("maps a model cost cap to cost_cap", async () => {
    const { rt } = runtime({ answers: [new LlmError("cost_cap", "over")] });
    expect(
      (await call(rt, { kind: "text", input: "Pancakes\n2 cups flour\n1 cup milk" })).body,
    ).toMatchObject({
      ok: false,
      error: "cost_cap",
    });
  });
});

describe("photo imports", () => {
  const PATH = `${HOUSEHOLD}/card-1.jpg`;

  it("reads the photo as the caller and saves a photo recipe whose image is the stored path", async () => {
    const { rt, store, modelCalls } = runtime();
    const { body } = await call(rt, { kind: "image", input: { path: PATH } });
    expect(body).toMatchObject({ ok: true, path: "vision", recipeId: expect.any(String) });
    expect(store.downloaded).toEqual([PATH]);
    expect(modelCalls[0]?.images).toEqual([{ mediaType: "image/jpeg", data: "AQID" }]);
    expect(store.saved[0]).toMatchObject({ sourceType: "photo", imageUrl: PATH });
    expect(store.jobs[0]?.job).toEqual({
      householdId: HOUSEHOLD,
      kind: "photo",
      input: { path: PATH },
    });
  });

  it("returns an editable draft, not a saved recipe, when save is false", async () => {
    const { rt, store } = runtime();
    const { body } = await call(rt, { kind: "image", input: { path: PATH }, save: false });
    expect(body).toMatchObject({ ok: true, draft: { title: "Pancakes", imageUrl: PATH } });
    expect(body).not.toHaveProperty("recipeId");
    expect(store.saved).toHaveLength(0);
  });

  it("refuses a path outside the household's folder before reading anything", async () => {
    const { rt, store } = runtime();
    for (const path of [
      `${OTHER_HOUSEHOLD}/card.jpg`,
      `${HOUSEHOLD}/../${OTHER_HOUSEHOLD}/card.jpg`,
      `${HOUSEHOLD}//card.jpg`,
      "card.jpg",
      `${HOUSEHOLD}/`,
    ]) {
      const { status } = await call(rt, { kind: "image", input: { path } });
      expect(status, path).toBe(400);
    }
    expect(store.downloaded).toHaveLength(0);
    expect(store.jobs).toHaveLength(0);
  });

  it("reports image_not_found, an unsupported type, and an oversized photo", async () => {
    const missing = runtime();
    missing.store.image = null;
    expect((await call(missing.rt, { kind: "image", input: { path: PATH } })).body).toMatchObject({
      error: "image_not_found",
    });

    const odd = runtime();
    odd.store.image = { bytes: new Uint8Array([1]), contentType: "application/pdf" };
    expect(
      (await call(odd.rt, { kind: "image", input: { path: `${HOUSEHOLD}/card.pdf` } })).status,
    ).toBe(400);

    const big = runtime();
    big.store.image = { bytes: new Uint8Array(MAX_IMAGE_BYTES + 1), contentType: "image/jpeg" };
    expect((await call(big.rt, { kind: "image", input: { path: PATH } })).body).toMatchObject({
      error: "too_large",
    });
  });

  it("falls back to the file extension when Storage reports a generic type", async () => {
    const { rt, store, modelCalls } = runtime();
    store.image = { bytes: new Uint8Array([9]), contentType: "application/octet-stream" };
    await call(rt, { kind: "image", input: { path: `${HOUSEHOLD}/scan.png` } });
    expect(modelCalls[0]?.images?.[0]?.mediaType).toBe("image/png");
  });
});

describe("isHouseholdImagePath", () => {
  it("accepts files directly inside the household folder and nothing else", () => {
    expect(isHouseholdImagePath(`${HOUSEHOLD}/a.jpg`, HOUSEHOLD)).toBe(true);
    expect(isHouseholdImagePath(`${HOUSEHOLD}/sub/a.jpg`, HOUSEHOLD)).toBe(true);
    expect(isHouseholdImagePath(`${OTHER_HOUSEHOLD}/a.jpg`, HOUSEHOLD)).toBe(false);
    expect(isHouseholdImagePath(`${HOUSEHOLD}/../x.jpg`, HOUSEHOLD)).toBe(false);
    expect(isHouseholdImagePath(`${HOUSEHOLD}/a b.jpg`, HOUSEHOLD)).toBe(false);
    expect(isHouseholdImagePath(`${HOUSEHOLD}\\a.jpg`, HOUSEHOLD)).toBe(false);
  });
});

const EXISTING_ID = "5ec1be00-0000-4000-8000-0000000000ee";
const LEMON_KEY = "https://example.test/lemon-chicken";

describe("a recipe the household already has", () => {
  it("answers duplicate for the same link before fetching, reading, or logging anything", async () => {
    const fetchMock = vi.fn();
    const { rt, store, modelCalls } = runtime({ fetch: fetchMock as never });
    store.existing = [{ recipeId: EXISTING_ID, sourceUrlNormalized: LEMON_KEY }];

    const { status, body } = await call(rt, {
      kind: "url",
      input: "HTTPS://Example.test/lemon-chicken/?utm_source=newsletter#reviews",
    });

    expect(status).toBe(200);
    expect(body).toEqual({
      ok: false,
      error: "duplicate",
      message: "You already have this recipe.",
      recipeId: EXISTING_ID,
      matchedBy: "url",
    });
    expect(store.lookups).toEqual([{ sourceUrlNormalized: LEMON_KEY }]);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(modelCalls).toHaveLength(0);
    // Nothing was attempted, so there is no job and nothing counts against the hourly limit.
    expect(store.jobs).toHaveLength(0);
    expect(store.saved).toHaveLength(0);
  });

  it("does not let allowDuplicate through for a link the household already has", async () => {
    const { rt, store } = runtime();
    store.existing = [{ recipeId: EXISTING_ID, sourceUrlNormalized: LEMON_KEY }];
    const { body } = await call(rt, {
      kind: "url",
      input: "https://example.test/lemon-chicken",
      allowDuplicate: true,
    });
    expect(body).toMatchObject({ ok: false, error: "duplicate", recipeId: EXISTING_ID });
    expect(store.saved).toHaveLength(0);
  });

  it("imports a different link as usual, and a deleted recipe's link is free again", async () => {
    // The store only returns live recipes, so a soft-deleted one is simply not in `existing`.
    const { rt, store } = runtime();
    store.existing = [{ recipeId: EXISTING_ID, sourceUrlNormalized: "https://example.test/other" }];
    const { body } = await call(rt, { kind: "url", input: "https://example.test/lemon-chicken" });
    expect(body).toMatchObject({ ok: true, recipeId: expect.any(String) });
    expect(store.saved).toHaveLength(1);
  });

  it("checks again under the address the page ended up at, and closes the job", async () => {
    // A short link that redirects: the stored source_url is the final address, so that is the
    // one the database would refuse.
    const fetchMock = vi.fn(async (input: RequestInfo | URL) =>
      String(input).includes("short")
        ? new Response(null, {
            status: 301,
            headers: { location: "https://example.test/lemon-chicken" },
          })
        : new Response(RECIPE_HTML, { headers: { "content-type": "text/html" } }),
    );
    const { rt, store } = runtime({ fetch: fetchMock as never });
    store.existing = [{ recipeId: EXISTING_ID, sourceUrlNormalized: LEMON_KEY }];

    const { body } = await call(rt, { kind: "url", input: "https://example.test/short" });

    expect(body).toMatchObject({
      ok: false,
      error: "duplicate",
      recipeId: EXISTING_ID,
      matchedBy: "url",
      jobId: "job-1",
    });
    expect(store.lookups.map((l) => l.sourceUrlNormalized)).toEqual([
      "https://example.test/short",
      LEMON_KEY,
    ]);
    expect(store.saved).toHaveLength(0);
    expect(store.jobs[0]?.update).toMatchObject({ status: "failed" });
    expect(store.jobs[0]?.update?.error).toMatch(/^duplicate/);
  });

  it("recognises pasted text by its title, with case and spacing folded", async () => {
    const { rt, store } = runtime();
    store.existing = [{ recipeId: EXISTING_ID, title: "  PANCAKES " }];
    const { body } = await call(rt, {
      kind: "text",
      input: "Pancakes\n2 cups flour\n1 cup milk\nWhisk. Fry.",
    });
    expect(body).toMatchObject({
      ok: false,
      error: "duplicate",
      recipeId: EXISTING_ID,
      matchedBy: "title",
      jobId: "job-1",
    });
    expect(store.saved).toHaveLength(0);
    expect(store.jobs[0]?.update).toMatchObject({ status: "failed" });
  });

  it("saves it anyway when the person says so, because a title is not a link", async () => {
    const { rt, store } = runtime();
    store.existing = [{ recipeId: EXISTING_ID, title: "Pancakes" }];
    const { body } = await call(rt, {
      kind: "text",
      input: "Pancakes\n2 cups flour\n1 cup milk\nWhisk. Fry.",
      allowDuplicate: true,
    });
    expect(body).toMatchObject({ ok: true, recipeId: expect.any(String) });
    expect(store.saved).toHaveLength(1);
    // With allowDuplicate the title is not even looked up.
    expect(store.lookups).toHaveLength(0);
  });

  it("does not take a different title for the same recipe", async () => {
    const { rt, store } = runtime();
    store.existing = [{ recipeId: EXISTING_ID, title: "Pancakes with Berries" }];
    const { body } = await call(rt, {
      kind: "text",
      input: "Pancakes\n2 cups flour\n1 cup milk\nWhisk. Fry.",
    });
    expect(body).toMatchObject({ ok: true });
  });

  it("looks at the link, not the title, once a recipe has a link", async () => {
    const { rt, store } = runtime();
    // Same title, different link: two blogs can both publish "Lemon Chicken".
    store.existing = [{ recipeId: EXISTING_ID, title: "Lemon Chicken" }];
    const { body } = await call(rt, { kind: "url", input: "https://example.test/lemon-chicken" });
    expect(body).toMatchObject({ ok: true });
    expect(store.lookups.every((l) => l.title === undefined)).toBe(true);
  });

  it("checks a caption's post link first, even for a draft", async () => {
    const { rt, store, modelCalls } = runtime();
    store.existing = [
      { recipeId: EXISTING_ID, sourceUrlNormalized: "https://www.instagram.com/reel/abc" },
    ];
    const { body } = await call(rt, {
      kind: "caption",
      input: "Pancakes\n2 cups flour\n1 cup milk\n1 egg",
      sourceUrl: "https://www.instagram.com/reel/abc/?igsh=SECRET#x",
      save: false,
    });
    expect(body).toMatchObject({ ok: false, error: "duplicate", matchedBy: "url" });
    expect(modelCalls).toHaveLength(0);
    expect(store.jobs).toHaveLength(0);
  });

  it("leaves a draft's title alone: the app checks it when the draft is saved", async () => {
    const { rt, store } = runtime();
    store.existing = [{ recipeId: EXISTING_ID, title: "Pancakes" }];
    const { body } = await call(rt, {
      kind: "image",
      input: { path: `${HOUSEHOLD}/card.jpg` },
      save: false,
    });
    expect(body).toMatchObject({ ok: true, draft: { title: "Pancakes" } });
    expect(store.lookups).toHaveLength(0);
  });

  it("answers duplicate when two saves of one link race and the database refuses the second", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { rt, store } = runtime();
    store.raceWith = { recipeId: EXISTING_ID, sourceUrlNormalized: LEMON_KEY };
    const { status, body } = await call(rt, {
      kind: "url",
      input: "https://example.test/lemon-chicken",
    });
    expect(status).toBe(200);
    expect(body).toMatchObject({
      ok: false,
      error: "duplicate",
      recipeId: EXISTING_ID,
      matchedBy: "url",
      jobId: "job-1",
    });
    expect(store.jobs[0]?.update).toMatchObject({ status: "failed" });
  });

  it("reports save_failed when the index refused the link but no recipe can be found", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { rt, store } = runtime();
    store.saveRecipe = async () => {
      throw new DuplicateSaveError();
    };
    const { status, body } = await call(rt, {
      kind: "url",
      input: "https://example.test/lemon-chicken",
    });
    expect(status).toBe(500);
    expect(body).toMatchObject({ ok: false, error: "save_failed" });
  });

  it("carries on when the lookup itself fails, since the index still guards the link", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { rt, store } = runtime();
    store.failLookup = true;
    const { body } = await call(rt, { kind: "url", input: "https://example.test/lemon-chicken" });
    expect(body).toMatchObject({ ok: true, recipeId: expect.any(String) });
    expect(store.saved).toHaveLength(1);
  });

  it("has a message written for the person using the app", async () => {
    const { rt, store } = runtime();
    store.existing = [{ recipeId: EXISTING_ID, sourceUrlNormalized: LEMON_KEY }];
    const { body } = await call(rt, { kind: "url", input: LEMON_KEY });
    expect(body.message).toBe("You already have this recipe.");
    expect(String(body.message)).not.toContain(String.fromCharCode(0x2014));
  });
});

describe("repeated ingredient lines", () => {
  const model = (lines: Array<{ text: string; group: string | null }>) => ({
    ...MODEL_ANSWER,
    ingredients: lines,
  });

  it("keeps only the first of two lines with the same text, in a saved recipe", async () => {
    const { rt, store } = runtime({
      answers: [
        model([
          { text: "2 cups flour", group: null },
          { text: "1 cup milk", group: null },
          { text: "2 cups  flour", group: null },
          { text: "1 egg", group: null },
          { text: "1 cup milk", group: null },
        ]),
      ],
    });
    await call(rt, { kind: "text", input: "Pancakes\n2 cups flour\n1 cup milk\nWhisk. Fry." });
    expect(store.saved[0]?.recipe.ingredients.map((i) => i.rawText)).toEqual([
      "2 cups flour",
      "1 cup milk",
      "1 egg",
    ]);
  });

  it("does the same in a draft", async () => {
    const { rt } = runtime({
      answers: [
        model([
          { text: "2 cups flour", group: null },
          { text: "2 cups flour", group: null },
        ]),
      ],
    });
    const { body } = await call(rt, {
      kind: "text",
      input: "Pancakes\n2 cups flour\n1 cup milk\nWhisk. Fry.",
      save: false,
    });
    expect((body.draft as { ingredients: unknown[] }).ingredients).toEqual([
      { rawText: "2 cups flour" },
    ]);
  });

  it("keeps lines that name the same ingredient in different words or under different headings", async () => {
    const { rt, store } = runtime({
      answers: [
        model([
          { text: "1 tbsp butter", group: "For the sauce" },
          { text: "2 tbsp butter, melted", group: "For the sauce" },
          { text: "1 tbsp butter", group: "For the topping" },
        ]),
      ],
    });
    await call(rt, { kind: "text", input: "Pancakes\n2 cups flour\n1 cup milk\nWhisk. Fry." });
    expect(store.saved[0]?.recipe.ingredients).toHaveLength(3);
  });
});

describe("internal errors", () => {
  it("returns a plain internal_error when the store throws unexpectedly", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { rt, store } = runtime();
    store.resolveHousehold = async () => {
      throw new Error("db down");
    };
    const { status, body } = await call(rt, { kind: "url", input: "https://example.test/r" });
    expect(status).toBe(500);
    expect(body).toMatchObject({ ok: false, error: "internal_error" });
    expect(JSON.stringify(body)).not.toContain("db down");
  });
});
