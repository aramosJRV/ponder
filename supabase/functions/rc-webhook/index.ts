// rc-webhook — receives RevenueCat server notifications and maintains
// public.subscriptions, the single source of truth for entitlement.
//
// Why a webhook rather than trusting the client: the client's CustomerInfo is
// advisory. Everything that spends Claude tokens (the nightly cron, on-demand
// generation, synthesis) reads the database, and the database is only ever
// written from here with the service role.
//
// Auth: RevenueCat sends a fixed Authorization header, configured alongside
// the webhook URL in the RevenueCat dashboard. We compare it in constant time
// against the RC_WEBHOOK_SECRET function secret. There is no signature scheme
// to verify — the shared header IS the auth, so it must be long and random.
//
// verify_jwt is OFF for this function (see config.toml); RevenueCat has no
// Supabase JWT to present.
//
// Ordering: RevenueCat retries on non-2xx and does not guarantee order. Every
// write is guarded by event_timestamp_ms so a delayed retry of an old event
// can never resurrect an expired subscription. Duplicate event ids are no-ops.
//
// IMPORTANT: always return 2xx once the event has been understood, even if we
// choose to ignore it. A non-2xx makes RevenueCat retry for hours.

import { createClient, SupabaseClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY =
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? Deno.env.get("SB_SECRET_KEY")!;
const RC_WEBHOOK_SECRET = Deno.env.get("RC_WEBHOOK_SECRET") ?? "";
const ENTITLEMENT_ID = Deno.env.get("RC_ENTITLEMENT_ID") ?? "pro";

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

/** Constant-time compare so the secret can't be recovered by timing. */
function secretsMatch(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Map a RevenueCat event to a Supabase auth user id.
 *
 * We set the RC app user id to the Supabase user id at login, so app_user_id
 * is normally already a uuid. But a purchase made before login completes is
 * attributed to an RC anonymous id ("$RCAnonymousID:..."), and after the
 * subsequent alias the real id shows up in `aliases` /
 * `original_app_user_id`. Scan all three and take the first uuid.
 */
function resolveUserId(ev: Record<string, unknown>): string | null {
  const candidates: unknown[] = [
    ev.app_user_id,
    ev.original_app_user_id,
    ...(Array.isArray(ev.aliases) ? ev.aliases : []),
  ];
  for (const c of candidates) {
    if (typeof c === "string" && UUID_RE.test(c)) return c;
  }
  return null;
}

const ms = (v: unknown): string | null =>
  typeof v === "number" && Number.isFinite(v)
    ? new Date(v).toISOString()
    : null;

/** Events that mean "entitlement is live until expiration_at_ms". */
const GRANTING = new Set([
  "INITIAL_PURCHASE",
  "RENEWAL",
  "PRODUCT_CHANGE",
  "UNCANCELLATION",
  "NON_RENEWING_PURCHASE",
  "SUBSCRIPTION_EXTENDED",
  "TEMPORARY_ENTITLEMENT_GRANT",
]);

/** Events that end the entitlement now. */
const REVOKING = new Set(["EXPIRATION", "SUBSCRIPTION_PAUSED", "REFUND"]);

/**
 * Events that only annotate an existing subscription. CANCELLATION means
 * auto-renew was switched off, NOT that access stops — the user keeps the
 * entitlement until expires_at, and treating it as revocation would cut off
 * someone who has already paid for the rest of the year.
 */
const ANNOTATING = new Set(["CANCELLATION", "BILLING_ISSUE"]);

type Row = Record<string, unknown>;

async function upsert(db: SupabaseClient, userId: string, patch: Row, ev: Row) {
  const eventId = String(ev.id ?? "");
  const eventAt = ms(ev.event_timestamp_ms) ?? new Date().toISOString();

  const { data: existing } = await db
    .from("subscriptions")
    .select("last_event_id, last_event_at")
    .eq("user_id", userId)
    .maybeSingle();

  if (existing) {
    // Duplicate delivery — RevenueCat retries are expected, not an error.
    if (existing.last_event_id && existing.last_event_id === eventId) {
      return { status: "duplicate" };
    }
    // Out-of-order retry: an older event must not overwrite newer state.
    if (existing.last_event_at && existing.last_event_at > eventAt) {
      return { status: "stale" };
    }
  }

  const { error } = await db.from("subscriptions").upsert(
    {
      user_id: userId,
      rc_app_user_id: String(ev.app_user_id ?? userId),
      entitlement_id: ENTITLEMENT_ID,
      last_event_id: eventId,
      last_event_at: eventAt,
      raw: ev,
      ...patch,
    },
    { onConflict: "user_id" },
  );
  if (error) throw new Error(`upsert failed: ${error.message}`);
  return { status: "ok" };
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json(405, { error: "POST only" });

  if (!RC_WEBHOOK_SECRET) {
    // Fail closed: an unset secret would otherwise accept anonymous writes to
    // the entitlement table.
    console.error("RC_WEBHOOK_SECRET is not set — rejecting all webhooks");
    return json(500, { error: "not configured" });
  }
  const auth = req.headers.get("authorization") ?? "";
  if (!secretsMatch(auth, RC_WEBHOOK_SECRET)) {
    return json(401, { error: "Unauthorized" });
  }

  let body: { event?: Record<string, unknown> };
  try {
    body = await req.json();
  } catch {
    return json(400, { error: "invalid JSON" });
  }

  const ev = body.event;
  if (!ev || typeof ev !== "object") return json(400, { error: "no event" });

  const type = String(ev.type ?? "");
  if (type === "TEST") return json(200, { ok: true, note: "test event" });

  const db = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false },
  });

  // Only react to events carrying our entitlement. RevenueCat sends every
  // entitlement's events to the same URL.
  const entIds = Array.isArray(ev.entitlement_ids)
    ? (ev.entitlement_ids as unknown[]).map(String)
    : [];
  if (entIds.length && !entIds.includes(ENTITLEMENT_ID)) {
    return json(200, { ok: true, note: `ignored entitlement ${entIds.join(",")}` });
  }

  try {
    // TRANSFER moves an entitlement between app user ids (typically a
    // reinstall restoring onto a fresh anonymous account). Revoke on the
    // source, grant on the destination. RevenueCat sends no expiration on
    // transfer events, so the destination is reconciled by the client calling
    // syncEntitlement() right after restore.
    if (type === "TRANSFER") {
      const from = (Array.isArray(ev.transferred_from) ? ev.transferred_from : [])
        .map(String).filter((s) => UUID_RE.test(s));
      const to = (Array.isArray(ev.transferred_to) ? ev.transferred_to : [])
        .map(String).filter((s) => UUID_RE.test(s));

      if (from.length) {
        await db.from("subscriptions")
          .update({ expires_at: new Date().toISOString(), raw: ev })
          .in("user_id", from);
      }
      for (const userId of to) {
        const transferExpiry = ms(ev.expiration_at_ms);
        await upsert(db, userId, {
          product_id: ev.product_id ?? null,
          store: ev.store ?? null,
          environment: ev.environment === "SANDBOX" ? "SANDBOX" : "PRODUCTION",
          // TRANSFER events usually carry no expiration. Writing null here
          // would read as "never expires" in has_active_entitlement() and hand
          // out a lifetime subscription to anyone who reinstalls. Grant a
          // short window instead; the RENEWAL event that follows sets the
          // real date, and the client's own sync corrects it sooner.
          expires_at:
            transferExpiry ?? new Date(Date.now() + 86_400_000).toISOString(),
        }, ev);
      }
      return json(200, { ok: true, type, from, to });
    }

    const userId = resolveUserId(ev);
    if (!userId) {
      // A purchase attributed only to an RC anonymous id. Not an error: the
      // alias event that follows carries the real id. 200 so RC stops retrying.
      console.warn(`rc-webhook: no Supabase uuid in event ${ev.id} (${type})`);
      return json(200, { ok: true, note: "no resolvable user id" });
    }

    let patch: Row;

    if (GRANTING.has(type)) {
      // A null expires_at means "never expires" in has_active_entitlement().
      // Only NON_RENEWING_PURCHASE is legitimately non-expiring; for every
      // other granting event a missing expiration is a malformed payload, and
      // storing null would hand out a free lifetime subscription. Fall back to
      // a short window instead — the next RENEWAL event corrects it, and the
      // worst case is a day of access rather than forever.
      const expiry = ms(ev.expiration_at_ms);
      patch = {
        product_id: ev.product_id ?? null,
        store: ev.store ?? null,
        period_type: ev.period_type ?? null,
        environment: ev.environment === "SANDBOX" ? "SANDBOX" : "PRODUCTION",
        purchased_at: ms(ev.purchased_at_ms),
        expires_at:
          expiry ??
          (type === "NON_RENEWING_PURCHASE"
            ? null
            : new Date(Date.now() + 86_400_000).toISOString()),
        // A new purchase or renewal clears both warning flags.
        unsubscribe_detected_at: null,
        billing_issue_detected_at: null,
      };
    } else if (REVOKING.has(type)) {
      patch = {
        expires_at: ms(ev.expiration_at_ms) ?? new Date().toISOString(),
        product_id: ev.product_id ?? null,
        store: ev.store ?? null,
        environment: ev.environment === "SANDBOX" ? "SANDBOX" : "PRODUCTION",
      };
    } else if (ANNOTATING.has(type)) {
      // Access is NOT cut here — expires_at is left untouched on purpose.
      patch = type === "CANCELLATION"
        ? { unsubscribe_detected_at: new Date().toISOString() }
        : { billing_issue_detected_at: new Date().toISOString() };
    } else {
      return json(200, { ok: true, note: `unhandled type ${type}` });
    }

    const result = await upsert(db, userId, patch, ev);
    return json(200, { ok: true, type, user_id: userId, ...result });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`rc-webhook failure on ${type}: ${msg}`);
    // 500 here is correct: we want RevenueCat to retry a genuine write failure.
    return json(500, { error: msg });
  }
});
