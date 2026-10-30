// Prompt registry (docs/03-ai-design.md §1: prompts are versioned and every ai_runs row records
// the version). A prompt is a name, an integer version, and the text builders. Changing the text
// of a shipped prompt means a new version file next to the old one, never an edit in place, so
// ai_runs rows keep meaning what they said and evals can compare versions.
//
// The id, "<name>.v<version>", is what goes in ai_runs.prompt_version.

import type { ModelId } from "../client.ts";

/** What the registry knows about a prompt without its text builders. */
export interface PromptMeta {
  name: string;
  version: number;
  /** "<name>.v<version>". */
  id: string;
  /** The ai_runs.kind this prompt is logged under. */
  kind: string;
  /** The model the prompt was written and evaluated for. */
  model: ModelId;
}

export interface PromptDef<Vars> extends PromptMeta {
  /** The stable instructions. Identical on every call, so it can be cached. */
  system(): string;
  /** The per-call message. Untrusted content goes here. */
  user(vars: Vars): string;
}

const REGISTRY = new Map<string, PromptMeta>();

export function promptId(name: string, version: number): string {
  return `${name}.v${version}`;
}

/** Registers a prompt. Throws on a duplicate id, which means two files claim the same version. */
export function definePrompt<Vars>(def: {
  name: string;
  version: number;
  kind: string;
  model: ModelId;
  system: () => string;
  user: (vars: Vars) => string;
}): PromptDef<Vars> {
  if (!/^[a-z][a-z0-9-]*$/.test(def.name)) {
    throw new Error(`prompt name must be lowercase kebab-case: ${def.name}`);
  }
  if (!Number.isInteger(def.version) || def.version < 1) {
    throw new Error(`prompt version must be a positive integer: ${def.name}`);
  }
  const id = promptId(def.name, def.version);
  if (REGISTRY.has(id)) throw new Error(`prompt ${id} is already registered`);
  const meta: PromptMeta = {
    name: def.name,
    version: def.version,
    id,
    kind: def.kind,
    model: def.model,
  };
  REGISTRY.set(id, meta);
  return { ...meta, system: def.system, user: def.user };
}

export function getPromptMeta(id: string): PromptMeta | undefined {
  return REGISTRY.get(id);
}

/** The highest registered version of a prompt, as an id, or undefined for an unknown name. */
export function latestPromptId(name: string): string | undefined {
  let latest: PromptMeta | undefined;
  for (const meta of REGISTRY.values()) {
    if (meta.name === name && (!latest || meta.version > latest.version)) latest = meta;
  }
  return latest?.id;
}

export function listPromptIds(): string[] {
  return [...REGISTRY.keys()].sort();
}
