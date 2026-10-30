// ProductRef: the only way agent tool outputs name a product (R13, docs/06-risks.md).
//
// The model never emits a product id or UPC. It picks a candidate by index from a list the
// adapter returned, and code turns that index into a ProductRef. A ProductRef can only be minted
// from a Product an adapter returned, so an invented id cannot reach a cart call.
import { RetailerError } from "./errors.ts";
import type { CartItemDelta, Modality, Product, RetailerId, Store } from "./types.ts";

declare const productRefBrand: unique symbol;

export interface ProductRef {
  readonly retailer: RetailerId;
  readonly storeId: string;
  readonly productId: string;
  readonly upc: string | null;
  readonly [productRefBrand]: true;
}

/** Mints a ref from a product an adapter returned for `store`. */
export function productRef(store: Store, product: Product): ProductRef {
  return Object.freeze({
    retailer: store.retailer,
    storeId: store.id,
    productId: product.id,
    upc: product.upc,
  }) as ProductRef;
}

/** The candidate the model chose by index. Throws when the index is not one we offered. */
export function pickCandidate(
  store: Store,
  candidates: readonly Product[],
  index: number,
): ProductRef {
  const product = Number.isInteger(index) ? candidates[index] : undefined;
  if (!product) {
    throw new RetailerError(
      store.retailer,
      "unknown_candidate",
      `Candidate ${index} is not in the list of ${candidates.length}`,
    );
  }
  return productRef(store, product);
}

/**
 * Checks a ref against the candidates for its store and returns the matching product. Use it on
 * every ref that crosses a boundary (a stored run item, a resumed run) before a cart call.
 */
export function assertRefInCandidates(ref: ProductRef, candidates: readonly Product[]): Product {
  const match = candidates.find((p) => p.id === ref.productId && p.upc === ref.upc);
  if (!match) {
    throw new RetailerError(
      ref.retailer,
      "unknown_product",
      `Product ${ref.productId} is not among the candidates for store ${ref.storeId}`,
    );
  }
  return match;
}

export function toCartItemDelta(
  ref: ProductRef,
  quantityDelta: number,
  modality?: Modality,
): CartItemDelta {
  return {
    productId: ref.productId,
    upc: ref.upc,
    quantityDelta,
    ...(modality ? { modality } : {}),
  };
}
