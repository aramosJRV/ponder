// delete-account — permanently deletes the caller's account and all their data.
//
// POST {}  (no body required)
//
// Required by Apple App Store guideline 5.1.1(v): an app that supports account
// creation must let the user initiate deletion from inside the app. Ponder
// creates an anonymous account on first launch, so this applies to every user.
//
// Auth (verify_jwt is OFF; checked explicitly, same as synthesize/generate-entry):
//   - user JWT → deletes THAT user, and only that user
//   - service key → rejected. Deletion must be user-initiated; there is no
//     admin path here, so a leaked service key cannot mass-delete accounts.
//
// Deleting the auth.users row cascades to every table that references it
// (profiles, topics, daily_entries, notes, syntheses, content_reports,
// subscriptions) via `on delete cascade`, so this single call removes
// everything. generation_failures is `on delete set null` by design — those
// rows are operational telemetry and retain no user content once nulled.

import { createClient, SupabaseClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY =
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? Deno.env.get("SB_SECRET_KEY")!;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });

/**
 * Resolve the calling user from their JWT.
 *
 * Deliberately narrower than the other functions' `authorize`: it accepts ONLY
 * a real end-user JWT. A service key gets no privileges here at all.
 */
async function callerUserId(
  req: Request,
  db: SupabaseClient,
): Promise<string | null> {
  const auth = req.headers.get("authorization") ?? "";
  const token = auth.replace(/^Bearer\s+/i, "").trim();
  if (!token) return null;
  // Never let a service credential stand in for a user.
  if (token === SERVICE_KEY || token.startsWith("sb_secret_")) return null;

  const { data, error } = await db.auth.getUser(token);
  if (error || !data?.user) return null;
  return data.user.id;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json(405, { error: "POST only" });

  const db = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false },
  });

  const userId = await callerUserId(req, db);
  if (!userId) return json(401, { error: "Unauthorized" });

  // Belt and braces: clear the user's own rows explicitly before dropping the
  // auth row. The cascades below would handle it, but doing it here means a
  // partial failure surfaces as an error the user sees, rather than an auth
  // row that is gone while content lingers.
  for (const table of [
    "content_reports",
    "notes",
    "syntheses",
    "daily_entries",
    "topics",
    "subscriptions",
    "profiles",
  ]) {
    const column = table === "profiles" ? "id" : "user_id";
    const { error } = await db.from(table).delete().eq(column, userId);
    if (error) {
      return json(500, {
        error: `Could not delete ${table}: ${error.message}`,
      });
    }
  }

  const { error: authErr } = await db.auth.admin.deleteUser(userId);
  if (authErr) {
    return json(500, { error: `Could not delete account: ${authErr.message}` });
  }

  return json(200, { deleted: true });
});
