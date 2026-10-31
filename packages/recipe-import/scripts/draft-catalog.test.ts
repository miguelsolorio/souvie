// Tests for the catalog drafting script (WS16 acceptance 6), with a fake model client: no network,
// no key. The fake answers with two recipes already in supabase/seed/catalog/recipes, so the same
// checks that gated those files gate the fake's answers.

import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { LlmError, type MessagesClient } from "@mp/llm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type CatalogRecipe, PLAN, shapeProblems } from "../../../supabase/seed/catalog/spec.ts";
import {
  CostLedger,
  capClient,
  DEFAULT_LOG_PATH,
  DEFAULT_OUT_DIR,
  type DraftLog,
  defaultLogPath,
  draftCatalog,
  draftTextProblems,
  estimateCallUsd,
  parseArgs,
  retagCatalog,
  tidy,
  withQualifiers,
} from "./draft-catalog.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIRST = PLAN[0];
const SECOND = PLAN[1];
if (!FIRST || !SECOND) throw new Error("the plan needs two slots");

const readRecipe = (slug: string): CatalogRecipe =>
  JSON.parse(readFileSync(join(DEFAULT_OUT_DIR, `${slug}.json`), "utf8")) as CatalogRecipe;

/** The model's answer shape for a recipe already in the catalog. */
function answerFor(slug: string, mutate?: (steps: string[]) => string[]) {
  const r = readRecipe(slug);
  return {
    title: r.title,
    description: r.description,
    prep_minutes: r.prepMin,
    cook_minutes: r.cookMin,
    ingredients: r.ingredients.map((l) => ({ text: l.rawText, group: l.groupName })),
    steps: mutate ? mutate([...r.instructions]) : r.instructions,
  };
}

const USAGE = { input_tokens: 2000, output_tokens: 1500 }; // $0.019 at Sonnet rates

interface FakeOptions {
  /** Called with the slot's protein and the call number for that protein; may corrupt the answer. */
  mutate?: (protein: string, call: number) => ((steps: string[]) => string[]) | undefined;
}

function fakeClient(options: FakeOptions = {}) {
  const counts = { sonnet: 0, haiku: 0 };
  const perProtein = new Map<string, number>();
  const client: MessagesClient = {
    messages: {
      async parse(params) {
        if (params.model === "claude-haiku-5-5") {
          counts.haiku++;
          return {
            parsed_output: { lines: [] },
            stop_reason: "end_turn",
            usage: { input_tokens: 100, output_tokens: 10 },
          };
        }
        counts.sonnet++;
        const content = String((params.messages as { content: unknown }[])[0]?.content);
        const protein = /Main protein: (\w+)/.exec(content)?.[1] ?? "";
        const call = (perProtein.get(protein) ?? 0) + 1;
        perProtein.set(protein, call);
        const slug = protein === "chicken" ? FIRST?.slug : SECOND?.slug;
        return {
          parsed_output: answerFor(slug ?? "", options.mutate?.(protein, call)),
          stop_reason: "end_turn",
          usage: USAGE,
        };
      },
    },
  };
  return { client, counts };
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "draft-catalog-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const options = (extra: Partial<Parameters<typeof draftCatalog>[0]> = {}) => ({
  count: 2,
  maxUsd: 0.25,
  outDir: join(dir, "recipes"),
  logPath: join(dir, "draft-log.json"),
  concurrency: 1,
  ...extra,
});

