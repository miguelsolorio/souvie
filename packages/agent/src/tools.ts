// The agent's tools (docs/03-ai-design.md §8 Tools, the WS09 brief's tool table).
//
// Every tool has an Anthropic definition (`strict: true`, every object closed), a capability it
// needs, and the run statuses and phases it may run in. A call is checked in that order before
// anything happens: an adapter that cannot do it gets a structured `not_supported` answer that
// says what to do instead (for Kroger, slots and pay hand off to the person). The model sees only
// the tools of the current phase; the host runs the push and checkout tools itself.
//
// The model names products only by candidate index. `choose_product` maps the index back to the
// Product the adapter returned (pickCandidate, then assertRefInCandidates), retries once on a bad
// index, then gives the line up as unmatched (R13).
import type { RunPolicy } from "@mp/core";
import {
  assertRefInCandidates,
  automates,
  type Capabilities,
  type Capability,
  type CapabilityName,
  type Product,
  pickCandidate,
  type RetailerAdapter,
  RetailerQuotaError,
  type Store,
  supports,
} from "@mp/retailers";
import { z } from "zod";
import {
  type LineDecision,
  MODEL_CANDIDATES,
  type PreparedLine,
  prepareLine,
  type ScoringContext,
  SEARCH_LIMIT,
} from "./planner.ts";
import { checkSubstitution, type SubstitutionReference } from "./policies.ts";
import type { Transcript } from "./transcript.ts";
import type { ListLine, RunStatus } from "./types.ts";

export const TOOL_NAMES = [
  "find_store",
  "search_products",
  "get_product",
  "choose_product",
  "mark_unmatched",
  "request_review",
  "add_to_cart",
  "set_quantity",
  "remove_from_cart",
  "view_cart",
  "get_slots",
  "select_slot",
  "checkout",
  "finish",
] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

/** Planning builds the proposal; push fills the cart after approval; checkout is Tier 3 only. */
export type RunPhase = "planning" | "push" | "checkout";

type Requirement =
  | { kind: "none" }
  | { kind: "supports"; capability: CapabilityName }
  | { kind: "automates"; capability: CapabilityName }
  | { kind: "browser"; capability: CapabilityName }
  | { kind: "either"; capabilities: CapabilityName[] };

interface ToolSpec {
  name: ToolName;
  description: string;
  input_schema: Record<string, unknown>;
  requires: Requirement;
  allowedIn: readonly RunStatus[];
  phases: readonly RunPhase[];
  /** Checkout needs the review gate passed. */
  needsApproval?: boolean;
}

const str = { type: "string" } as const;
const int = { type: "integer" } as const;

function schema(properties: Record<string, unknown>, required: string[]): Record<string, unknown> {
  return { type: "object", properties, required, additionalProperties: false };
}

/**
 * The tool table. `strict: true` does not accept numeric bounds in the schema, so limits such as
 * "at most 25" are in the description and enforced by the zod schemas below.
 */
