import { useEffect, useState } from "react";
import { Capacitor } from "@capacitor/core";
import type { PurchasesPackage } from "@revenuecat/purchases-capacitor";
import {
  loadOffering,
  purchase,
  restore,
  billingAvailable,
  PurchaseCancelledError,
} from "../lib/billing";
import { refreshEntitlement, entitlement } from "../lib/entitlements";
import {
  confirmRestore,
  startRestore,
  exportJournalMarkdown,
} from "../lib/api";
import { userMessage } from "../lib/errors";

// Apple rejects a subscription screen whose privacy link is dead, so this is
// deliberately not a guessed default — set VITE_PRIVACY_URL to wherever
// public/privacy.html ends up hosted. The build fails loudly rather than
// shipping a broken link (see the check below).
const PRIVACY_URL = import.meta.env.VITE_PRIVACY_URL as string | undefined;

// Apple requires a link to the actual EULA. Using Apple's standard one is
// permitted and avoids hosting a second document.
const TERMS_URL = "https://www.apple.com/legal/internet-services/itunes/dev/stdeula/";

if (import.meta.env.DEV && !PRIVACY_URL) {
  console.warn(
    "VITE_PRIVACY_URL is not set — the paywall's privacy link will be hidden, " +
      "and App Review will reject the build without it.",
  );
}

type Step =
  | { kind: "offer" }
  | { kind: "restore_email" }
  | { kind: "restore_code"; email: string };

/**
 * The paywall.
 *
 * Two things here are non-obvious and deliberate:
 *
 * 1. Email is NOT required to subscribe. Ponder accounts are anonymous by
 *    default — the account is the device. Attaching an email is offered in
 *    Settings (and needed before an export can be restored on a new phone),
 *    but gating the purchase on it cost more users than it saved journals.
 *
 * 2. "Export my journal" sits on the paywall itself, unauthenticated by
 *    subscription. Access to generated content is a fair thing to sell.
 *    Access to the user's own writing is not.
 */
