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
export async function ensureSession(): Promise<Session> {
  const { data } = await supabase.auth.getSession();
  if (data.session) return data.session;

  const { data: created, error } = await supabase.auth.signInAnonymously();
  if (error || !created.session) {
    throw error ?? new Error("Could not start a session");
  }
  return created.session;
}

/** True when the current user is anonymous (not yet backed up with an email). */
export async function isAnonymousUser(): Promise<boolean> {
  const { data } = await supabase.auth.getUser();
  // is_anonymous is present on the JWT for anonymous users.
  return Boolean(data.user?.is_anonymous);
}