describe("draftCatalog", () => {
  it("writes two valid files, prints the cost, then skips both and spends nothing", async () => {
    const { client, counts } = fakeClient();
    const said: string[] = [];
    const first = await draftCatalog(options(), { client, say: (l) => said.push(l) });

    expect(first.written).toEqual([FIRST.slug, SECOND.slug]);
    expect(first.skipped).toEqual([]);
    expect(first.rejected).toEqual([]);
    expect(first.costUsd).toBeCloseTo(0.038, 4);
    expect(first.have).toBe(2);
    expect(said.filter((l) => l.startsWith("wrote "))).toHaveLength(2);
    for (const slug of [FIRST.slug, SECOND.slug]) {
      const file = JSON.parse(readFileSync(join(dir, "recipes", `${slug}.json`), "utf8"));
      expect(shapeProblems(file), slug).toEqual([]);
      expect(file.draft.costUsd).toBeCloseTo(0.019, 4);
      expect(file.draft.promptVersion).toBe("catalog-draft.v1");
    }
    const log = JSON.parse(readFileSync(join(dir, "draft-log.json"), "utf8")) as DraftLog;
    expect(log.runs).toHaveLength(1);

    const callsAfterFirst = counts.sonnet;
    const second = await draftCatalog(options(), { client, say: () => undefined });
    expect(second.written).toEqual([]);
    expect(second.skipped).toEqual([FIRST.slug, SECOND.slug]);
    expect(second.costUsd).toBe(0);
    expect(counts.sonnet).toBe(callsAfterFirst);
    // A run that changed nothing and spent nothing leaves no log line.
    expect(
      (JSON.parse(readFileSync(join(dir, "draft-log.json"), "utf8")) as DraftLog).runs,
    ).toHaveLength(1);
  });

  it("writes nothing and spends nothing when the cap is below one recipe's cost", async () => {
    const { client, counts } = fakeClient();
    const summary = await draftCatalog(options({ maxUsd: 0.01 }), { client, say: () => undefined });
    expect(summary.written).toEqual([]);
    expect(summary.costUsd).toBe(0);
    expect(summary.stoppedByCostCap).toBe(true);
    // The first call was refused before it started, so no model was called at all.
    expect(counts).toEqual({ sonnet: 0, haiku: 0 });
    expect(existsSync(join(dir, "recipes", `${FIRST.slug}.json`))).toBe(false);
    // A run that wrote nothing and spent nothing leaves no log line.
    expect(existsSync(join(dir, "draft-log.json"))).toBe(false);
  });

  it("books the worst case first, so spend never passes the cap", async () => {
    // A call is booked at about nine cents, then settles to its real cost (about two cents). A cap
    // of ten cents lets the first recipe through and refuses the second before it starts.
    const { client, counts } = fakeClient();
    const summary = await draftCatalog(options({ maxUsd: 0.1 }), { client, say: () => undefined });
    expect(summary.written).toEqual([FIRST.slug]);
    expect(summary.stoppedByCostCap).toBe(true);
    expect(counts.sonnet).toBe(1);
    expect(summary.costUsd).toBeLessThanOrEqual(0.1);
    expect(existsSync(join(dir, "recipes", `${SECOND.slug}.json`))).toBe(false);
  });

  it("counts the Haiku parser fallback against the same cap", async () => {
    // One odd line sends the recipe to the fallback, which this fake bills at about ten cents.
    let haikuCalls = 0;
    const inner = fakeClient({}).client;
    const client: MessagesClient = {
      messages: {
        async parse(params) {
          if (params.model === "claude-haiku-5-5") {
            haikuCalls++;
            return {
              parsed_output: { lines: [] },
              stop_reason: "end_turn",
              usage: { input_tokens: 1_000_000, output_tokens: 10 },
            };
          }
          const answer = (await inner.messages.parse(params)).parsed_output as {
            ingredients: { text: string; group: string | null }[];
          };
          return {
            parsed_output: {
              ...answer,
              ingredients: [...answer.ingredients, { text: "1 tsp zorblax powder", group: null }],
            },
            stop_reason: "end_turn",
            usage: USAGE,
          };
        },
      },
    };
    const summary = await draftCatalog(options({ count: 1, only: [SECOND.slug] }), {
      client,
      say: () => undefined,
    });
    expect(haikuCalls).toBeGreaterThan(0);
    expect(summary.written).toEqual([SECOND.slug]);
    expect(summary.costUsd).toBeGreaterThan(0.1);
    const file = JSON.parse(readFileSync(join(dir, "recipes", `${SECOND.slug}.json`), "utf8"));
    expect(file.draft.costUsd).toBeGreaterThan(0.1);
  });

  it("refuses a run log inside the recipes directory", async () => {
    const { client } = fakeClient();
    await expect(
      draftCatalog(options({ logPath: join(dir, "recipes", "draft-log.json") }), {
        client,
        say: () => undefined,
      }),
    ).rejects.toThrow(/may not live inside/);
  });

  it("retries a draft that fails a text rule and counts the rejection and both calls", async () => {
    const { client, counts } = fakeClient({
      mutate: (protein, call) =>
        protein === "chicken" && call === 1
          ? (steps) => [`Heat the oven — then add the pan.`, ...steps.slice(1)]
          : undefined,
    });
    const summary = await draftCatalog(options({ count: 1 }), { client, say: () => undefined });
    expect(summary.written).toEqual([FIRST.slug]);
    expect(counts.sonnet).toBe(2);
    expect(summary.rejected).toHaveLength(1);
    expect(summary.rejected[0]?.problems.join(" ")).toContain("em dash");
    expect(summary.costUsd).toBeCloseTo(0.038, 4);
    const file = readRecipe(FIRST.slug);
    expect(
      JSON.parse(readFileSync(join(dir, "recipes", `${FIRST.slug}.json`), "utf8")).draft.costUsd,
    ).toBeCloseTo(0.038, 4);
    expect(file.slug).toBe(FIRST.slug);
  });

  it("gives a slot up after two failed attempts and moves to the next slot", async () => {
    const { client } = fakeClient({
      mutate: (protein) =>
        protein === "chicken" ? (steps) => [`Heat — now.`, ...steps.slice(1)] : undefined,
    });
    const summary = await draftCatalog(options({ count: 1 }), { client, say: () => undefined });
    expect(summary.abandoned).toEqual([FIRST.slug]);
    expect(summary.written).toEqual([SECOND.slug]);
    expect(summary.rejected.length).toBeGreaterThanOrEqual(2);
  });

  it("rejects an answer whose protein does not match the slot", async () => {
    // The fake answers the beans recipe for every slot, so the chicken slot cannot pass.
    const wrong: MessagesClient = {
      messages: {
        async parse(params) {
          if (params.model === "claude-haiku-5-5") {
            return { parsed_output: { lines: [] }, stop_reason: "end_turn", usage: USAGE };
          }
          return {
            parsed_output: answerFor(SECOND.slug),
            stop_reason: "end_turn",
            usage: USAGE,
          };
        },
      },
    };
    const summary = await draftCatalog(options({ count: 1, only: [FIRST.slug] }), {
      client: wrong,
      say: () => undefined,
    });
    expect(summary.written).toEqual([]);
    expect(summary.abandoned).toEqual([FIRST.slug]);
    expect(summary.rejected.flatMap((r) => r.problems).join(" ")).toContain(
      "main protein must be chicken",
    );
  });

  it("refuses a slug that is not in the plan", async () => {
    const { client } = fakeClient();
    await expect(
      draftCatalog(options({ only: ["not-a-slot"] }), { client, say: () => undefined }),
    ).rejects.toThrow(/not in the plan/);
  });
});

