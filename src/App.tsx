import { useEffect, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase, ensureSession } from "./lib/supabase";
import { ensureDeviceTimezone, recordAppOpen } from "./lib/api";
import { hasOnboarded, markOnboarded } from "./lib/onboarding";
import { consumeSignedOutFlag } from "./lib/signOutFlag";
import { startKeyboardTracking } from "./lib/keyboardInset";
import { configureBilling } from "./lib/billing";
import { errorCopy, logError, type ErrorKind } from "./lib/errors";
import {
  refreshEntitlement,
  onEntitlementChange,
  resetEntitlement,
} from "./lib/entitlements";
import Onboarding from "./screens/Onboarding";
import Today from "./screens/Today";
import Topics from "./screens/Topics";
import TopicDetail from "./screens/TopicDetail";
import Settings from "./screens/Settings";
import TabBar, { type Tab } from "./components/TabBar";

type Boot = "starting" | "ready" | "error";

/** Last account we configured billing for — see the auth listener below. */
let lastUserId: string | null = null;

export default function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [boot, setBoot] = useState<Boot>("starting");
  const [bootFailure, setBootFailure] = useState<{ kind: ErrorKind; code: string } | null>(null);
  const [tab, setTab] = useState<Tab>("today");
  const [openTopicId, setOpenTopicId] = useState<string | null>(null);
  const [onboarded, setOnboarded] = useState<boolean | null>(null);
  const [autoCreateTopic, setAutoCreateTopic] = useState(false);
  // Set when this boot follows a sign-out, so Settings jumps straight to
  // Restore instead of leaving the user looking at an empty journal.
  const [autoOpenRestore, setAutoOpenRestore] = useState(false);
  // Walkthrough replayed from Settings > How to use. Separate from `onboarded`
  // so replaying never touches the first-run flag.
  const [showIntro, setShowIntro] = useState(false);
  // Bumped whenever entitlement changes, purely to force a re-render — the
  // entitlement itself is read synchronously from lib/entitlements.
  const [, setEntitlementTick] = useState(0);

  async function start() {
    setBoot("starting");
    try {
      // No sign-up screen: first launch mints an anonymous account, later
      // launches restore the persisted one.
      const s = await ensureSession();
      setSession(s);

      // A sign-out (see AccountSection) flags this so the very next boot —
      // which just minted the fresh anonymous session above — routes straight
      // into Settings > Restore instead of a blank Today/Topics view that
      // looks like the journal is gone.
      if (await consumeSignedOutFlag()) {
        setTab("settings");
        setAutoOpenRestore(true);
      }

      // Has this device seen the first-run walkthrough yet?
      setOnboarded(await hasOnboarded());

      // Billing must be configured with the Supabase user id BEFORE the
      // entitlement is read, otherwise RevenueCat answers for an anonymous
      // RC identity rather than this user's.
      //
      // Nothing is gated on the result — there are no tiers — but the SDK
      // wants identifying before any purchase, so doing it at boot keeps the
      // support screen instant when someone opens it.
      lastUserId = s.user.id;
      await configureBilling(s.user.id);
      await refreshEntitlement();

      setBoot("ready");
      // Adopt device timezone on first run — best-effort, don't block UI.
      void ensureDeviceTimezone();
      // Feeds idle auto-pause. Fire-and-forget.
      void recordAppOpen();
    } catch (e) {
      // Same rule as Today.load(): say WHY. "Couldn't start your session" read
      // as a network fault for every cause it had.
      const failed = logError("App.start", e);
      setBootFailure({ kind: failed.kind, code: failed.code });
      setBoot("error");
    }
  }

  async function finishOnboarding(createFirstTopic: boolean) {
    await markOnboarded();
    if (createFirstTopic) {
      setAutoCreateTopic(true);
      setTab("topics");
    }
    setOnboarded(true);
  }

  useEffect(() => {
    void start();

    // Publishes --kb (keyboard overlap) for the whole app. Must run before any
    // sheet opens — nothing in the web layer can see the Android keyboard
    // without it. See lib/keyboardInset.ts.
    startKeyboardTracking();

    const unsubEntitlement = onEntitlementChange(() =>
      setEntitlementTick((n) => n + 1),
    );

    // Foregrounding counts as an open. Deliberately using visibilitychange
    // rather than @capacitor/app: it fires in the WebView and the browser
    // alike, and avoids adding a native plugin for one timestamp.
    function onVisible() {
      if (document.visibilityState === "visible") void recordAppOpen();
    }
    document.addEventListener("visibilitychange", onVisible);

    // Keep session in sync (token refresh, backup/restore, sign-out).
    const { data: sub } = supabase.auth.onAuthStateChange((_event, s) => {
      setSession(s);

      // Only react when the ACCOUNT actually changes. supabase-js fires
      // SIGNED_IN for the anonymous sign-in that start() is already handling,
      // and again on every token refresh — resetting the entitlement on those
      // would blank the cache mid-boot for no reason.
      const nextUserId = s?.user?.id ?? null;
      if (nextUserId === lastUserId) return;
      lastUserId = nextUserId;

      if (!nextUserId) {
        resetEntitlement();
        // Re-run boot now rather than leaving the user parked on the
        // boot-error screen until they notice and tap "Try again" —
        // ensureSession() mints a fresh session immediately (sessionPromise
        // is cleared on SIGNED_OUT, see lib/supabase.ts).
        void start();
        return;
      }
      // A restore-by-email swaps the account underneath us. The old account's
      // entitlement must not carry over, so drop the cache and re-point
      // RevenueCat at the new user id.
      void (async () => {
        resetEntitlement();
        await configureBilling(nextUserId);
        await refreshEntitlement();
      })();
    });

    return () => {
      unsubEntitlement();
      document.removeEventListener("visibilitychange", onVisible);
      sub.subscription.unsubscribe();
    };
  }, []);

  if (boot === "starting") {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <span className="font-display text-2xl italic text-muted">Ponder</span>
      </div>
    );
  }

  if (boot === "error" || !session) {
    const copy = errorCopy(bootFailure?.kind ?? "unknown");
    return (
      <div className="flex min-h-screen flex-col items-center justify-center px-8 text-center">
        <span className="font-display text-2xl italic text-muted">Ponder</span>
        <p className="mt-4 font-display text-2xl">{copy.title}</p>
        <p className="mt-2 max-w-xs text-muted">{copy.body}</p>
        {bootFailure && bootFailure.kind !== "offline" && (
          <p className="mt-3 font-mono text-xs uppercase tracking-wider text-muted">
            code {bootFailure.code}
          </p>
        )}
        <button
          onClick={() => void start()}
          className="pressable mt-6 rounded-xl bg-moss px-6 py-3 font-semibold text-white"
        >
          Try again
        </button>
      </div>
    );
  }

  // First run: show the walkthrough, then straight into the app. There is no
  // paywall behind it any more — Ponder is free, and support is offered from
  // inside the app at moments that have earned it, not at the door.
  if (onboarded === false) {
    return <Onboarding onDone={(create) => void finishOnboarding(create)} />;
  }

  // Replay from Settings — full screen, tab bar included, and no flag written.
  if (showIntro) {
    return <Onboarding replay onDone={() => setShowIntro(false)} />;
  }

  function changeTab(next: Tab) {
    // Tapping a tab always returns to that tab's root view.
    setOpenTopicId(null);
    setTab(next);
  }

  return (
    <>
      {tab === "today" && (
        <Today
          onStartFirstThread={() => {
            setAutoCreateTopic(true);
            setTab("topics");
          }}
        />
      )}

      {tab === "topics" &&
        (openTopicId ? (
          <TopicDetail topicId={openTopicId} onBack={() => setOpenTopicId(null)} />
        ) : (
          <Topics
            onOpenTopic={setOpenTopicId}
            autoOpenCreate={autoCreateTopic}
            onAutoOpenConsumed={() => setAutoCreateTopic(false)}
            onFirstThreadCreated={() => setTab("today")}
          />
        ))}

      {tab === "settings" && (
        <Settings
          autoOpenRestore={autoOpenRestore}
          onAutoOpenConsumed={() => setAutoOpenRestore(false)}
          onShowIntro={() => setShowIntro(true)}
        />
      )}

      <TabBar tab={tab} onChange={changeTab} />
    </>
  );
}