export const TOOL_SPECS: Readonly<Record<ToolName, ToolSpec>> = {
  find_store: {
    name: "find_store",
    description:
      "List stores of this retailer near a ZIP code. The run's store is already set; use this only to answer a question about other stores.",
    input_schema: schema({ zip: str }, ["zip"]),
    requires: { kind: "supports", capability: "search" },
    allowedIn: ["running"],
    phases: ["planning"],
  },
  search_products: {
    name: "search_products",
    description:
      "Search the store again for one list line, with a better query, when none of its numbered candidates fit. Replaces that line's candidate list; indices refer to the newest list. limit is at most 25.",
    input_schema: schema({ listItemId: str, query: str, limit: int }, ["listItemId", "query"]),
    requires: { kind: "automates", capability: "search" },
    allowedIn: ["running"],
    phases: ["planning"],
  },
  get_product: {
    name: "get_product",
    description: "Show the current details of one candidate of a list line, by its index.",
    input_schema: schema({ listItemId: str, candidateIndex: int }, [
      "listItemId",
      "candidateIndex",
    ]),
    requires: { kind: "automates", capability: "search" },
    allowedIn: ["running"],
    phases: ["planning"],
  },
  choose_product: {
    name: "choose_product",
    description:
      "Choose the product for one list line by its candidate index from the numbered list. quantity is whole units of that product. Writes the proposal only; nothing goes in the cart until the person approves.",
    input_schema: schema(
      { listItemId: str, candidateIndex: int, quantity: { type: "number" }, reason: str },
      ["listItemId", "candidateIndex", "quantity"],
    ),
    requires: { kind: "none" },
    allowedIn: ["running"],
    phases: ["planning"],
  },
  mark_unmatched: {
    name: "mark_unmatched",
    description:
      "Say that no candidate fits a list line, with a one-line reason. The person decides at review.",
    input_schema: schema({ listItemId: str, reason: str }, ["listItemId", "reason"]),
    requires: { kind: "none" },
    allowedIn: ["running"],
    phases: ["planning"],
  },
  request_review: {
    name: "request_review",
    description:
      "Finish choosing and hand the proposed cart to the household for review. Call it once, after every line you were given has a choice or is marked unmatched.",
    input_schema: schema({}, []),
    requires: { kind: "none" },
    allowedIn: ["running"],
    phases: ["planning"],
  },
  add_to_cart: {
    name: "add_to_cart",
    description: "Add an approved line to the retailer cart. Writes the ledger first.",
    input_schema: schema({ runItemId: str }, ["runItemId"]),
    requires: { kind: "automates", capability: "cartAdd" },
    allowedIn: ["running"],
    phases: ["push"],
    needsApproval: true,
  },
  set_quantity: {
    name: "set_quantity",
    description: "Bring an approved line's cart quantity to a new number with a signed delta.",
    input_schema: schema({ runItemId: str, quantity: int }, ["runItemId", "quantity"]),
    requires: { kind: "automates", capability: "cartAdd" },
    allowedIn: ["running"],
    phases: ["push"],
    needsApproval: true,
  },
  remove_from_cart: {
    name: "remove_from_cart",
    description:
      "Take a line this run added back out of the cart (a negative delta where the cart cannot be read).",
    input_schema: schema({ runItemId: str }, ["runItemId"]),
    requires: { kind: "either", capabilities: ["cartRead", "cartAdd"] },
    allowedIn: ["running"],
    phases: ["push"],
    needsApproval: true,
  },
  view_cart: {
    name: "view_cart",
    description: "Read the retailer cart.",
    input_schema: schema({}, []),
    requires: { kind: "automates", capability: "cartRead" },
    allowedIn: ["running", "cart_ready"],
    phases: ["push", "checkout"],
  },
  get_slots: {
    name: "get_slots",
    description: "List pickup or delivery windows.",
    input_schema: schema({}, []),
    requires: { kind: "browser", capability: "slots" },
    allowedIn: ["cart_ready"],
    phases: ["checkout"],
    needsApproval: true,
  },
  select_slot: {
    name: "select_slot",
    description: "Pick one of the windows get_slots returned, by its index.",
    input_schema: schema({ slotIndex: int }, ["slotIndex"]),
    requires: { kind: "browser", capability: "slots" },
    allowedIn: ["cart_ready"],
    phases: ["checkout"],
    needsApproval: true,
  },
  checkout: {
    name: "checkout",
    description:
      "Place the order. Only after the review was approved, and only within the household's policy.",
    input_schema: schema({}, []),
    requires: { kind: "browser", capability: "checkout" },
    allowedIn: ["cart_ready"],
    phases: ["checkout"],
    needsApproval: true,
  },
  finish: {
    name: "finish",
    description: "Close the run: cart_ready (the person pays) or checked_out.",
    input_schema: schema({}, []),
    requires: { kind: "none" },
    allowedIn: ["running", "checking_out"],
    phases: ["push", "checkout"],
  },
};

