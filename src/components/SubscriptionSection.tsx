import { useState } from "react";
import Support from "../screens/Support";

/**
 * The support entry point in Settings.
 *
 * This used to be the subscription panel. There is no subscription any more
 * and no tier to report — every user has the same app — so there is no status
 * line, no renewal date, and no "manage subscription" link.
 *
 * "Restore purchases" is gone too, deliberately: support is a one-off
 * consumable that grants nothing, so there is nothing a restore could give
 * back. Offering the button would imply otherwise.
 *
 * And nothing else lives here. Export moved to Account, where it belongs:
 * putting a data control next to a request for money implies the two are
 * connected, and the whole point is that they are not. This section does one
 * thing and asks for nothing else.
 */
export default function SubscriptionSection() {
  const [showSupport, setShowSupport] = useState(false);

  return (
    <section className="mt-8 rounded-2xl border border-hairline bg-surface p-5">
      {showSupport && (
        <Support context="settings" onClose={() => setShowSupport(false)} />
      )}

      <h2 className="font-display text-xl">Ponder is free</h2>
      <p className="mt-1 text-sm leading-relaxed text-muted">
        All of it, always. If you'd like to chip in towards keeping it running,
        you can — it doesn't change anything in the app.
      </p>

      <button
        onClick={() => setShowSupport(true)}
        className="pressable mt-4 min-h-[48px] w-full rounded-xl border border-hairline bg-paper font-semibold text-ink"
      >
        Chip in
      </button>
    </section>
  );
}
