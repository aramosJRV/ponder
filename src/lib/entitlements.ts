// Billing boundary seam.
//
// v1 is a single-user personal tool with no paywall, so every feature is
// entitled. But entry generation and synthesis are the two AI-cost features a
// future paid tier would gate, so all such calls funnel through assertEntitled()
// here. When RevenueCat lands, map each GatedFeature to an entitlement id and
// check `Purchases.getCustomerInfo()` in isEntitled() — nothing else changes.
//
// (Real enforcement will ultimately live server-side in the edge functions too;
// this client seam keeps the boundary explicit and gives a single place to gate
// the UI so users aren't offered actions their tier can't perform.)

export type GatedFeature = "entry_generation" | "synthesis";

export class EntitlementError extends Error {
  constructor(public feature: GatedFeature) {
    super("This feature isn't available on your plan.");
    this.name = "EntitlementError";
  }
}

/** Whether the current user may use a gated feature. v1: always true. */
export function isEntitled(_feature: GatedFeature): boolean {
  return true;
}

/** Throws EntitlementError when the feature is gated off. Call at the start of
 * any billing-relevant action. */
export function assertEntitled(feature: GatedFeature): void {
  if (!isEntitled(feature)) throw new EntitlementError(feature);
}
