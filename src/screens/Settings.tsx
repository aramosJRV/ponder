import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  clearFocusTopic,
  fetchActiveTopics,
  fetchProfile,
  setFocusTopic,
  updateProfile,
} from "../lib/api";
import {
  DEFAULT_NOTIFICATION_HOUR,
  getNotifier,
  refreshDailyReminder,
} from "../lib/notifications";
import type { PermissionStatus, ReminderState } from "../lib/notifications";
import AccountSection from "../components/AccountSection";
import SubscriptionSection from "../components/SubscriptionSection";
import { deviceTimezone } from "../lib/dates";
import {
  CONTENT_LEVELS,
  DEFAULT_CONTENT_LEVEL,
  getContentLevel,
  setContentLevel,
} from "../lib/contentLevel";
import type { ContentLevel, Profile, Topic } from "../lib/types";

const FALLBACK_TZS = [
  "UTC",
  "Australia/Melbourne",
  "Australia/Sydney",
  "Australia/Brisbane",
  "Australia/Perth",
  "Pacific/Auckland",
  "America/New_York",
  "America/Los_Angeles",
  "Europe/London",
];

/** Settings auto-save. Long enough that dragging the slider is one write. */
const SAVE_DEBOUNCE_MS = 700;

function hourLabel(h: number): string {
  const period = h < 12 ? "AM" : "PM";
  const twelve = h % 12 === 0 ? 12 : h % 12;
  return `${twelve}:00 ${period}`;
}

type SaveState = "idle" | "saving" | "saved";

