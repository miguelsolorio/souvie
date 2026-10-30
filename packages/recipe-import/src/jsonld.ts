// Reads `recipeInstructions` from a page's JSON-LD (WS02). recipe-scrapers returns both the `name`
// and the `text` of every HowToStep as separate steps, so "Sauce" and "Pulse the ingredients..."
// become two steps. This plugin runs ahead of the library's own schema.org reader, keeps the text,
// and keeps HowToSection names as group names.

import type { CheerioAPI } from "cheerio";
import { ExtractorPlugin, type RecipeFields } from "recipe-scrapers";
import { findJsonLdRecipe } from "./html.ts";

export interface InstructionGroup {
  name: string | null;
  items: Array<{ value: string }>;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** The type of a node as a lowercase list: "HowToStep" or ["HowToStep", "Thing"]. */
function typesOf(node: Record<string, unknown>): string[] {
  const type = node["@type"];
  const list = Array.isArray(type) ? type : [type];
  return list.filter((t): t is string => typeof t === "string").map((t) => t.toLowerCase());
}

/** Steps of one node: a string, a step, a direction, or a section's list. */
function collect(value: unknown, into: string[], groups: InstructionGroup[], depth = 0): void {
  if (depth > 5 || value === null || value === undefined) return;
  if (typeof value === "string") {
    // One string may hold several lines, one step per line.
    for (const line of value.split(/\r?\n/)) if (line.trim()) into.push(line.trim());
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collect(item, into, groups, depth + 1);
    return;
  }
  if (typeof value !== "object") return;

  const node = value as Record<string, unknown>;
  const types = typesOf(node);
  if (types.includes("howtosection")) {
    const inner: string[] = [];
    collect(node.itemListElement, inner, groups, depth + 1);
    if (inner.length > 0) {
      groups.push({ name: text(node.name) || null, items: inner.map((v) => ({ value: v })) });
    }
    return;
  }
  // A step's `text` is the instruction; its `name` is a short label. Use the label only when
  // there is no text.
  const instruction = text(node.text) || text(node.name);
  if (instruction) into.push(instruction);
  else if (node.itemListElement) collect(node.itemListElement, into, groups, depth + 1);
}

/** Instruction groups from a Recipe node, or null when it has none. */
export function instructionGroups(recipe: Record<string, unknown>): InstructionGroup[] | null {
  const loose: string[] = [];
  const sections: InstructionGroup[] = [];
  collect(recipe.recipeInstructions, loose, sections);

  const groups: InstructionGroup[] = [];
  if (loose.length > 0) groups.push({ name: null, items: loose.map((value) => ({ value })) });
  groups.push(...sections);
  return groups.length > 0 ? groups : null;
}

/** Supplies `instructions` from JSON-LD ahead of the library's own schema.org plugin (priority 90). */
export class JsonLdInstructionsPlugin extends ExtractorPlugin {
  name = "JsonLdInstructionsPlugin";
  priority = 95;
  private readonly groups: InstructionGroup[] | null;

  constructor($: CheerioAPI) {
    super($);
    const recipe = findJsonLdRecipe($);
    this.groups = recipe ? instructionGroups(recipe) : null;
  }

  supports(field: string): boolean {
    return field === "instructions" && this.groups !== null;
  }

  extract<Key extends keyof RecipeFields>(): RecipeFields[Key] {
    return this.groups as unknown as RecipeFields[Key];
  }
}
