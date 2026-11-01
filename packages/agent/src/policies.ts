// Policies enforced in code, never in the prompt (docs/03-ai-design.md §8, docs/05 §Money).
//
// RunPolicy itself is the orchestrator's contract (CCR6, @mp/core run.ts). This module applies it:
//   * substitution: none | same_brand | any, relative to the household's pinned product
//   * per_item_ceiling_usd: a line over it is flagged for review
//   * budget_cap_usd: a proposed cart over it is flagged for review, and an approved cart over it
//     is never pushed
//   * auto_checkout: only on a browser checkout, only after the review gate, only under the cap
//   * max_tool_calls and max_wall_clock_seconds: the loop's limits
// The model cannot change a policy. A tool call that breaks one is refused with the reason.
import { DEFAULT_RUN_POLICY, RunPolicy } from "@mp/core";
import type { Capabilities, Product } from "@mp/retailers";
import type { ItemFlag, RunFlag } from "./types.ts";

export class PolicyViolation extends Error {
  readonly rule: string;

  constructor(rule: string, message: string) {
    super(message);
    this.name = "PolicyViolation";
    this.rule = rule;
  }
}

/**
 * The run's policy from shopping_runs.policy. A stored policy that fails the schema stops the
 * run (fail closed): enqueue_shopping_run validates it, so a bad one means someone wrote the row
 * by hand.
 */
export function resolvePolicy(raw: unknown): RunPolicy {
  if (raw === null || raw === undefined) return DEFAULT_RUN_POLICY;
  const parsed = RunPolicy.safeParse(raw);
  if (!parsed.success) {
    throw new PolicyViolation(
      "invalid_policy",
      `The run's policy is not valid: ${parsed.error.message}`,
    );
  }
  return parsed.data;
}

/** The product a substitution is measured against: the household's pinned choice. */
export interface SubstitutionReference {
  productId: string;
  /** The pinned product's brand, as the retailer returns it today. Null when unknown. */
  brand: string | null;
  /**
   * The pinned product's name as the household confirmed it (product_matches.product_name). When
   * the store no longer returns the product, a candidate whose brand starts this name is the
   * same brand ("Northfork Creamery Pasture Eggs" and brand "Northfork Creamery").
   */
  name?: string | null;
}

export interface SubstitutionVerdict {
  allowed: boolean;
  /** True when the candidate is not the reference product. */
  substitution: boolean;
  /** True when the candidate's brand differs from the reference's (or cannot be compared). */
  crossesBrand: boolean;
  reason: string | null;
}

function sameBrand(a: string | null, b: string | null): boolean {
  return a !== null && b !== null && a.trim().toLowerCase() === b.trim().toLowerCase();
}

/**
 * Whether `candidate` may stand in for the reference product under the policy. With no reference
 * (nothing pinned) every candidate is a first choice, not a substitution.
 *
 *   none        only the pinned product itself
 *   same_brand  the pinned product, or another product of the same brand
 *   any         anything the scorer ranks
 */
export function checkSubstitution(
  policy: Pick<RunPolicy, "substitution">,
  reference: SubstitutionReference | null,
  candidate: Pick<Product, "id" | "brand">,
): SubstitutionVerdict {
  if (!reference || candidate.id === reference.productId) {
    return { allowed: true, substitution: false, crossesBrand: false, reason: null };
  }
  const namedBrand =
    reference.brand === null &&
    candidate.brand !== null &&
    candidate.brand.trim().length > 0 &&
    (reference.name ?? "")
      .trim()
      .toLowerCase()
      .startsWith(`${candidate.brand.trim().toLowerCase()} `);
  const crossesBrand = !(sameBrand(reference.brand, candidate.brand) || namedBrand);
  switch (policy.substitution) {
    case "none":
      return {
        allowed: false,
        substitution: true,
        crossesBrand,
        reason: "The household allows no substitutes for its pinned product.",
      };
    case "same_brand":
      return crossesBrand
        ? {
            allowed: false,
            substitution: true,
            crossesBrand,
            reason:
              reference.brand === null
                ? "The pinned product's brand could not be confirmed, and only the same brand is allowed."
                : "Only the pinned product's brand is allowed as a substitute.",
          }
        : { allowed: true, substitution: true, crossesBrand: false, reason: null };
    case "any":
      return { allowed: true, substitution: true, crossesBrand, reason: null };
  }
}

function money(value: number): string {
  return `$${value.toFixed(2)}`;
}

/** A line whose total is over the per-item ceiling needs the person's call. */
export function itemCeilingFlag(
  policy: Pick<RunPolicy, "per_item_ceiling_usd">,
  lineTotalUsd: number | null,
): ItemFlag | null {
  const ceiling = policy.per_item_ceiling_usd;
  if (ceiling === null || lineTotalUsd === null || lineTotalUsd <= ceiling) return null;
  return {
    kind: "over_item_ceiling",
    detail: `This line is ${money(lineTotalUsd)}, over the ${money(ceiling)} limit for one item.`,
  };
}

/** A proposed cart over the budget cap goes to review with a budget flag. */
export function budgetFlag(
  policy: Pick<RunPolicy, "budget_cap_usd">,
  subtotalUsd: number,
): RunFlag | null {
  const cap = policy.budget_cap_usd;
  if (cap === null || subtotalUsd <= cap) return null;
  return {
    kind: "budget",
    detail: `The cart is ${money(subtotalUsd)}, over the ${money(cap)} budget. Remove items or lower quantities to approve it.`,
  };
}

/** Throws when an approved cart is over the cap. The push phase calls it before any cart write. */
export function assertWithinBudget(
  policy: Pick<RunPolicy, "budget_cap_usd">,
  subtotalUsd: number,
): void {
  const flag = budgetFlag(policy, subtotalUsd);
  if (flag) throw new PolicyViolation("budget_cap_usd", flag.detail);
}

/**
 * Whether checkout may run without a tap: a browser checkout (Tier 3), the review gate passed,
 * auto_checkout on, and the approved subtotal under its cap. Everything else waits for the person.
 */
export function canAutoCheckout(
  policy: Pick<RunPolicy, "auto_checkout" | "auto_checkout_cap_usd" | "budget_cap_usd">,
  capabilities: Pick<Capabilities, "checkout">,
  input: { approved: boolean; subtotalUsd: number },
): boolean {
  if (capabilities.checkout !== "browser" || !input.approved || !policy.auto_checkout) return false;
  const cap = policy.auto_checkout_cap_usd;
  if (cap === null || input.subtotalUsd > cap) return false;
  return policy.budget_cap_usd === null || input.subtotalUsd <= policy.budget_cap_usd;
}

/** Round to cents the way prices are shown. */
export function cents(value: number): number {
  return Math.round(value * 100) / 100;
}

export interface RunLimits {
  maxToolCalls: number;
  /** Epoch milliseconds after which the loop stops. */
  deadline: number;
}

export function limitsOf(
  policy: Pick<RunPolicy, "max_tool_calls" | "max_wall_clock_seconds">,
  startedAt: number,
): RunLimits {
  return {
    maxToolCalls: policy.max_tool_calls,
    deadline: startedAt + policy.max_wall_clock_seconds * 1000,
  };
}
