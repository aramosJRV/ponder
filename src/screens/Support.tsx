import { useEffect, useState } from "react";
import type { PurchasesPackage } from "@revenuecat/purchases-capacitor";
import {
  loadTipPackages,
  purchaseTip,
  billingAvailable,
  PurchaseCancelledError,
} from "../lib/billing";
import { userMessage } from "../lib/errors";

const PRIVACY_URL = import.meta.env.VITE_PRIVACY_URL as string | undefined;
const TERMS_URL = "https://www.apple.com/legal/internet-services/itunes/dev/stdeula/";

/**
 * Where the user came from. Changes the opening line only — there is one
 * offer and it is the same everywhere.
 */
export type SupportContext =
  | "settings"
  | "synthesis"
  | "conclusion"
  | "streak"
  | "note";

const OPENERS: Record<SupportContext, string> = {
  settings: "Ponder is free, and it stays free.",
  synthesis: "Ponder is free, and it stays free.",
  conclusion: "That's one thread, all the way through.",
  streak: "You've been at this a while. Thank you for that.",
  note: "Ponder is free, and it stays free.",
};

/**
 * The support screen.
 *
 * THE RULE, and it is not negotiable: contributing unlocks NOTHING. Every
 * user gets the identical app whether they have ever given a cent or not.
 *
 * That rules out, permanently:
 *   - a feature list next to the amounts (that is a price list)
 *   - a subscription, a renewal, or anything recurring
 *   - a badge, a tier name, or any in-app marker of who has given
 *   - "restore purchases" — there is nothing to restore, because nothing
 *     was ever granted
 *   - asking twice, or nagging someone who has already given
 *
 * Word choice: never "donate" or "donation". Money paid here is assessable
 * income to a company, not a charitable gift — it attracts GST, it is not
 * deductible for the giver, and Apple reads nonprofit language closely under
 * guideline 3.2.1(vi). "Support" and "tip" are accurate and are the words the
 * guidelines themselves use.
 *
 * Nothing about running costs appears here either. What Ponder costs is the
 * operator's business, and a figure at low volume reads as "nobody uses this"
 * rather than "this is expensive".
 */
export default function Support({
  context = "settings",
  onClose,
}: {
  context?: SupportContext;
  onClose: () => void;
}) {
  const [tips, setTips] = useState<PurchasesPackage[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [thanked, setThanked] = useState(false);

  useEffect(() => {
    void (async () => {
      // Empty until the tips offering exists in RevenueCat. The screen says so
      // plainly rather than rendering dead buttons.
      setTips(await loadTipPackages());
    })();
  }, []);

  const startTip = (p: PurchasesPackage) => {
    void (async () => {
      setBusy(true);
      setError("");
      try {
        await purchaseTip(p);
        setThanked(true);
      } catch (e) {
        if (e instanceof PurchaseCancelledError) return; // backed out, not an error
        setError(userMessage(e));
      } finally {
        setBusy(false);
      }
    })();
  };

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto bg-paper px-6 pb-16 pt-16">
      <div className="mx-auto max-w-md animate-rise">
        <button
          onClick={onClose}
          className="pressable -ml-2 mb-4 px-2 py-1 text-sm font-semibold text-muted"
        >
          ← Back
        </button>

        <span className="font-display text-3xl italic text-moss">Ponder</span>

        {thanked ? (
          <>
            <h1 className="mt-6 font-display text-3xl leading-tight text-ink">
              Thank you. Genuinely.
            </h1>
            <p className="mt-3 leading-relaxed text-muted">
              That's it — nothing changes, nothing to manage. Ponder carries on
              exactly as it was.
            </p>
            <button
              onClick={onClose}
              className="pressable mt-8 min-h-[52px] w-full rounded-xl bg-moss font-semibold text-white"
            >
              Back to Ponder
            </button>
          </>
        ) : (
          <>
            <h1 className="mt-6 font-display text-3xl leading-tight text-ink">
              {OPENERS[context]}
            </h1>
            <p className="mt-3 leading-relaxed text-muted">
              There's no paid version, no trial, and nothing locked away. If
              Ponder has been worth something to you, you're welcome to put
              something in — once, whenever you like.
            </p>
            <p className="mt-3 leading-relaxed text-muted">
              It changes nothing about your app. That's the point.
            </p>

            {tips.length > 0 && (
              <div className="mt-8 space-y-3">
                {tips.map((t) => (
                  <button
                    key={t.identifier}
                    onClick={() => startTip(t)}
                    disabled={busy}
                    className="pressable min-h-[56px] w-full rounded-xl border border-hairline bg-surface text-lg font-semibold text-ink disabled:opacity-50"
                  >
                    {busy ? "One moment…" : t.product.priceString}
                  </button>
                ))}
                <p className="pt-1 text-xs leading-relaxed text-muted">
                  A one-off payment to your store account. Not a subscription —
                  nothing renews, and there's nothing to cancel.
                </p>
              </div>
            )}

            {tips.length === 0 && billingAvailable() && (
              <p className="mt-8 rounded-xl border border-hairline bg-surface px-4 py-3 text-sm text-muted">
                Couldn't reach the store just now. Ponder works exactly the same
                either way — try again whenever.
              </p>
            )}

            {!billingAvailable() && (
              <p className="mt-8 rounded-xl border border-hairline bg-surface px-4 py-3 text-sm text-muted">
                This only works in the installed app, not the browser preview.
              </p>
            )}
          </>
        )}

        {error && (
          <p className="mt-4 rounded-xl bg-rust-soft px-4 py-2.5 text-sm font-semibold text-rust">
            {error}
          </p>
        )}

        <p className="mt-8 text-center text-xs text-muted">
          <a href={TERMS_URL} target="_blank" rel="noreferrer" className="underline">
            Terms of Use
          </a>
          {PRIVACY_URL && (
            <>
              {" · "}
              <a href={PRIVACY_URL} target="_blank" rel="noreferrer" className="underline">
                Privacy Policy
              </a>
            </>
          )}
        </p>
      </div>
    </div>
  );
}