/** Zod schemas for the tool inputs, with the bounds strict mode cannot carry. */
export const TOOL_INPUTS = {
  find_store: z.object({ zip: z.string().regex(/^\d{5}$/) }).strict(),
  search_products: z
    .object({
      listItemId: z.string().min(1).max(64),
      query: z.string().trim().min(2).max(120),
      limit: z.number().int().optional(),
    })
    .strict(),
  get_product: z
    .object({ listItemId: z.string().min(1).max(64), candidateIndex: z.number().int() })
    .strict(),
  choose_product: z
    .object({
      listItemId: z.string().min(1).max(64),
      candidateIndex: z.number().int(),
      quantity: z.number(),
      reason: z.string().max(2000).optional(),
    })
    .strict(),
  mark_unmatched: z
    .object({ listItemId: z.string().min(1).max(64), reason: z.string().max(2000) })
    .strict(),
  request_review: z.object({}).strict(),
} as const;

/** The Anthropic tool definitions for these names, in this order (stable, so the prefix caches). */
export function toolDefinitions(names: readonly ToolName[]): Array<{
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  strict: true;
}> {
  return names.map((name) => ({
    name,
    description: TOOL_SPECS[name].description,
    input_schema: TOOL_SPECS[name].input_schema,
    strict: true as const,
  }));
}

export type ToolAccess =
  | { ok: true }
  | {
      ok: false;
      error: "not_supported";
      capability: CapabilityName;
      value: Capability;
      hint: string;
    }
  | { ok: false; error: "wrong_state"; status: RunStatus; phase: RunPhase; hint: string }
  | { ok: false; error: "needs_approval"; hint: string };

function capabilityCheck(spec: ToolSpec, caps: Capabilities): ToolAccess {
  const refuse = (capability: CapabilityName): ToolAccess => ({
    ok: false,
    error: "not_supported",
    capability,
    value: caps[capability],
    hint:
      caps[capability] === "handoff"
        ? "This store hands this step to the person. Finish the run and send them the checkout link."
        : `This store cannot do ${capability}. Use the hand-off: finish the run.`,
  });
  switch (spec.requires.kind) {
    case "none":
      return { ok: true };
    case "supports":
      return supports(caps, spec.requires.capability)
        ? { ok: true }
        : refuse(spec.requires.capability);
    case "automates":
      return automates(caps, spec.requires.capability)
        ? { ok: true }
        : refuse(spec.requires.capability);
    case "browser":
      return caps[spec.requires.capability] === "browser"
        ? { ok: true }
        : refuse(spec.requires.capability);
    case "either": {
      const ok = spec.requires.capabilities.some((c) => automates(caps, c));
      return ok ? { ok: true } : refuse(spec.requires.capabilities[0] ?? "cartAdd");
    }
  }
}

/** Capability first, then status and phase, then the review gate. */
export function checkToolAccess(
  name: ToolName,
  caps: Capabilities,
  state: { status: RunStatus; phase: RunPhase; approved: boolean },
): ToolAccess {
  const spec = TOOL_SPECS[name];
  const capability = capabilityCheck(spec, caps);
  if (!capability.ok) return capability;
  if (!spec.allowedIn.includes(state.status) || !spec.phases.includes(state.phase)) {
    return {
      ok: false,
      error: "wrong_state",
      status: state.status,
      phase: state.phase,
      hint: `${name} is not available while the run is ${state.status} (${state.phase}).`,
    };
  }
  if (spec.needsApproval && !state.approved) {
    return {
      ok: false,
      error: "needs_approval",
      hint: "The household has not approved this cart yet.",
    };
  }
  return { ok: true };
}

/** The tools to offer the model now: allowed in this state and supported by this adapter. */
export function availableTools(
  caps: Capabilities,
  state: { status: RunStatus; phase: RunPhase; approved: boolean },
): ToolName[] {
  return TOOL_NAMES.filter((name) => checkToolAccess(name, caps, state).ok);
}

// ---------------------------------------------------------------------------------------
// The planning session: what the planning tools act on
// ---------------------------------------------------------------------------------------

