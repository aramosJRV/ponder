import { createClient, type Session } from "@supabase/supabase-js";
import { authStorage } from "./authStorage";

const url = import.meta.env.VITE_SUPABASE_URL as string;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string;

if (!url || !anonKey) {
  throw new Error(
    "Missing VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY — copy .env.example to .env",
  );
}

export const supabase = createClient(url, anonKey, {
  auth: {
    // Session lives in native-durable storage on device (see authStorage).
    storage: authStorage,
    persistSession: true,
    autoRefreshToken: true,
    // No magic-link URL to parse on native; backup/restore uses OTP codes.
    detectSessionInUrl: false,
  },
});

export const FUNCTIONS_URL = `${url}/functions/v1`;

/**
 * Ensure there is a signed-in session, creating an anonymous one if needed.
 *
 * This is the whole "no sign-up" flow: the very first launch mints an anonymous
 * user (real auth.users row + JWT, so RLS and the profile trigger work exactly
 * as for an email user); every later launch restores the persisted session.
 *
 * Returns the session, or throws if anonymous sign-in fails (e.g. the provider
 * is disabled in the Supabase dashboard) so the caller can show a retry state.
 */
/**
 * In-flight guard. React StrictMode runs App's boot effect twice in dev, and a
 * foreground event can race a cold start in production. Without this, two
 * callers both observe "no session", both call signInAnonymously(), and the
 * device ends up with two accounts — one of which silently wins the persisted
 * session while the other is orphaned along with anything written to it.
 */
let sessionPromise: Promise<Session> | null = null;

export async function ensureSession(): Promise<Session> {
  if (sessionPromise) return sessionPromise;

  sessionPromise = (async () => {
    const { data } = await supabase.auth.getSession();
    if (data.session) return data.session;

    const { data: created, error } = await supabase.auth.signInAnonymously();
    if (error || !created.session) {
      throw error ?? new Error("Could not start a session");
    }
    return created.session;
  })();

  try {
    return await sessionPromise;
  } catch (e) {
    // Let the next caller retry rather than caching the failure forever.
    sessionPromise = null;
    throw e;
  }
}

// A successful ensureSession() call leaves `sessionPromise` cached forever —
// only the error path above ever clears it. That's fine until sign-out: the
// next ensureSession() call would otherwise hand back that same, now-dead
// session object instead of re-checking storage, leaving the app stuck on
// the boot-error screen until the process is killed and relaunched. Reset it
// on SIGNED_OUT so the very next call mints a fresh anonymous session (or
// picks up a restored one) immediately.
supabase.auth.onAuthStateChange((event) => {
  if (event === "SIGNED_OUT") sessionPromise = null;
});

/** True when the current user is anonymous (not yet backed up with an email). */
export async function isAnonymousUser(): Promise<boolean> {
  const { data } = await supabase.auth.getUser();
  // is_anonymous is present on the JWT for anonymous users.
  return Boolean(data.user?.is_anonymous);
}
