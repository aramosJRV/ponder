import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

/**
 * Production builds fail rather than ship a paywall Apple will reject.
 *
 * Paywall.tsx hides the Privacy Policy link when VITE_PRIVACY_URL is unset,
 * and only warns in dev — so a production build was silently producing a
 * subscription screen with no privacy link, which is a guaranteed App Review
 * rejection. It did exactly that once (2026-08-16). The same applies to the
 * RevenueCat key: without it no offering loads, the price never renders and
 * the purchase button stays dead.
 *
 * Checked at build time only. `vite dev` is unaffected.
 */
function assertReleaseEnv(mode: string, env: Record<string, string>) {
  if (mode !== "production") return;

  const required = [
    ["VITE_SUPABASE_URL", "the app cannot reach its backend"],
    ["VITE_SUPABASE_ANON_KEY", "the app cannot reach its backend"],
    ["VITE_PRIVACY_URL", "the paywall renders with no privacy link — App Review rejects this"],
    ["VITE_RC_IOS_KEY", "RevenueCat loads no offering, so no price renders and the purchase button stays disabled"],
  ] as const;

  const missing = required.filter(([k]) => !env[k]);
  if (missing.length) {
    throw new Error(
      "Refusing to build a release without:\n" +
        missing.map(([k, why]) => `  - ${k}  (${why})`).join("\n") +
        "\nSet these in .env (see .env.example).",
    );
  }
}

export default defineConfig(({ mode }) => {
  assertReleaseEnv(mode, loadEnv(mode, process.cwd(), ""));
  return {
    plugins: [react()],
    server: { port: 5173 },
  };
});
