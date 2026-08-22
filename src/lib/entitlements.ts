// Billing boundary — client side.
//
// This is a UI affordance, NOT a security boundary. It exists so users aren't
// offered actions their subscription can't perform, and so the paywall can be
// reached from anywhere. Real enforcement lives in the edge functions
// (has_active_entitlement) and in the nightly cron, both of which return 402
// or silently skip regardless of what this file believes.
//
// The state is cached in memory and mirrored to localStorage so a cold start
// with no network doesn't flash a paywall at a paying subscriber.

import {
  readEntitlement,
  billingAvailable,
  NO_ENTITLEMENT,
  type EntitlementState,
} from "./billing";

export type GatedFeature = "entry_generation" | "synthesis";

const CACHE_KEY = "ponder.entitlement.v1";
/** How long a cached "yes" is trusted offline before we insist on a refresh. */
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export class EntitlementError extends Error {
  constructor(public feature: GatedFeature) {
    super("Your Ponder subscription has ended.");
    this.name = "EntitlementError";
  }
}

/** Thrown by api.ts when the server returns 402 — the authoritative answer. */
export class SubscriptionRequiredError extends Error {
  constructor(message?: string) {
    super(message ?? "An active subscription is required.");
    this.name = "SubscriptionRequiredError";
  }
}

let current: EntitlementState = NO_ENTITLEMENT;
let loaded = false;
const listeners = new Set<(s: EntitlementState) => void>();

// ------------------------------------------------------------------ cache

function readCache(): EntitlementState | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const { state, at } = JSON.parse(raw) as { state: EntitlementState; at: number };
    if (!at || Date.now() - at > CACHE_TTL_MS) return null;
    // Never trust a cached "yes" past its own expiry date.
    if (state.entitled && state.expiresAt && new Date(state.expiresAt) < new Date()) {
      return null;
    }
    return state;
  } catch {
    return null;
  }
}

function writeCache(state: EntitlementState): void {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ state, at: Date.now() }));
  } catch {
    /* private mode / quota — the cache is best-effort */
  }
}

function publish(state: EntitlementState): void {
  current = state;
  loaded = true;
  writeCache(state);
  for (const fn of listeners) fn(state);
}

// ------------------------------------------------------------------- api

/**
 * Refresh from the store and the server. Call after login, after a purchase,
 * on resume, and whenever a 402 comes back.
 *
 * On failure the previous known state is kept rather than downgraded — a
 * flaky network must not lock a subscriber out of their own journal.
 */
export async function refreshEntitlement(): Promise<EntitlementState> {
  try {
    const next = await readEntitlement();
    publish(next);
    return next;
  } catch (e) {
    console.warn("entitlement refresh failed", e);
    if (!loaded) {
      const cached = readCache();
      if (cached) publish(cached);
    }
    return current;
  }
}

/** Synchronous read of the last known state — for render paths. */
export function entitlement(): EntitlementState {
  if (!loaded) {
    const cached = readCache();
    if (cached) {
      current = cached;
      loaded = true;
    }
  }
  return current;
}

/** Whether the entitlement has been resolved at least once this session. */
export function entitlementLoaded(): boolean {
  return loaded;
}

export function onEntitlementChange(fn: (s: EntitlementState) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Clear on sign-out / account swap so the next account starts clean. */
export function resetEntitlement(): void {
  loaded = false;
  current = NO_ENTITLEMENT;
  try {
    localStorage.removeItem(CACHE_KEY);
  } catch {
    /* ignore */
  }
}

// ------------------------------------------------------------------ gates

/**
 * Whether the current user may use a gated feature.
 *
 * Browser dev has no StoreKit, so billing falls back to the server row alone.
 * VITE_BILLING_BYPASS exists for local UI work; it is compiled out of release
 * builds because import.meta.env values are inlined at build time, and it has
 * no effect on the server gate either way.
 */
export function isEntitled(_feature: GatedFeature): boolean {
  if (import.meta.env.DEV && import.meta.env.VITE_BILLING_BYPASS === "1") {
    return true;
  }
  return entitlement().entitled;
}

export function assertEntitled(feature: GatedFeature): void {
  if (!isEntitled(feature)) throw new EntitlementError(feature);
}

/** True when the app should show the paywall instead of its normal content. */
export function shouldShowPaywall(): boolean {
  if (import.meta.env.DEV && import.meta.env.VITE_BILLING_BYPASS === "1") {
    return false;
  }
  return loaded && !current.entitled;
}

export { billingAvailable };
export type { EntitlementState };
