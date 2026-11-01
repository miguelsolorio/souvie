// Adapter registry. Hosts (the worker, an Edge Function, a test) build adapter instances with
// their own credentials and register them; the agent and the UI look them up by retailer id and
// never import a concrete adapter.
import { RETAILER_CAPABILITIES } from "./capabilities.ts";
import { RetailerNotSupportedError } from "./errors.ts";
import { type Capabilities, RETAILER_IDS, type RetailerAdapter, type RetailerId } from "./types.ts";

export interface AdapterListing {
  id: RetailerId;
  /** The registered adapter's capabilities, or the documented row when none is registered. */
  capabilities: Capabilities;
  /** Registered and not disabled. */
  available: boolean;
}

/**
 * Runs inside getAdapter before an adapter is handed out. It may throw RetailerNotSupportedError
 * (the Tier 3 gate, browser/gating.ts, throws Tier3GateError) and must not do I/O: decide first,
 * then install. WS08 added it; with no gate set, getAdapter behaves as before.
 */
export type AdapterGate = (id: RetailerId) => void;

export class AdapterRegistry {
  readonly #adapters = new Map<RetailerId, RetailerAdapter>();
  readonly #disabled = new Set<RetailerId>();
  #gate: AdapterGate | null = null;

  /** Registers an adapter, replacing any earlier one for the same retailer. */
  register(adapter: RetailerAdapter): void {
    this.#adapters.set(adapter.id, adapter);
  }

  unregister(id: RetailerId): void {
    this.#adapters.delete(id);
  }

  /** A kill switch (for example a PostHog flag) can turn an adapter off without unregistering it. */
  setEnabled(id: RetailerId, enabled: boolean): void {
    if (enabled) this.#disabled.delete(id);
    else this.#disabled.add(id);
  }

  isAdapterAvailable(id: RetailerId): boolean {
    return this.#adapters.has(id) && !this.#disabled.has(id);
  }

  /** Sets (or, with null, removes) the pre-construct hook getAdapter calls. One gate at a time. */
  setGate(gate: AdapterGate | null): void {
    this.#gate = gate;
  }

  getGate(): AdapterGate | null {
    return this.#gate;
  }

  /**
   * The adapter for `id`. Throws RetailerNotSupportedError when none is registered or it is off,
   * or whatever the gate throws when a gate is set.
   */
  getAdapter(id: RetailerId): RetailerAdapter {
    this.#gate?.(id);
    const adapter = this.#adapters.get(id);
    if (!adapter || this.#disabled.has(id)) {
      throw new RetailerNotSupportedError(id, "adapter", `No ${id} adapter is available`);
    }
    return adapter;
  }

  /** Every known retailer, in a stable order, with what it can do and whether it is ready. */
  listAdapters(): AdapterListing[] {
    return RETAILER_IDS.map((id) => {
      const adapter = this.#adapters.get(id);
      return {
        id,
        capabilities: { ...(adapter?.capabilities ?? RETAILER_CAPABILITIES[id]) },
        available: this.isAdapterAvailable(id),
      };
    });
  }

  clear(): void {
    this.#adapters.clear();
    this.#disabled.clear();
    this.#gate = null;
  }
}

/** The process-wide registry the functions below use. */
export const defaultRegistry = new AdapterRegistry();

export function registerAdapter(adapter: RetailerAdapter): void {
  defaultRegistry.register(adapter);
}

export function getAdapter(id: RetailerId): RetailerAdapter {
  return defaultRegistry.getAdapter(id);
}

export function isAdapterAvailable(id: RetailerId): boolean {
  return defaultRegistry.isAdapterAvailable(id);
}

export function listAdapters(): AdapterListing[] {
  return defaultRegistry.listAdapters();
}