export interface LineState {
  prepared: PreparedLine;
  query: string;
  decision: LineDecision | null;
  /** Bad indices the model sent for this line. One retry, then the line is given up. */
  invalidChoices: number;
  /** The line goes to the model. */
  forModel: boolean;
}

export interface ToolResult {
  ok: boolean;
  /** JSON for the model's tool_result. */
  content: string;
  /** One line for the transcript. */
  summary: string;
}

export interface PlanningSessionOptions {
  adapter: RetailerAdapter;
  store: Store;
  policy: RunPolicy;
  allergies: Parameters<typeof prepareLine>[2]["allergies"];
  transcript: Transcript;
  /** Counts every tool call against max_tool_calls. Throws when the limit is reached. */
  countCall: () => void;
  scoring: (line: ListLine) => ScoringContext & { reference: SubstitutionReference | null };
}

export class ToolLimitError extends Error {
  constructor(limit: number) {
    super(`max_tool_calls reached (${limit})`);
    this.name = "ToolLimitError";
  }
}

/** Formats one line and its candidates for the model. Prices and names exactly as returned. */
export function describeLine(state: LineState): string {
  const { line, ranked } = state.prepared;
  const need =
    line.qty !== null && line.unit
      ? `${line.qty} ${line.unit}`
      : line.qty !== null
        ? `${line.qty}`
        : "some";
  const head = [
    `Line ${line.id}: "${line.displayName}", need ${need}`,
    line.qualifiers.length > 0 ? `must be ${line.qualifiers.join(", ")}` : null,
    line.rawTexts.length > 0
      ? `recipes say: ${line.rawTexts
          .slice(0, 3)
          .map((t) => t.slice(0, 80))
          .join(" | ")}`
      : null,
  ]
    .filter(Boolean)
    .join("; ");
  const rows = ranked.slice(0, MODEL_CANDIDATES).map((c, index) => {
    const price = c.product.promoPrice ?? c.product.price;
    return [
      `  [${index}] ${c.product.name}`,
      c.product.size ?? "size unknown",
      price === null
        ? "no price"
        : `$${price.toFixed(2)}${c.product.soldBy === "WEIGHT" ? "/lb" : ""}`,
      `buy ${c.plan.units}`,
      c.lineTotal === null ? null : `about $${c.lineTotal.toFixed(2)}`,
      c.notes.length > 0 ? c.notes.join(", ") : null,
    ]
      .filter(Boolean)
      .join(" | ");
  });
  return [head, ...(rows.length > 0 ? rows : ["  (no candidates)"])].join("\n");
}

function json(value: unknown): string {
  return JSON.stringify(value);
}

/**
 * Holds the lines and their candidates for one planning phase and runs the planning tools on them.
 * The host's own searches go through `search` too, so every call is in the transcript.
 */
export class PlanningSession {
  readonly lines = new Map<string, LineState>();
  readonly #options: PlanningSessionOptions;

  constructor(options: PlanningSessionOptions) {
    this.#options = options;
  }

  get options(): PlanningSessionOptions {
    return this.#options;
  }

  /** Adds a line with candidates the host already has (a pinned batch lookup). */
  addLine(line: ListLine, products: readonly Product[], query: string): LineState {
    const state: LineState = {
      prepared: this.#prepare(line, products),
      query,
      decision: null,
      invalidChoices: 0,
      forModel: false,
    };
    this.lines.set(line.id, state);
    return state;
  }

