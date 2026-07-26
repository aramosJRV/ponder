import { useEffect, useMemo, useState } from "react";
import {
  clearFocusTopic,
  fetchActiveTopics,
  fetchProfile,
  setFocusTopic,
  updateProfile,
} from "../lib/api";
import AccountSection from "../components/AccountSection";
import type { Profile, Topic } from "../lib/types";

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

function hourLabel(h: number): string {
  const period = h < 12 ? "AM" : "PM";
  const twelve = h % 12 === 0 ? 12 : h % 12;
  return `${twelve}:00 ${period}`;
}

export default function Settings() {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [topics, setTopics] = useState<Topic[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  // editable profile fields
  const [hour, setHour] = useState(4);
  const [timezone, setTimezone] = useState("UTC");
  const [challenge, setChallenge] = useState(0.25);
  const [savingProfile, setSavingProfile] = useState(false);
  const [savedMsg, setSavedMsg] = useState("");

  const [focusBusy, setFocusBusy] = useState(false);

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
      }
      setTopics(t);
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load settings");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  const dirty =
    !!profile &&
    (hour !== profile.notification_hour ||
      timezone !== profile.timezone ||
      Math.abs(challenge - profile.challenge_frequency) > 1e-9);

  async function saveProfile() {
    setSavingProfile(true);
    setSavedMsg("");
    setError("");
    try {
      const updated = await updateProfile({
        notification_hour: hour,
        timezone,
        challenge_frequency: challenge,
      });
      setProfile(updated);
      setSavedMsg("Saved");
      setTimeout(() => setSavedMsg(""), 2000);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save");
    } finally {
      setSavingProfile(false);
    }
  }

  async function chooseFocus(topicId: string | null) {
    setFocusBusy(true);
    setError("");
    try {
      if (topicId) await setFocusTopic(topicId);
      else await clearFocusTopic();
      setTopics(await fetchActiveTopics());
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
      <header className="mb-6">
        <p className="text-sm font-semibold uppercase tracking-[0.2em] text-moss">Your rhythm</p>
        <h1 className="font-display text-3xl font-medium">Settings</h1>
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
          Entries generate and your reminder fires at this local time.
        </p>
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
          needs some friction — 0% means every entry sits inside your current sense of the topic.
        </p>
      </section>

      <button
        onClick={() => void saveProfile()}
        disabled={!dirty || savingProfile}
        className="pressable mt-5 min-h-[48px] w-full rounded-xl bg-moss font-semibold text-white disabled:opacity-50"
      >
        {savingProfile ? "Saving…" : savedMsg || "Save changes"}
      </button>

      {/* Focus topic */}
      <section className="mt-8 rounded-2xl border border-hairline bg-surface p-5">
        <h2 className="font-display text-xl">Focus topic</h2>
        <p className="mt-1 text-sm text-muted">
          The topic your daily notification centres on. Choose “Rotate” to cycle through all
          active topics.
        </p>

        <div className="mt-4 space-y-1">
          <FocusOption
            label="Rotate among active topics"
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
            <p className="py-2 text-sm text-muted">No active topics to focus on yet.</p>
          )}
        </div>
      </section>

      <AccountSection />
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
