import { z } from "zod";

/**
 * The policy a household sets for one shopping run (orchestrator, CCR6, 2026-10-31). It is stored
 * as is in `shopping_runs.policy`, so the keys are snake_case like `ProfilePreferences`. Every rule
 * here is enforced in code by the agent host, never by the model (docs/03 §8).
 */
export const RunSubstitution = z.enum(["none", "same_brand", "any"]);
export type RunSubstitution = z.infer<typeof RunSubstitution>;

export const RunPolicy = z
  .object({
    /** Ceiling on the proposed subtotal in USD. Null means no cap. */
    budget_cap_usd: z.number().positive().nullable().default(null),
    /** A single line over this many USD is flagged for review. Null means no ceiling. */
    per_item_ceiling_usd: z.number().positive().nullable().default(null),
    substitution: RunSubstitution.default("same_brand"),
    /** Tier 3 connections only: check out without a tap, under `auto_checkout_cap_usd`. */
    auto_checkout: z.boolean().default(false),
    auto_checkout_cap_usd: z.number().positive().nullable().default(null),
    max_tool_calls: z.number().int().positive().max(1000).default(200),
    max_wall_clock_seconds: z.number().int().positive().max(3600).default(900),
  })
  .strict()
  .refine((p) => !p.auto_checkout || p.auto_checkout_cap_usd !== null, {
    message: "auto_checkout requires auto_checkout_cap_usd",
    path: ["auto_checkout_cap_usd"],
  });
export type RunPolicy = z.infer<typeof RunPolicy>;

/** The policy a run gets when the household set nothing. */
export const DEFAULT_RUN_POLICY: RunPolicy = RunPolicy.parse({});
