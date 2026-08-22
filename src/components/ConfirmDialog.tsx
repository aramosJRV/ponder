import { useEffect, useState } from "react";

interface Props {
  open: boolean;
  title: string;
  body: string;
  /** Label for the destructive action. */
  confirmLabel: string;
  /** When set, the user must type this exact word before confirm enables.
   *  Reserved for the irreversible, whole-account case. */
  requireTyped?: string;
  busy?: boolean;
  error?: string;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * Confirmation sheet for destructive actions.
 *
 * Deliberately not `window.confirm`: a native dialog in a Capacitor WebView
 * blocks the JS event loop and is unstyled, and on iOS it shows the origin URL.
 */
export default function ConfirmDialog({
  open,
  title,
  body,
  confirmLabel,
  requireTyped,
  busy = false,
  error = "",
  onConfirm,
  onCancel,
}: Props) {
  const [typed, setTyped] = useState("");

  // Clear the typed guard whenever the sheet closes, so reopening it doesn't
  // arrive pre-armed from a previous attempt.
  useEffect(() => {
    if (!open) setTyped("");
  }, [open]);

  if (!open) return null;

  const armed = !requireTyped || typed.trim().toUpperCase() === requireTyped.toUpperCase();

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-ink/40 px-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
      <div className="w-full max-w-lg animate-rise rounded-3xl bg-paper p-6">
        <h2 className="font-display text-2xl font-medium">{title}</h2>
        <p className="mt-2 text-[15px] leading-relaxed text-muted">{body}</p>

        {requireTyped && (
          <>
            <label className="mt-5 block text-sm font-semibold text-muted" htmlFor="confirm-word">
              Type <span className="font-bold text-ink">{requireTyped}</span> to confirm
            </label>
            <input
              id="confirm-word"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              autoCapitalize="characters"
              autoCorrect="off"
              className="mt-1.5 w-full rounded-xl border border-hairline bg-surface px-4 py-3 tracking-[0.2em] outline-none focus:border-rust"
            />
          </>
        )}

        {error && (
          <p className="mt-4 rounded-xl bg-rust-soft px-4 py-2.5 text-sm font-semibold text-rust">
            {error}
          </p>
        )}

        <button
          onClick={onConfirm}
          disabled={busy || !armed}
          className="pressable mt-5 min-h-[50px] w-full rounded-2xl bg-rust text-base font-semibold text-white disabled:opacity-50"
        >
          {busy ? "Deleting…" : confirmLabel}
        </button>
        <button
          onClick={onCancel}
          disabled={busy}
          className="pressable mt-2.5 min-h-[48px] w-full rounded-2xl border border-hairline bg-surface text-base font-semibold text-ink disabled:opacity-50"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
