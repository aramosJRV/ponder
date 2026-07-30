import { useEffect, useState } from "react";
import { supabase } from "../lib/supabase";
import {
  confirmEmailBackup,
  confirmRestore,
  startEmailBackup,
  startRestore,
} from "../lib/api";

type Mode = "loading" | "anon" | "backed_up";
type Flow =
  | { kind: "idle" }
  | { kind: "backup_code"; email: string }
  | { kind: "restore_email" }
  | { kind: "restore_code"; email: string };

/**
 * Account state for Settings.
 *
 * Anonymous accounts have no way back in except the device's stored session, so
 * this is where a user optionally attaches an email ("back up") to make the
 * account permanent, or restores a backed-up account on a new device. Real
 * sign-out is deliberately hidden until the account is backed up — signing out
 * of an anonymous account would orphan every topic and note permanently.
 */
export default function AccountSection() {
  const [mode, setMode] = useState<Mode>("loading");
  const [email, setEmail] = useState<string | null>(null);

  const [flow, setFlow] = useState<Flow>({ kind: "idle" });
  const [input, setInput] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [okMsg, setOkMsg] = useState("");

  async function refresh() {
    const { data } = await supabase.auth.getUser();
    const anon = Boolean(data.user?.is_anonymous);
    setMode(anon ? "anon" : "backed_up");
    setEmail(data.user?.email ?? null);
  }

  useEffect(() => {
    void refresh();
  }, []);

  function resetFlow() {
    setFlow({ kind: "idle" });
    setInput("");
    setCode("");
    setError("");
    setOkMsg("");
  }

  async function run(fn: () => Promise<void>, done?: () => void) {
    setBusy(true);
    setError("");
    try {
      await fn();
      done?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  }

  // ---- actions ------------------------------------------------------------
  const sendBackup = () =>
    run(
      () => startEmailBackup(input),
      () => setFlow({ kind: "backup_code", email: input.trim() }),
    );

  const confirmBackup = (addr: string) =>
    run(
      () => confirmEmailBackup(addr, code),
      () => {
        resetFlow();
        setOkMsg("Your journal is backed up.");
        void refresh();
      },
    );

  const sendRestore = () =>
    run(
      () => startRestore(input),
      () => setFlow({ kind: "restore_code", email: input.trim() }),
    );

  const confirmRestoreCode = (addr: string) =>
    run(
      () => confirmRestore(addr, code),
      () => {
        resetFlow();
        void refresh();
      },
    );

  // ---- rendering ----------------------------------------------------------
  if (mode === "loading") return null;

  return (
    <section className="mt-8 rounded-2xl border border-hairline bg-surface p-5">
      <h2 className="font-display text-xl">Account</h2>

      {okMsg && <p className="mt-2 text-sm font-semibold text-moss">{okMsg}</p>}
      {error && (
        <p className="mt-3 rounded-xl bg-rust-soft px-4 py-2.5 text-sm font-semibold text-rust">
          {error}
        </p>
      )}

      {/* Backed-up account: show email + safe sign-out */}
      {mode === "backed_up" && (
        <>
          <p className="mt-1 text-sm text-muted">
            Backed up to <span className="font-semibold text-ink">{email}</span>. You can sign in
            on another device with a code sent to this address.
          </p>
          <button
            onClick={() => void supabase.auth.signOut()}
            className="pressable mt-4 min-h-[48px] w-full rounded-xl border border-hairline bg-surface font-semibold text-muted"
          >
            Sign out
          </button>
        </>
      )}

      {/* Anonymous account: encourage backup, offer restore */}
      {mode === "anon" && flow.kind === "idle" && (
        <>
          <p className="mt-1 text-sm leading-relaxed text-muted">
            Your journal lives only on this device. Add an email to protect it — so you don’t lose
            your threads and notes if you change or reset your phone.
          </p>
          <input
            type="email"
            inputMode="email"
            autoComplete="email"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="you@example.com"
            className="mt-4 w-full rounded-xl border border-hairline bg-paper px-4 py-3 outline-none focus:border-moss"
          />
          <button
            onClick={() => void sendBackup()}
            disabled={busy || input.trim().length < 3}
            className="pressable mt-3 min-h-[48px] w-full rounded-xl bg-moss font-semibold text-white disabled:opacity-50"
          >
            {busy ? "Sending…" : "Back up my journal"}
          </button>
          <button
            onClick={() => {
              resetFlow();
              setFlow({ kind: "restore_email" });
            }}
            className="pressable mt-3 w-full py-2 text-sm font-semibold text-muted"
          >
            Already have a backup? Restore it
          </button>
        </>
      )}

      {/* Enter code to confirm a backup */}
      {mode === "anon" && flow.kind === "backup_code" && (
        <CodeStep
          hint={`Enter the code we emailed to ${flow.email}.`}
          code={code}
          setCode={setCode}
          busy={busy}
          onSubmit={() => void confirmBackup(flow.email)}
          onCancel={resetFlow}
          submitLabel="Confirm backup"
        />
      )}

      {/* Restore: ask for the backed-up email */}
      {mode === "anon" && flow.kind === "restore_email" && (
        <>
          <p className="mt-1 text-sm leading-relaxed text-muted">
            Enter the email your journal is backed up to. We’ll send a sign-in code.
          </p>
          <input
            type="email"
            inputMode="email"
            autoComplete="email"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="you@example.com"
            className="mt-4 w-full rounded-xl border border-hairline bg-paper px-4 py-3 outline-none focus:border-moss"
          />
          <button
            onClick={() => void sendRestore()}
            disabled={busy || input.trim().length < 3}
            className="pressable mt-3 min-h-[48px] w-full rounded-xl bg-moss font-semibold text-white disabled:opacity-50"
          >
            {busy ? "Sending…" : "Send sign-in code"}
          </button>
          <button
            onClick={resetFlow}
            className="pressable mt-3 w-full py-2 text-sm font-semibold text-muted"
          >
            Cancel
          </button>
        </>
      )}

      {/* Restore: enter the sign-in code */}
      {mode === "anon" && flow.kind === "restore_code" && (
        <CodeStep
          hint={`Enter the sign-in code we emailed to ${flow.email}. This replaces the empty journal on this device with your backed-up one.`}
          code={code}
          setCode={setCode}
          busy={busy}
          onSubmit={() => void confirmRestoreCode(flow.email)}
          onCancel={resetFlow}
          submitLabel="Restore my journal"
        />
      )}
    </section>
  );
}

function CodeStep({
  hint,
  code,
  setCode,
  busy,
  onSubmit,
  onCancel,
  submitLabel,
}: {
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
      <p className="mt-1 text-sm leading-relaxed text-muted">{hint}</p>
      <input
        inputMode="numeric"
        autoComplete="one-time-code"
        value={code}
        onChange={(e) => setCode(e.target.value)}
        placeholder="123456"
        className="mt-4 w-full rounded-xl border border-hairline bg-paper px-4 py-3 text-center text-lg tracking-[0.3em] outline-none focus:border-moss"
      />
      <button
        onClick={onSubmit}
        disabled={busy || code.trim().length < 6}
        className="pressable mt-3 min-h-[48px] w-full rounded-xl bg-moss font-semibold text-white disabled:opacity-50"
      >
        {busy ? "Confirming…" : submitLabel}
      </button>
      <button
        onClick={onCancel}
        className="pressable mt-3 w-full py-2 text-sm font-semibold text-muted"
      >
        Cancel
      </button>
    </>
  );
}