export default function Paywall({ onEntitled }: { onEntitled: () => void }) {
  const [step, setStep] = useState<Step>({ kind: "offer" });
  const [pkg, setPkg] = useState<PurchasesPackage | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [input, setInput] = useState("");
  const [code, setCode] = useState("");

  const state = entitlement();
  const lapsed = Boolean(state.expiresAt); // they had it once

  useEffect(() => {
    void (async () => {
      try {
        const offering = await loadOffering();
        setPkg(offering?.annual ?? null);
      } catch (e) {
        console.warn("offering load failed", e);
      }
    })();
  }, []);

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      if (e instanceof PurchaseCancelledError) return; // user backed out — not an error
      setError(userMessage(e));
    } finally {
      setBusy(false);
    }
  }

  function startPurchase() {
    if (!pkg) {
      setError("Subscription options aren’t available right now. Try again shortly.");
      return;
    }
    void run(async () => {
      const result = await purchase(pkg);
      if (result.entitled) {
        await refreshEntitlement();
        onEntitled();
      }
    });
  }

  const doRestore = () =>
    run(async () => {
      const result = await restore();
      await refreshEntitlement();
      if (result.entitled) onEntitled();
      else setError("No previous subscription found for this store account.");
    });

  const doExport = () =>
    run(async () => {
      const md = await exportJournalMarkdown();
      const blob = new Blob([md], { type: "text/markdown" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `ponder-journal-${new Date().toISOString().slice(0, 10)}.md`;
      a.click();
      URL.revokeObjectURL(url);
      setNotice("Journal exported.");
    });

  // Never hardcode a fallback price. A stale literal here (this used to say
  // "$7.99" long after the price became US$9.99) ships a paywall that quotes a
  // price Apple does not charge — an App Review rejection, and misleading
  // pricing under Australian consumer law. If the offering hasn't loaded we
  // have no price to state, so we say so and leave the button disabled.
  const priceLabel = pkg?.product.priceString ?? null;

  // ---------------------------------------------------------------- render

  return (
    <div className="min-h-screen bg-paper px-6 pb-16 pt-16">
      <div className="mx-auto max-w-md animate-rise">
        <span className="font-display text-3xl italic text-moss">Ponder</span>

        {step.kind === "offer" && (
          <>
            <h1 className="mt-6 font-display text-3xl leading-tight text-ink">
              {lapsed ? "Your subscription has ended" : "Seven days, on us"}
            </h1>
            <p className="mt-3 leading-relaxed text-muted">
              {lapsed
                ? "Renew to keep receiving daily entries and syntheses. Your threads and notes are exactly where you left them."
                : "A week of daily entries across your threads, the honest questions, and the synthesis that shows you what’s emerging."}
            </p>

            <ul className="mt-6 space-y-3 text-sm text-ink">
              <Feature>A new passage and reflection every morning</Feature>
              <Feature>Three threads running at once</Feature>
              <Feature>Challenge entries that question your framing, not just confirm it</Feature>
              <Feature>“What’s emerging?” synthesis across your notes</Feature>
            </ul>

            {/* Apple 3.1.2 / Play: price, period and renewal terms must be
                visible on the purchase screen itself, not only in the sheet. */}
            <div className="mt-8 rounded-2xl border border-hairline bg-surface p-5">
              <p className="font-display text-2xl text-ink">
                {priceLabel === null
                  ? "Pricing unavailable"
                  : lapsed
                    ? priceLabel
                    : "Free for 7 days"}
              </p>
              <p className="mt-1 text-sm text-muted">
                {priceLabel === null
                  ? `Couldn’t reach the ${Capacitor.getPlatform() === "android" ? "Play Store" : "App Store"}. Check your connection and try again.`
                  : lapsed
                    ? "per year, billed annually"
                    : `then ${priceLabel} per year`}
              </p>
              <button
                onClick={startPurchase}
                disabled={busy || (billingAvailable() && !pkg)}
                className="pressable mt-4 min-h-[52px] w-full rounded-xl bg-moss font-semibold text-white disabled:opacity-50"
              >
                {busy ? "One moment…" : lapsed ? "Renew" : "Start free trial"}
              </button>
              <p className="mt-3 text-xs leading-relaxed text-muted">
                Payment is charged to your store account at the end of the free
                trial. The subscription renews automatically each year unless
                cancelled at least 24 hours before the period ends. Manage or
                cancel it any time in your store account settings.
              </p>
            </div>

            {!billingAvailable() && (
              <p className="mt-4 rounded-xl bg-rust-soft px-4 py-2.5 text-sm text-rust">
                Purchases only work in the installed app, not the browser preview.
              </p>
            )}

            <button
              onClick={() => void doRestore()}
              disabled={busy}
              className="pressable mt-5 w-full py-2 text-sm font-semibold text-muted"
            >
              Restore purchases
            </button>
            <button
              onClick={() => setStep({ kind: "restore_email" })}
              className="pressable w-full py-2 text-sm font-semibold text-muted"
            >
              Sign in to a backed-up journal
            </button>
            <button
              onClick={() => void doExport()}
              disabled={busy}
              className="pressable w-full py-2 text-sm font-semibold text-muted underline"
            >
              Export my journal
            </button>

            <p className="mt-6 text-center text-xs text-muted">
              <a href={TERMS_URL} target="_blank" rel="noreferrer" className="underline">
                Terms of Use
              </a>
              {PRIVACY_URL && (
                <>
                  {" · "}
                  <a
                    href={PRIVACY_URL}
                    target="_blank"
                    rel="noreferrer"
                    className="underline"
                  >
                    Privacy Policy
                  </a>
                </>
              )}
            </p>
          </>
        )}

        {step.kind === "restore_email" && (
          <>
            <h1 className="mt-6 font-display text-3xl leading-tight text-ink">
              Sign in
            </h1>
            <p className="mt-3 leading-relaxed text-muted">
              Enter the email your journal is backed up to. We’ll send a sign-in
              code.
            </p>
            <input
              type="email"
              inputMode="email"
              autoComplete="email"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="you@example.com"
              className="mt-6 w-full rounded-xl border border-hairline bg-surface px-4 py-3 outline-none focus:border-moss"
            />
            <button
              onClick={() =>
                void run(async () => {
                  await startRestore(input);
                  setStep({ kind: "restore_code", email: input.trim() });
                })
              }
              disabled={busy || input.trim().length < 3}
              className="pressable mt-3 min-h-[52px] w-full rounded-xl bg-moss font-semibold text-white disabled:opacity-50"
            >
              {busy ? "Sending…" : "Send sign-in code"}
            </button>
            <button
              onClick={() => setStep({ kind: "offer" })}
              className="pressable mt-3 w-full py-2 text-sm font-semibold text-muted"
            >
              Back
            </button>
          </>
        )}

        {step.kind === "restore_code" && (
          <CodeStep
            title="Check your email"
            hint={`Enter the sign-in code we sent to ${step.email}.`}
            code={code}
            setCode={setCode}
            busy={busy}
            submitLabel="Sign in"
            onSubmit={() =>
              void run(async () => {
                await confirmRestore(step.email, code);
                // The account changed, so the entitlement must be re-read
                // against the new user id before we decide anything.
                const next = await refreshEntitlement();
                setCode("");
                if (next.entitled) onEntitled();
                else setStep({ kind: "offer" });
              })
            }
            onCancel={() => setStep({ kind: "restore_email" })}
          />
        )}

        {notice && (
          <p className="mt-4 text-sm font-semibold text-moss">{notice}</p>
        )}
        {error && (
          <p className="mt-4 rounded-xl bg-rust-soft px-4 py-2.5 text-sm font-semibold text-rust">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}

function Feature({ children }: { children: React.ReactNode }) {
  return (
    <li className="flex gap-3">
      <span aria-hidden className="mt-[2px] text-moss">
        ·
      </span>
      <span className="leading-relaxed">{children}</span>
    </li>
  );
}

function CodeStep({
  title,
  hint,
  code,
  setCode,
  busy,
  onSubmit,
  onCancel,
  submitLabel,
}: {
  title: string;
  hint: string;
  code: string;
  setCode: (v: string) => void;
  busy: boolean;
  onSubmit: () => void;
  onCancel: () => void;
  submitLabel: string;
}) {
  return (
    <>
      <h1 className="mt-6 font-display text-3xl leading-tight text-ink">{title}</h1>
      <p className="mt-3 leading-relaxed text-muted">{hint}</p>
      <input
        inputMode="numeric"
        autoComplete="one-time-code"
        value={code}
        onChange={(e) => setCode(e.target.value)}
        placeholder="123456"
        className="mt-6 w-full rounded-xl border border-hairline bg-surface px-4 py-3 text-center text-lg tracking-[0.3em] outline-none focus:border-moss"
      />
      <button
        onClick={onSubmit}
        disabled={busy || code.trim().length < 6}
        className="pressable mt-3 min-h-[52px] w-full rounded-xl bg-moss font-semibold text-white disabled:opacity-50"
      >
        {busy ? "Confirming…" : submitLabel}
      </button>
      <button
        onClick={onCancel}
        className="pressable mt-3 w-full py-2 text-sm font-semibold text-muted"
      >
        Back
      </button>
    </>
  );
}
