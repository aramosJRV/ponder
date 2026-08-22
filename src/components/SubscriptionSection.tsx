import { useEffect, useState } from "react";
import { restore, managementUrl } from "../lib/billing";
import {
  entitlement,
  refreshEntitlement,
  onEntitlementChange,
  type EntitlementState,
} from "../lib/entitlements";
import { exportJournalMarkdown } from "../lib/api";

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      year: "numeric",
      month: "long",
      day: "numeric",
    });
  } catch {
    return iso.slice(0, 10);
  }
}

/**
 * Subscription status for Settings.
 *
 * Cancellation is deliberately a deep link out to the store rather than an
 * in-app flow: neither Apple nor Google allows an app to cancel a
 * subscription it sold, and pretending otherwise produces a dead button and a
 * support email.
 */
export default function SubscriptionSection() {
  const [state, setState] = useState<EntitlementState>(entitlement());
  const [manageUrl, setManageUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    const unsub = onEntitlementChange(setState);
    void refreshEntitlement().then(setState);
    void managementUrl().then(setManageUrl);
    return unsub;
  }, []);

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError("");
    setMsg("");
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  }

  const statusLine = !state.entitled
    ? "No active subscription"
    : state.inTrial
      ? `Free trial — ends ${formatDate(state.expiresAt)}`
      : state.willRenew
        ? `Active — renews ${formatDate(state.expiresAt)}`
        : `Active — ends ${formatDate(state.expiresAt)}, will not renew`;

  return (
    <section className="mt-8 rounded-2xl border border-hairline bg-surface p-5">
      <h2 className="font-display text-xl">Subscription</h2>
      <p className="mt-1 text-sm text-muted">{statusLine}</p>

      {state.billingIssue && (
        <p className="mt-3 rounded-xl bg-rust-soft px-4 py-2.5 text-sm font-semibold text-rust">
          There’s a problem with your payment method. Update it in your store
          account to keep your subscription active.
        </p>
      )}

      {msg && <p className="mt-3 text-sm font-semibold text-moss">{msg}</p>}
      {error && (
        <p className="mt-3 rounded-xl bg-rust-soft px-4 py-2.5 text-sm font-semibold text-rust">
          {error}
        </p>
      )}

      {manageUrl && (
        <a
          href={manageUrl}
          target="_blank"
          rel="noreferrer"
          className="pressable mt-4 flex min-h-[48px] w-full items-center justify-center rounded-xl border border-hairline bg-surface font-semibold text-muted"
        >
          Manage subscription
        </a>
      )}

      <button
        onClick={() =>
          void run(async () => {
            const result = await restore();
            setMsg(
              result.entitled
                ? "Subscription restored."
                : "No previous subscription found for this store account.",
            );
          })
        }
        disabled={busy}
        className="pressable mt-3 min-h-[48px] w-full rounded-xl border border-hairline bg-surface font-semibold text-muted disabled:opacity-50"
      >
        Restore purchases
      </button>

      <button
        onClick={() =>
          void run(async () => {
            const md = await exportJournalMarkdown();
            const blob = new Blob([md], { type: "text/markdown" });
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = `ponder-journal-${new Date().toISOString().slice(0, 10)}.md`;
            a.click();
            URL.revokeObjectURL(url);
            setMsg("Journal exported.");
          })
        }
        disabled={busy}
        className="pressable mt-3 min-h-[48px] w-full rounded-xl border border-hairline bg-surface font-semibold text-muted disabled:opacity-50"
      >
        Export my journal
      </button>
    </section>
  );
}