describe("capClient", () => {
  const params = (model: string, maxTokens: number) => ({
    model,
    max_tokens: maxTokens,
    system: [{ type: "text", text: "s" }],
    messages: [{ role: "user", content: "u" }],
  });
  const answer = (input: number, output: number) => ({
    parsed_output: {},
    stop_reason: "end_turn",
    usage: { input_tokens: input, output_tokens: output },
  });

  it("lets only as many parallel calls start as the cap can hold at their worst case", async () => {
    const one = estimateCallUsd(params("claude-sonnet-5-5", 8000));
    expect(one).toBeGreaterThan(0.08);
    const ledger = new CostLedger(one * 2.5);
    let started = 0;
    const client = capClient(
      {
        messages: {
          async parse() {
            started++;
            await new Promise((r) => setTimeout(r, 5));
            return answer(1000, 500);
          },
        },
      },
      ledger,
    );
    const results = await Promise.allSettled(
      [1, 2, 3].map(() => client.messages.parse(params("claude-sonnet-5-5", 8000))),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(2);
    const refused = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(refused.reason).toBeInstanceOf(LlmError);
    expect((refused.reason as LlmError).code).toBe("cost_cap");
    expect(started).toBe(2);
    expect(ledger.refused).toBe(true);
    expect(ledger.reserved).toBeCloseTo(0, 9);
    expect(ledger.committed).toBeLessThanOrEqual(ledger.capUsd);
  });

  it("books Haiku calls too, and refuses one the cap cannot hold", async () => {
    const ledger = new CostLedger(0.001);
    let called = 0;
    const client = capClient(
      {
        messages: {
          async parse() {
            called++;
            return answer(10, 10);
          },
        },
      },
      ledger,
    );
    await expect(client.messages.parse(params("claude-haiku-5-5", 4096))).rejects.toThrow(/cap/);
    expect(called).toBe(0);
    expect(ledger.committed).toBe(0);
  });

  it("releases an HTTP error that was not billed, and keeps the booking for one that may have been", async () => {
    const make = (error: unknown) => {
      const ledger = new CostLedger(5);
      const client = capClient({ messages: { parse: async () => Promise.reject(error) } }, ledger);
      return { ledger, client };
    };
    const http = make(Object.assign(new Error("overloaded"), { status: 529 }));
    await expect(http.client.messages.parse(params("claude-sonnet-5-5", 8000))).rejects.toThrow();
    expect(http.ledger.committed).toBe(0);
    expect(http.ledger.reserved).toBeCloseTo(0, 9);
    const unknown = make(new Error("could not parse the structured output"));
    await expect(
      unknown.client.messages.parse(params("claude-sonnet-5-5", 8000)),
    ).rejects.toThrow();
    expect(unknown.ledger.committed).toBeGreaterThan(0.08);
  });
});

describe("withQualifiers", () => {
  const categoryOf = (name: string): string | undefined =>
    name === "soy sauce" ? "pantry" : undefined;
  const line = {
    position: 0,
    groupName: null,
    rawText: "2 tbsp gluten-free tamari",
    qty: 2,
    qtyMax: null,
    unit: "tbsp",
    ingredientName: "soy sauce",
    ingredientId: "11111111-1111-5111-8111-111111111111",
    prepNote: null,
    optional: false,
    parseConfidence: 0.95,
  };
  it("puts the stated qualifier in prepNote when the id alone would lose it", () => {
    expect(withQualifiers(line, categoryOf).prepNote).toBe("gluten-free");
    expect(withQualifiers({ ...line, prepNote: "divided" }, categoryOf).prepNote).toBe(
      "gluten-free, divided",
    );
    expect(withQualifiers({ ...line, prepNote: "gluten-free" }, categoryOf).prepNote).toBe(
      "gluten-free",
    );
  });
  it("leaves unresolved lines and plain lines alone", () => {
    expect(withQualifiers({ ...line, ingredientId: null }, categoryOf).prepNote).toBeNull();
    expect(
      withQualifiers({ ...line, rawText: "1 cup water", ingredientName: "water" }, categoryOf)
        .prepNote,
    ).toBeNull();
  });
});

describe("draftTextProblems", () => {
  const base = answerFor(FIRST.slug);
  it("accepts a drafted recipe", () => {
    expect(draftTextProblems(base, FIRST)).toEqual([]);
  });
  it("flags minutes over the slot maximum", () => {
    const problems = draftTextProblems({ ...base, cook_minutes: 200 }, FIRST);
    expect(problems.join(" ")).toContain("maximum is");
  });
  it("flags a line with no quantity, a choice, and a numbered step", () => {
    const problems = draftTextProblems(
      {
        ...base,
        ingredients: [
          ...base.ingredients.slice(1),
          { text: "salt", group: null },
          { text: "1 cup rice or quinoa", group: null },
        ],
        steps: ["1. Mix.", ...base.steps.slice(1)],
      },
      FIRST,
    ).join(" ");
    expect(problems).toContain("start with a quantity");
    expect(problems).toContain('"or"');
    expect(problems).toContain("must not be numbered");
  });
  it("flags diet claims in the title and description", () => {
    const problems = draftTextProblems(
      { ...base, title: "Vegan Tacos", description: "A plain dish that is dairy free and tasty." },
      FIRST,
    ).join(" ");
    expect(problems).toContain("title must not claim");
    expect(problems).toContain("description must not claim");
  });
  it("tidies typography", () => {
    expect(tidy("Don’t “stop” – go…")).toBe('Don\'t "stop" - go...');
  });
});

describe("retagCatalog", () => {
  it("restores the diet tags the current rules give, with no model call", () => {
    mkdirSync(dir, { recursive: true });
    const target = join(dir, `${SECOND.slug}.json`);
    copyFileSync(join(DEFAULT_OUT_DIR, `${SECOND.slug}.json`), target);
    const tampered = readRecipe(SECOND.slug);
    tampered.tags = tampered.tags.filter((t) => t !== "vegan");
    writeFileSync(target, `${JSON.stringify(tampered, null, 2)}\n`);

    expect(retagCatalog(dir, () => undefined)).toEqual([SECOND.slug]);
    expect((JSON.parse(readFileSync(target, "utf8")) as CatalogRecipe).tags).toEqual(
      readRecipe(SECOND.slug).tags,
    );
    expect(retagCatalog(dir, () => undefined)).toEqual([]);
  });
});

describe("command line", () => {
  it("has defaults, ignores a bare --, and reads the flags", () => {
    expect(parseArgs([])).toMatchObject({
      count: 60,
      maxUsd: 5,
      concurrency: 3,
      outDir: DEFAULT_OUT_DIR,
    });
    const parsed = parseArgs(["--", "--count", "2", "--max-usd", "0.25", "--out", "/tmp/x"]);
    expect(parsed).toMatchObject({
      count: 2,
      maxUsd: 0.25,
      outDir: "/tmp/x",
      logPath: "/tmp/x.draft-log.json",
    });
    expect(parseArgs(["--only", "a,b"])).toMatchObject({ count: 2, only: ["a", "b"] });
    expect(parseArgs(["--help"])).toBe("help");
  });
  it("keeps the run log out of the recipes directory", () => {
    expect(defaultLogPath(DEFAULT_OUT_DIR)).toBe(DEFAULT_LOG_PATH);
    expect(DEFAULT_LOG_PATH.startsWith(`${DEFAULT_OUT_DIR}/`)).toBe(false);
    expect(parseArgs(["--out", DEFAULT_OUT_DIR])).toMatchObject({ logPath: DEFAULT_LOG_PATH });
    expect(parseArgs([])).toMatchObject({ logPath: DEFAULT_LOG_PATH });
    expect(defaultLogPath("/tmp/catalog-smoke")).toBe("/tmp/catalog-smoke.draft-log.json");
    expect(defaultLogPath("/tmp/a/recipes/")).toBe("/tmp/a/recipes.draft-log.json");
  });
  it("rejects bad input", () => {
    expect(() => parseArgs(["--count", "0"])).toThrow(/positive/);
    expect(() => parseArgs(["--bogus"])).toThrow(/unknown option/);
    expect(() => parseArgs(["--count"])).toThrow(/needs a value/);
  });
  it("refuses to run when CI is set", () => {
    const result = spawnSync(process.execPath, [join(HERE, "draft-catalog.ts")], {
      encoding: "utf8",
      env: { ...process.env, CI: "true", ANTHROPIC_API_KEY: "" },
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("refuses to run when CI is set");
  });
});
