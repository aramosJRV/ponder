// RevenueCat integration.
//
// Two sources of truth, deliberately:
//
//   * StoreKit / Play Billing, read via RevenueCat's CustomerInfo. Instant,
//     works offline, and is what the UI reacts to — a user who has just paid
//     must not stare at a paywall while a webhook lands.
//   * public.subscriptions, written by the rc-webhook edge function. This is
//     what the edge functions and the nightly cron actually enforce, because
//     the client can be patched and the server cannot.
//
// They converge within seconds. syncEntitlement() below bridges the gap after
// a purchase so the first generate call doesn't come back 402.
//
// Products are NOT hardcoded here. Prices, the 7-day trial and the product id
// all live in the RevenueCat "default" offering, so changing the price later
// is a dashboard edit and not an app release.

import { Capacitor } from "@capacitor/core";
import {
  Purchases,
  LOG_LEVEL,
  type CustomerInfo,
  type PurchasesOffering,
  type PurchasesPackage,
} from "@revenuecat/purchases-capacitor";
import { supabase } from "./supabase";

/** Entitlement identifier configured in RevenueCat. */
export const ENTITLEMENT_ID = "pro";

const IOS_KEY = import.meta.env.VITE_RC_IOS_KEY as string | undefined;
const ANDROID_KEY = import.meta.env.VITE_RC_ANDROID_KEY as string | undefined;

export interface EntitlementState {
  entitled: boolean;
  /** Where the answer came from — useful when debugging a stuck paywall. */
  source: "store" | "server" | "none";
  expiresAt: string | null;
  /** True while the 7-day introductory offer is running. */
  inTrial: boolean;
  /** False once auto-renew is switched off; access continues until expiresAt. */
  willRenew: boolean;
  /** Deep link to the platform's subscription management screen. */
  managementUrl: string | null;
  /** Store reported a payment problem; RevenueCat is in its grace window. */
  billingIssue: boolean;
}

export const NO_ENTITLEMENT: EntitlementState = {
  entitled: false,
  source: "none",
  expiresAt: null,
  inTrial: false,
  willRenew: false,
  managementUrl: null,
  billingIssue: false,
};

export class PurchaseCancelledError extends Error {
  constructor() {
    super("Purchase cancelled");
    this.name = "PurchaseCancelledError";
  }
}

// --------------------------------------------------------------- lifecycle

let configuredFor: string | null = null;

export function billingAvailable(): boolean {
  return Capacitor.isNativePlatform();
}

/**
 * Configure RevenueCat with the Supabase user id as the RC app user id.
 *
 * Using our own id rather than RevenueCat's anonymous one is what lets the
 * webhook map an event straight onto a row in public.subscriptions. It also
 * means restoring on a new device attaches the purchase to whichever account
 * is signed in — which is exactly why the paywall requires an email-backed
 * account first (see Paywall.tsx).
 *
 * Safe to call repeatedly; re-logs in only when the user actually changes.
 */
export async function configureBilling(userId: string): Promise<void> {
  if (!billingAvailable()) return;
  const apiKey = Capacitor.getPlatform() === "ios" ? IOS_KEY : ANDROID_KEY;
  if (!apiKey) {
    console.warn("RevenueCat API key missing for this platform — billing disabled");
    return;
  }

  if (configuredFor === null) {
    if (import.meta.env.DEV) {
      await Purchases.setLogLevel({ level: LOG_LEVEL.DEBUG });
    }
    await Purchases.configure({ apiKey, appUserID: userId });
    configuredFor = userId;
    return;
  }

  if (configuredFor !== userId) {
    // Account swapped on this device (restore-by-email). Move the RC identity
    // with it, otherwise the purchase stays attached to the old account.
    await Purchases.logIn({ appUserID: userId });
    configuredFor = userId;
  }
}

// -------------------------------------------------------------- reading it

function fromCustomerInfo(info: CustomerInfo): EntitlementState {
  const ent = info.entitlements.active[ENTITLEMENT_ID];
  if (!ent) {
    return { ...NO_ENTITLEMENT, managementUrl: info.managementURL ?? null };
  }
  return {
    entitled: true,
    source: "store",
    expiresAt: ent.expirationDate ?? null,
    inTrial: ent.periodType === "TRIAL",
    willRenew: ent.willRenew,
    managementUrl: info.managementURL ?? null,
    billingIssue: ent.billingIssueDetectedAt != null,
  };
}

/** Ask the store (via RevenueCat). Cached by the SDK, so cheap and offline-safe. */
export async function readStoreEntitlement(): Promise<EntitlementState | null> {
  if (!billingAvailable() || configuredFor === null) return null;
  try {
    const { customerInfo } = await Purchases.getCustomerInfo();
    return fromCustomerInfo(customerInfo);
  } catch (e) {
    console.warn("getCustomerInfo failed", e);
    return null;
  }
}

