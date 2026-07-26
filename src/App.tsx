import { useEffect, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase, ensureSession } from "./lib/supabase";
import { ensureDeviceTimezone } from "./lib/api";
import { hasOnboarded, markOnboarded } from "./lib/onboarding";
import Onboarding from "./screens/Onboarding";
import Today from "./screens/Today";
import Topics from "./screens/Topics";
import TopicDetail from "./screens/TopicDetail";
import Settings from "./screens/Settings";
import TabBar, { type Tab } from "./components/TabBar";

type Boot = "starting" | "ready" | "error";

export default function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [boot, setBoot] = useState<Boot>("starting");
  const [tab, setTab] = useState<Tab>("today");
  const [openTopicId, setOpenTopicId] = useState<string | null>(null);
  const [onboarded, setOnboarded] = useState<boolean | null>(null);
  const [autoCreateTopic, setAutoCreateTopic] = useState(false);

  async function start() {
    setBoot("starting");
    try {
      // No sign-up screen: first launch mints an anonymous account, later
      // launches restore the persisted one.
      const s = await ensureSession();
      setSession(s);
      // Has this device seen the first-run walkthrough yet?
      setOnboarded(await hasOnboarded());
      setBoot("ready");
      // Adopt device timezone on first run — best-effort, don't block UI.
      void ensureDeviceTimezone();
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
    // Keep session in sync (token refresh, backup/restore, sign-out).
    const { data: sub } = supabase.auth.onAuthStateChange((_event, s) => {
      setSession(s);
    });
    return () => sub.subscription.unsubscribe();
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

  // First run: show the walkthrough before the app itself.
  if (onboarded === false) {
    return <Onboarding onDone={(create) => void finishOnboarding(create)} />;
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