  #prepare(line: ListLine, products: readonly Product[]): PreparedLine {
    const scoring = this.#options.scoring(line);
    return prepareLine(line, products, {
      ...scoring,
      policy: this.#options.policy,
      allergies: this.#options.allergies,
    });
  }

  #record(tool: ToolName, by: "host" | "model", input: unknown, result: ToolResult): ToolResult {
    this.#options.transcript.record({
      tool,
      by,
      input,
      output_summary: result.summary,
      ok: result.ok,
    });
    return result;
  }

  #fail(error: string, message: string, summary?: string): ToolResult {
    return { ok: false, content: json({ ok: false, error, message }), summary: summary ?? message };
  }

  /**
   * search_products. The host calls it once per unpinned line; the model may call it again with a
   * better query. Throws RetailerQuotaError so the run can pause.
   */
  async search(
    line: ListLine,
    query: string,
    by: "host" | "model",
    limit: number = SEARCH_LIMIT,
  ): Promise<ToolResult> {
    this.#options.countCall();
    const capped = Math.min(SEARCH_LIMIT, Math.max(1, Math.trunc(limit)));
    const input = { listItemId: line.id, query, limit: capped };
    if (!automates(this.#options.adapter.capabilities, "search")) {
      return this.#record(
        "search_products",
        by,
        input,
        this.#fail("not_supported", "This store has no product search."),
      );
    }
    let products: Product[];
    try {
      products = await this.#options.adapter.searchProducts(query, this.#options.store, {
        limit: capped,
      });
    } catch (err) {
      this.#record("search_products", by, input, {
        ok: false,
        content: "",
        summary:
          err instanceof RetailerQuotaError
            ? "Stopped: the product search quota is spent."
            : "The search failed.",
      });
      throw err;
    }
    const previous = this.lines.get(line.id);
    const state: LineState = {
      prepared: this.#prepare(line, products),
      query,
      decision: by === "model" ? null : (previous?.decision ?? null),
      invalidChoices: previous?.invalidChoices ?? 0,
      forModel: previous?.forModel ?? false,
    };
    this.lines.set(line.id, state);
    const { ranked, excluded } = state.prepared;
    const left = Object.entries(excluded)
      .filter(([, n]) => n > 0)
      .map(([why, n]) => `${why} ${n}`)
      .join(", ");
    const summary = `${products.length} results, ${ranked.length} candidates${left ? ` (left out: ${left})` : ""}.`;
    return this.#record("search_products", by, input, {
      ok: true,
      content: json({ ok: true, line: describeLine(state) }),
      summary,
    });
  }

  /** get_product: the current details of one candidate. */
  getProduct(listItemId: string, candidateIndex: number, by: "host" | "model"): ToolResult {
    this.#options.countCall();
    const input = { listItemId, candidateIndex };
    const state = this.lines.get(listItemId);
    const candidate = state?.prepared.ranked[candidateIndex];
    if (!state || !candidate || candidateIndex >= MODEL_CANDIDATES) {
      return this.#record(
        "get_product",
        by,
        input,
        this.#fail("unknown_candidate", `No candidate ${candidateIndex} for line ${listItemId}.`),
      );
    }
    const p = candidate.product;
    return this.#record("get_product", by, input, {
      ok: true,
      content: json({
        ok: true,
        candidateIndex,
        name: p.name,
        brand: p.brand,
        size: p.size,
        price: p.price,
        promoPrice: p.promoPrice,
        soldBy: p.soldBy,
        stock: p.stockLevel,
        buy: candidate.plan.units,
      }),
      summary: `Details of candidate ${candidateIndex}.`,
    });
  }

  /**
   * choose_product. The index must be one this session offered for the line; the product is
   * looked up from the adapter's own result and checked against it before it is recorded.
   */
  choose(
    input: {
      listItemId: string;
      candidateIndex: number;
      quantity: number;
      reason?: string | undefined;
    },
    by: "host" | "model",
  ): ToolResult {
    this.#options.countCall();
    const state = this.lines.get(input.listItemId);
    const logged = {
      listItemId: input.listItemId,
      candidateIndex: input.candidateIndex,
      quantity: input.quantity,
    };
    if (!state) {
      return this.#record(
        "choose_product",
        by,
        logged,
        this.#fail("unknown_line", `There is no list line ${input.listItemId}.`),
      );
    }
    const offered = state.prepared.ranked.slice(0, by === "model" ? MODEL_CANDIDATES : undefined);
    let product: Product;
    try {
      const ref = pickCandidate(
        this.#options.store,
        offered.map((c) => c.product),
        input.candidateIndex,
      );
      product = assertRefInCandidates(
        ref,
        offered.map((c) => c.product),
      );
    } catch {
      state.invalidChoices += 1;
      if (state.invalidChoices >= 2) {
        state.decision = {
          kind: "unmatched",
          by,
          reason: "The model's choices were not on the candidate list.",
          flag: {
            kind: "low_confidence",
            detail: "No valid choice was made for this line. Pick one yourself.",
          },
        };
        return this.#record(
          "choose_product",
          by,
          logged,
          this.#fail(
            "unknown_candidate",
            "That index is not on the list. The line is left for the person.",
            "Invalid index again: the line is left unmatched.",
          ),
        );
      }
      return this.#record(
        "choose_product",
        by,
        logged,
        this.#fail(
          "unknown_candidate",
          `candidateIndex must be 0 to ${Math.max(0, offered.length - 1)} for line ${input.listItemId}. Try once more.`,
          "Invalid index: one retry left.",
        ),
      );
    }
    const index = state.prepared.ranked.findIndex((c) => c.product.id === product.id);
    const candidate = state.prepared.ranked[index];
    if (!candidate) {
      return this.#record(
        "choose_product",
        by,
        logged,
        this.#fail("unknown_candidate", "That candidate is gone."),
      );
    }
    // Policies, again: the list was narrowed by them, and a stale list must not slip through.
    const substitution = checkSubstitution(this.#options.policy, state.prepared.reference, product);
    if (!substitution.allowed) {
      return this.#record(
        "choose_product",
        by,
        logged,
        this.#fail(
          "policy",
          substitution.reason ?? "The substitution policy refuses this product.",
        ),
      );
    }
    const units = candidate.plan.known
      ? candidate.plan.units
      : Math.min(24, Math.max(1, Math.round(Number.isFinite(input.quantity) ? input.quantity : 1)));
    state.decision = {
      kind: "chosen",
      index,
      units,
      by,
      reason: input.reason?.slice(0, 500) ?? null,
      lowConfidence: null,
    };
    return this.#record("choose_product", by, logged, {
      ok: true,
      content: json({
        ok: true,
        listItemId: input.listItemId,
        candidateIndex: index,
        quantity: units,
      }),
      summary: `Chose candidate ${index}, ${units} unit${units === 1 ? "" : "s"}.`,
    });
  }

  /** mark_unmatched */
  markUnmatched(input: { listItemId: string; reason: string }, by: "host" | "model"): ToolResult {
    this.#options.countCall();
    const state = this.lines.get(input.listItemId);
    const logged = { listItemId: input.listItemId };
    if (!state) {
      return this.#record(
        "mark_unmatched",
        by,
        logged,
        this.#fail("unknown_line", `There is no list line ${input.listItemId}.`),
      );
    }
    state.decision = {
      kind: "unmatched",
      by,
      reason: input.reason.slice(0, 500) || "No candidate fits.",
    };
    return this.#record("mark_unmatched", by, logged, {
      ok: true,
      content: json({ ok: true, listItemId: input.listItemId }),
      summary: "Marked unmatched.",
    });
  }

  /** The model lines still without a decision. */
  undecided(): string[] {
    return [...this.lines.values()]
      .filter((state) => state.forModel && state.decision === null)
      .map((state) => state.prepared.line.id);
  }

  /** request_review: allowed once every model line is decided, or on the second ask. */
  requestReview(by: "host" | "model", force: boolean): ToolResult {
    this.#options.countCall();
    const open = this.undecided();
    if (open.length > 0 && !force) {
      return this.#record(
        "request_review",
        by,
        {},
        this.#fail(
          "lines_open",
          `These lines still need choose_product or mark_unmatched: ${open.join(", ")}.`,
          `${open.length} lines still open.`,
        ),
      );
    }
    return this.#record(
      "request_review",
      by,
      {},
      {
        ok: true,
        content: json({ ok: true }),
        summary:
          open.length > 0
            ? `Review requested with ${open.length} lines left to code.`
            : "Review requested.",
      },
    );
  }
}