/**
 * Ask the database — what the edge functions will actually enforce.
 *
 * Throws on a query error rather than returning "not entitled". The
 * distinction matters: no rows means the user genuinely has no subscription,
 * but a failed query means we don't know, and refreshEntitlement() must keep
 * the last known state instead of downgrading a paying subscriber to a
 * paywall because their train went into a tunnel.
 */
export async function readServerEntitlement(): Promise<EntitlementState> {
  const { data, error } = await supabase.rpc("my_entitlement");
  if (error) throw error;
  if (!data?.length) return NO_ENTITLEMENT;
  const row = data[0] as {
    entitled: boolean;
    expires_at: string | null;
    period_type: string | null;
    unsubscribe_detected_at: string | null;
    billing_issue_detected_at: string | null;
  };
  return {
    entitled: Boolean(row.entitled),
    source: "server",
    expiresAt: row.expires_at,
    inTrial: row.period_type === "TRIAL",
    willRenew: row.unsubscribe_detected_at == null,
    managementUrl: null,
    billingIssue: row.billing_issue_detected_at != null,
  };
}

/**
 * The state the UI should render.
 *
 * Store wins when it says yes: it is authoritative about what the user paid
 * for and it is available offline, whereas the server row can lag a webhook
 * by seconds. When the store says no (or isn't available — browser dev, or a
 * configure() that failed), fall back to the server row.
 */
export async function readEntitlement(): Promise<EntitlementState> {
  const store = await readStoreEntitlement();
  if (store?.entitled) return store;
  const server = await readServerEntitlement();
  if (server.entitled) return server;
  return store ?? server;
}

// ---------------------------------------------------------------- offering

export interface Offering {
  packages: PurchasesPackage[];
  annual: PurchasesPackage | null;
  raw: PurchasesOffering;
}

/**
 * Load the current offering. The annual package is looked up by RevenueCat's
 * standard $rc_annual identifier, falling back to packageType, so renaming
 * the package in the dashboard doesn't break the paywall.
 */
export async function loadOffering(): Promise<Offering | null> {
  if (!billingAvailable()) return null;
  const { current } = await Purchases.getOfferings();
  if (!current) return null;
  const annual =
    current.annual ??
    current.availablePackages.find((p) => p.identifier === "$rc_annual") ??
    current.availablePackages.find((p) => p.packageType === "ANNUAL") ??
    current.availablePackages[0] ??
    null;
  return { packages: current.availablePackages, annual, raw: current };
}

// --------------------------------------------------------------- purchasing

/**
 * Run the store purchase sheet, then wait for the webhook to land.
 *
 * Throws PurchaseCancelledError when the user backs out — the caller should
 * treat that as a silent no-op, not an error to display.
 */
export async function purchase(pkg: PurchasesPackage): Promise<EntitlementState> {
  const { customerInfo } = await Purchases.purchasePackage({ aPackage: pkg })
    .catch((e: unknown) => {
      const err = e as { userCancelled?: boolean; code?: string; message?: string };
      if (err?.userCancelled) throw new PurchaseCancelledError();
      throw new Error(err?.message ?? "Purchase failed");
    });

  const state = fromCustomerInfo(customerInfo);
  if (state.entitled) await waitForServerEntitlement();
  return state;
}

/**
 * Restore purchases made on this store account.
 *
 * Note what this does and does not recover: it recovers the SUBSCRIPTION, not
 * the journal. Threads and notes live against the Supabase account, so a user
 * who reinstalls without an email backup restores their entitlement onto an
 * empty account. That is why Paywall.tsx requires the email step before it
 * will let a purchase start.
 */
export async function restore(): Promise<EntitlementState> {
  const { customerInfo } = await Purchases.restorePurchases();
  const state = fromCustomerInfo(customerInfo);
  if (state.entitled) await waitForServerEntitlement();
  return state;
}

/**
 * Poll public.subscriptions until the RevenueCat webhook has written the row.
 *
 * The store confirms a purchase to the client before RevenueCat has delivered
 * the webhook, so without this the very first "generate today's entry" tap
 * after subscribing would hit the server gate and 402. Typically resolves in
 * well under a second; the ceiling is a bounded fallback, not the expected path.
 */
async function waitForServerEntitlement(timeoutMs = 15_000): Promise<boolean> {
  const started = Date.now();
  let delay = 400;
  while (Date.now() - started < timeoutMs) {
    const entitled = await readServerEntitlement()
      .then((s) => s.entitled)
      .catch(() => false); // transient error — keep polling, don't abort
    if (entitled) return true;
    await new Promise((r) => setTimeout(r, delay));
    delay = Math.min(delay * 1.6, 3_000);
  }
  // Not fatal: the webhook may simply be slow, and RevenueCat retries. The
  // client keeps working off store state; the next server call may 402 once.
  console.warn("entitlement did not appear server-side within timeout");
  return false;
}

/** Where to send a user who wants to cancel or change payment method. */
export async function managementUrl(): Promise<string | null> {
  const state = await readStoreEntitlement();
  return state?.managementUrl ?? null;
}
