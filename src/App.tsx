import { useEffect, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase, ensureSession } from "./lib/supabase";
import { ensureDeviceTimezone, recordAppOpen } from "./lib/api";
import { hasOnboarded, markOnboarded } from "./lib/onboarding";
import { configureBilling } from "./lib/billing";
import {
  refreshEntitlement,
  onEntitlementChange,
  resetEntitlement,
  shouldShowPaywall,
  entitlementLoaded,
} from "./lib/entitlements";
import Onboarding from "./screens/Onboarding";
import Paywall from "./screens/Paywall";
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
  const [tab, setTab] = useState<Tab>("today");
  const [openTopicId, setOpenTopicId] = useState<string | null>(null);
  const [onboarded, setOnboarded] = useState<boolean | null>(null);
  const [autoCreateTopic, setAutoCreateTopic] = useState(false);
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
      // Has this device seen the first-run walkthrough yet?
      setOnboarded(await hasOnboarded());

      // Billing must be configured with the Supabase user id BEFORE the
      // entitlement is read, otherwise RevenueCat answers for an anonymous
      // RC identity and a paying user briefly sees the paywall.
      lastUserId = s.user.id;
      await configureBilling(s.user.id);
      await refreshEntitlement();

      setBoot("ready");
      // Adopt device timezone on first run — best-effort, don't block UI.
      void ensureDeviceTimezone();
      // Feeds idle auto-pause. Fire-and-forget.
      void recordAppOpen();
    } catch {
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
      // would blank the cache mid-boot and flash the paywall at a subscriber.
      const nextUserId = s?.user?.id ?? null;
      if (nextUserId === lastUserId) return;
      lastUserId = nextUserId;

      if (!nextUserId) {
        resetEntitlement();
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
    return (
      <div className="flex min-h-screen flex-col items-center justify-center px-8 text-center">
        <span className="font-display text-2xl italic text-muted">Ponder</span>
        <p className="mt-4 max-w-xs text-muted">
          Couldn’t start your session. Check your connection and try again.
        </p>
        <button
          onClick={() => void start()}
          className="pressable mt-6 rounded-xl bg-moss px-6 py-3 font-semibold text-white"
        >
          Try again
        </button>
      </div>
    );
  }

  // First run: show the walkthrough before the app itself. Deliberately ahead
  // of the paywall — asking for a card before explaining what the app does
  // converts badly and reviews worse.
  if (onboarded === false) {
    return <Onboarding onDone={(create) => void finishOnboarding(create)} />;
  }

  // Everything past here costs Claude tokens per day, so it sits behind the
  // subscription. The server enforces this independently; this only decides
  // what to render.
  if (entitlementLoaded() && shouldShowPaywall()) {
    return <Paywall onEntitled={() => setEntitlementTick((n) => n + 1)} />;
  }

  function changeTab(next: Tab) {
    // Tapping a tab always returns to that tab's root view.
    setOpenTopicId(null);
    setTab(next);
  }

  return (
    <>
      {tab === "today" && <Today />}

      {tab === "topics" &&
        (openTopicId ? (
          <TopicDetail topicId={openTopicId} onBack={() => setOpenTopicId(null)} />
        ) : (
          <Topics
            onOpenTopic={setOpenTopicId}
            autoOpenCreate={autoCreateTopic}
            onAutoOpenConsumed={() => setAutoCreateTopic(false)}
          />
        ))}

      {tab === "settings" && <Settings />}

      <TabBar tab={tab} onChange={changeTab} />
    </>
  );
}