export default function Settings() {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [topics, setTopics] = useState<Topic[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  // editable profile fields
  const [hour, setHour] = useState(DEFAULT_NOTIFICATION_HOUR);
  const [timezone, setTimezone] = useState("UTC");
  const [challenge, setChallenge] = useState(0.25);
  // Seeded from localStorage so the control is right before the fetch lands;
  // the profile row overwrites it on load and is the source of truth.
  const [contentLevel, setLevel] = useState<ContentLevel>(getContentLevel);
  const [saveState, setSaveState] = useState<SaveState>("idle");

  const [focusBusy, setFocusBusy] = useState(false);

  // notification permission
  const [permission, setPermission] = useState<PermissionStatus>("unsupported");
  const [testMsg, setTestMsg] = useState("");
  const [testBusy, setTestBusy] = useState(false);
  const [reminder, setReminder] = useState<ReminderState | null>(null);

  const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const tzList = useMemo<string[]>(() => {
    try {
      // deno-lint-ignore no-explicit-any
      const list = (Intl as any).supportedValuesOf?.("timeZone");
      return Array.isArray(list) && list.length ? list : FALLBACK_TZS;
    } catch {
      return FALLBACK_TZS;
    }
  }, []);

  async function load() {
    try {
      const [p, t] = await Promise.all([fetchProfile(), fetchActiveTopics()]);
      if (p) {
        setProfile(p);
        setHour(p.notification_hour);
        setTimezone(p.timezone);
        setChallenge(p.challenge_frequency);
        setLevel(p.content_level ?? DEFAULT_CONTENT_LEVEL);
        // Reconcile the render-path mirror EntryCard reads.
        setContentLevel(p.content_level ?? DEFAULT_CONTENT_LEVEL);
      }
      setTopics(t);
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load settings");
    } finally {
      setLoading(false);
    }
  }

  const syncReminder = useCallback(async () => {
    setReminder(await refreshDailyReminder());
  }, []);

  useEffect(() => {
    void load();
    void getNotifier().permissionStatus().then(setPermission);
    void syncReminder();
    return () => {
      if (savedTimer.current) clearTimeout(savedTimer.current);
    };
  }, []);

  const dirty =
    !!profile &&
    (hour !== profile.notification_hour ||
      timezone !== profile.timezone ||
      Math.abs(challenge - profile.challenge_frequency) > 1e-9 ||
      contentLevel !== profile.content_level);

  const saveProfile = useCallback(async () => {
    setSaveState("saving");
    setError("");
    try {
      const updated = await updateProfile({
        notification_hour: hour,
        timezone,
        challenge_frequency: challenge,
        content_level: contentLevel,
      });
      setProfile(updated);
      setSaveState("saved");
      if (savedTimer.current) clearTimeout(savedTimer.current);
      savedTimer.current = setTimeout(() => setSaveState("idle"), 2000);
      // The reminder is a native alarm — the DB row alone changes nothing on
      // device. Re-arm it now rather than waiting for the next Today mount.
      void syncReminder();
    } catch (e) {
      setSaveState("idle");
      setError(e instanceof Error ? e.message : "Could not save");
    }
  }, [hour, timezone, challenge, contentLevel, syncReminder]);

  // Auto-save: no Save button to hunt for, and no ambiguity about which
  // section a button belongs to.
  useEffect(() => {
    if (!dirty) return;
    const t = setTimeout(() => void saveProfile(), SAVE_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [dirty, saveProfile]);

  async function enableNotifications() {
    const granted = await getNotifier().ensurePermission();
    setPermission(await getNotifier().permissionStatus());
    if (granted) void syncReminder();
  }

  async function sendTest() {
    setTestBusy(true);
    setTestMsg("");
    try {
      await getNotifier().sendTest(10);
      // Report what the OS actually has queued — if this says 0, the alarm was
      // never registered and the problem is scheduling, not display.
      const pending = await getNotifier().pendingIds();
      setTestMsg(
        `Test scheduled — arrives in about 10 seconds. (${pending.length} pending: ${
          pending.join(", ") || "none"
        })`,
      );
      setPermission(await getNotifier().permissionStatus());
    } catch (e) {
      setTestMsg(e instanceof Error ? e.message : "Could not send test");
    } finally {
      setTestBusy(false);
      setTimeout(() => setTestMsg(""), 8000);
    }
  }

  async function chooseFocus(topicId: string | null) {
    setFocusBusy(true);
    setError("");
    try {
      if (topicId) await setFocusTopic(topicId);
      else await clearFocusTopic();
      setTopics(await fetchActiveTopics());
      // Focus decides which thread the reminder is about.
      void syncReminder();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not update focus");
    } finally {
      setFocusBusy(false);
    }
  }

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <span className="font-display text-2xl italic text-muted">Settings…</span>
      </div>
    );
  }

  const focusId = topics.find((t) => t.focus)?.id ?? null;

  return (
    <div className="mx-auto min-h-screen max-w-lg px-6 pb-28 pt-6">
      <header className="mb-6 flex items-baseline justify-between">
        <div>
          <p className="text-sm font-semibold uppercase tracking-[0.2em] text-moss">Your rhythm</p>
          <h1 className="font-display text-3xl font-medium">Settings</h1>
        </div>
        <SaveIndicator state={saveState} dirty={dirty} />
      </header>

      {error && (
        <p className="mb-4 rounded-xl bg-rust-soft px-4 py-2.5 text-sm font-semibold text-rust">
          {error}
        </p>
      )}

      {/* Daily reminder */}
      <section className="rounded-2xl border border-hairline bg-surface p-5">
        <h2 className="font-display text-xl">Daily reminder</h2>

        <label className="mt-4 block text-sm font-semibold text-muted" htmlFor="s-hour">
          Time
        </label>
        <select
          id="s-hour"
          value={hour}
          onChange={(e) => setHour(Number(e.target.value))}
          className="mt-1.5 w-full rounded-xl border border-hairline bg-paper px-4 py-3 outline-none focus:border-moss"
        >
          {Array.from({ length: 24 }, (_, h) => (
            <option key={h} value={h}>
              {hourLabel(h)}
            </option>
          ))}
        </select>

        <label className="mt-4 block text-sm font-semibold text-muted" htmlFor="s-tz">
          Timezone
        </label>
        <select
          id="s-tz"
          value={timezone}
          onChange={(e) => setTimezone(e.target.value)}
          className="mt-1.5 w-full rounded-xl border border-hairline bg-paper px-4 py-3 outline-none focus:border-moss"
        >
          {!tzList.includes(timezone) && <option value={timezone}>{timezone}</option>}
          {tzList.map((tz) => (
            <option key={tz} value={tz}>
              {tz}
            </option>
          ))}
        </select>
        <p className="mt-2 text-xs text-muted">
          Entries generate and your reminder fires at this local time. Changes save on their own.
        </p>

        <ReminderStatus state={reminder} />

        <NotificationStatus
          permission={permission}
          onEnable={() => void enableNotifications()}
          onTest={() => void sendTest()}
          testBusy={testBusy}
          testMsg={testMsg}
        />
      </section>

      {/* Content level */}
      <section className="mt-5 rounded-2xl border border-hairline bg-surface p-5">
        <h2 className="font-display text-xl">How much to read</h2>
        <p className="mt-1 text-sm text-muted">
          How much of an entry is open when you land on it. Nothing is taken away — whatever
          you fold up is one tap away on the day you have time for it.
        </p>

        <div
          role="radiogroup"
          aria-label="How much to read"
          className="mt-4 grid grid-cols-3 gap-2"
        >
          {CONTENT_LEVELS.map((opt) => {
            const active = contentLevel === opt.value;
            return (
              <button
                key={opt.value}
                type="button"
                role="radio"
                aria-checked={active}
                onClick={() => {
                  setLevel(opt.value);
                  // Write the mirror immediately: the reader should see the
                  // change on Today without waiting for the debounced save.
                  setContentLevel(opt.value);
                }}
                className={`rounded-xl border px-3 py-3 text-left transition-colors ${
                  active
                    ? "border-moss bg-moss-soft"
                    : "border-hairline bg-paper hover:border-moss"
                }`}
              >
                <span
                  className={`block text-[15px] font-semibold ${active ? "text-moss" : ""}`}
                >
                  {opt.label}
                </span>
                <span className="mt-0.5 block text-xs leading-snug text-muted">
                  {opt.detail}
                </span>
              </button>
            );
          })}
        </div>
      </section>

      {/* Challenge frequency */}
      <section className="mt-5 rounded-2xl border border-hairline bg-surface p-5">
        <div className="flex items-baseline justify-between">
          <h2 className="font-display text-xl">Challenge entries</h2>
          <span className="font-display text-2xl text-moss">{Math.round(challenge * 100)}%</span>
        </div>
        <input
          type="range"
          min={0}
          max={0.5}
          step={0.05}
          value={challenge}
          onChange={(e) => setChallenge(Number(e.target.value))}
          className="mt-3 w-full accent-moss"
        />
        <p className="mt-2 text-sm leading-relaxed text-muted">
          How often an entry questions your framing instead of affirming it. A discernment tool
          needs some friction — 0% means every entry sits inside your current sense of the thread.
        </p>
      </section>

      {/* Focus thread */}
      <section className="mt-5 rounded-2xl border border-hairline bg-surface p-5">
        <h2 className="font-display text-xl">Focus thread</h2>
        <p className="mt-1 text-sm text-muted">
          The thread your daily notification centres on. Choose “Rotate” to cycle through all
          active threads.
        </p>

        <div className="mt-4 space-y-1">
          <FocusOption
            label="Rotate among active threads"
            checked={focusId === null}
            disabled={focusBusy}
            onSelect={() => void chooseFocus(null)}
          />
          {topics.map((t) => (
            <FocusOption
              key={t.id}
              label={t.title}
              checked={focusId === t.id}
              disabled={focusBusy}
              onSelect={() => void chooseFocus(t.id)}
            />
          ))}
          {topics.length === 0 && (
            <p className="py-2 text-sm text-muted">No active threads to focus on yet.</p>
          )}
        </div>
      </section>

      <SubscriptionSection />

      <AccountSection />
    </div>
  );
}

function SaveIndicator({ state, dirty }: { state: SaveState; dirty: boolean }) {
  const text =
    state === "saving" ? "Saving…" : state === "saved" ? "Saved" : dirty ? "Unsaved" : "";
  if (!text) return null;
  return (
    <span
      className={`text-sm font-semibold ${state === "saved" ? "text-moss" : "text-muted"}`}
      aria-live="polite"
    >
      {text}
    </span>
  );
}

/** Says, in plain language, whether a reminder is actually armed and when. */
function ReminderStatus({ state }: { state: ReminderState | null }) {
  if (!state || state.kind === "unsupported") return null;

  let tone = "text-muted";
  let text: string;
  switch (state.kind) {
    case "scheduled": {
      tone = "text-moss";
      // The OS alarm fires in device time. When that differs from the profile
      // timezone, say so rather than showing an hour the phone won't match.
      const device = deviceTimezone();
      const zoneNote =
        device && device !== state.timezone ? ` — ${state.deviceLocal} on this device` : "";
      text = `Next reminder ${hourLabel(state.hour)}${zoneNote} · ${state.topicTitle}${
        state.hasEntry ? "" : " (today's entry not generated yet)"
      }`;
      break;
    }
    case "no-thread":
      text = "No active thread — nothing to remind you about yet. Create one and this turns on.";
      break;
    case "no-permission":
      text = "Reminder not scheduled — notifications are turned off.";
      break;
    case "error":
      tone = "text-rust";
      text = `Reminder not scheduled: ${state.message}`;
      break;
  }

  return (
    <p className={`mt-3 text-xs font-semibold ${tone}`} aria-live="polite">
      {text}
    </p>
  );
}

function NotificationStatus({
  permission,
  onEnable,
  onTest,
  testBusy,
  testMsg,
}: {
  permission: PermissionStatus;
  onEnable: () => void;
  onTest: () => void;
  testBusy: boolean;
  testMsg: string;
}) {
  if (permission === "unsupported") {
    return (
      <p className="mt-4 rounded-xl bg-paper px-4 py-2.5 text-xs text-muted">
        Reminders only arrive in the installed app, not in the browser.
      </p>
    );
  }

  return (
    <div className="mt-4 border-t border-hairline pt-4">
      {permission === "granted" && (
        <div className="flex items-center justify-between gap-3">
          <span className="text-sm font-semibold text-moss">Notifications on</span>
          <button
            onClick={onTest}
            disabled={testBusy}
            className="pressable min-h-[40px] rounded-xl border border-hairline px-4 text-sm font-semibold disabled:opacity-50"
          >
            {testBusy ? "Sending…" : "Send test"}
          </button>
        </div>
      )}

      {permission === "prompt" && (
        <button
          onClick={onEnable}
          className="pressable min-h-[48px] w-full rounded-xl bg-moss font-semibold text-white"
        >
          Turn on notifications
        </button>
      )}

      {permission === "denied" && (
        <p className="rounded-xl bg-rust-soft px-4 py-2.5 text-sm font-semibold text-rust">
          Notifications are turned off for Ponder. Enable them in your phone’s Settings → Apps →
          Ponder → Notifications, then reopen this screen.
        </p>
      )}

      {testMsg && <p className="mt-2 text-xs text-muted">{testMsg}</p>}
    </div>
  );
}

function FocusOption({
  label,
  checked,
  disabled,
  onSelect,
}: {
  label: string;
  checked: boolean;
  disabled: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      onClick={onSelect}
      disabled={disabled}
      className="pressable flex min-h-[48px] w-full items-center gap-3 rounded-xl px-2 text-left disabled:opacity-60"
    >
      <span
        className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2 ${
          checked ? "border-moss" : "border-hairline"
        }`}
      >
        {checked && <span className="h-2.5 w-2.5 rounded-full bg-moss" />}
      </span>
      <span className={`text-[15px] ${checked ? "font-semibold" : ""}`}>{label}</span>
    </button>
  );
}
