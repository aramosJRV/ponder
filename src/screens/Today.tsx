import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "../lib/supabase";
import {
  fetchActiveTopics,
  fetchEntriesForDate,
  fetchNotesForEntries,
  fetchProfile,
  generateEntryNow,
} from "../lib/api";
import { getNotifier, scheduleDailyVerse } from "../lib/notifications";
import { loadTodayCache, saveTodayCache } from "../lib/cache";
import { formatLongDate, todayLocal } from "../lib/dates";
import type { DailyEntry, Note, Topic } from "../lib/types";
import TopicSwitcher from "../components/TopicSwitcher";
import EntryCard from "../components/EntryCard";
import NoteComposer from "../components/NoteComposer";

type LoadState = "loading" | "ready" | "error";

export default function Today() {
  const date = todayLocal();
  const [state, setState] = useState<LoadState>("loading");
  const [offline, setOffline] = useState(false);
  const [topics, setTopics] = useState<Topic[]>([]);
  const [entries, setEntries] = useState<DailyEntry[]>([]);
  const [notes, setNotes] = useState<Note[]>([]);
  const [selectedTopicId, setSelectedTopicId] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const [genError, setGenError] = useState("");

  const load = useCallback(async () => {
    try {
      const t = await fetchActiveTopics();
      const e = await fetchEntriesForDate(date);
      const n = await fetchNotesForEntries(e.map((x) => x.id));
      setTopics(t);
      setEntries(e);
      setNotes(n);
      setOffline(false);
      setState("ready");
      saveTodayCache({ date, topics: t, entries: e, notes: n });
      setSelectedTopicId((cur) => cur ?? t.find((x) => x.focus)?.id ?? t[0]?.id ?? null);

      // Schedule the daily verse reminder for the focus/rotating topic. Native
      // only (no-ops on web) and fire-and-forget so it never blocks the screen.
      // fetchActiveTopics orders focus first, so t[0] is the notification topic.
      const notifyTopic = t[0] ?? null;
      const notifyEntry = notifyTopic
        ? e.find((x) => x.topic_id === notifyTopic.id) ?? null
        : null;
      if (getNotifier().isSupported() && notifyTopic && notifyEntry) {
        void (async () => {
          try {
            const profile = await fetchProfile();
            await scheduleDailyVerse({
              topic: notifyTopic,
              entry: notifyEntry,
              notificationHour: profile?.notification_hour ?? 4,
            });
          } catch {
            /* notifications are best-effort */
          }
        })();
      }
    } catch {
      const cached = loadTodayCache(date);
      if (cached) {
        setTopics(cached.topics);
        setEntries(cached.entries);
        setNotes(cached.notes);
        setOffline(true);
        setState("ready");
        setSelectedTopicId(
          (cur) => cur ?? cached.topics.find((x) => x.focus)?.id ?? cached.topics[0]?.id ?? null,
        );
      } else {
        setState("error");
      }
    }
  }, [date]);

  useEffect(() => {
    void load();
  }, [load]);

  const selectedTopic = useMemo(
    () => topics.find((t) => t.id === selectedTopicId) ?? null,
    [topics, selectedTopicId],
  );
  const entry = useMemo(
    () => entries.find((e) => e.topic_id === selectedTopicId) ?? null,
    [entries, selectedTopicId],
  );
  const entryNotes = useMemo(
    () => (entry ? notes.filter((n) => n.entry_id === entry.id) : []),
    [notes, entry],
  );

  async function generate() {
    if (!selectedTopicId) return;
    setGenerating(true);
    setGenError("");
    try {
      await generateEntryNow(selectedTopicId);
      await load();
    } catch (e) {
      setGenError(e instanceof Error ? e.message : "Generation failed");
    } finally {
      setGenerating(false);
    }
  }

  if (state === "loading") {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <span className="font-display text-2xl italic text-muted">Gathering today…</span>
      </div>
    );
  }

  if (state === "error") {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center px-8 text-center">
        <p className="font-display text-3xl">Nothing to show yet</p>
        <p className="mt-2 max-w-xs text-muted">
          Couldn't reach the server and there's no synced copy of today on this device.
        </p>
        <button
          onClick={() => void load()}
          className="pressable mt-6 min-h-[44px] rounded-xl bg-moss px-6 font-semibold text-white"
        >
          Try again
        </button>
      </div>
    );
  }

  return (
    <div className="mx-auto min-h-screen max-w-lg px-6 pb-28 pt-6">
      <header className="mb-6 flex items-start justify-between">
        <div>
          <p className="text-sm font-semibold uppercase tracking-[0.2em] text-moss">Today</p>
          <h1 className="font-display text-3xl font-medium">{formatLongDate(date)}</h1>
        </div>
        <button
          onClick={() => void supabase.auth.signOut()}
          className="pressable min-h-[44px] text-sm font-semibold text-muted"
        >
          Sign out
        </button>
      </header>

      {offline && (
        <p className="mb-4 rounded-xl bg-rust-soft px-4 py-2.5 text-sm font-semibold text-rust">
          Offline — showing your synced copy of today
        </p>
      )}

      <TopicSwitcher topics={topics} selectedId={selectedTopicId} onSelect={setSelectedTopicId} />

      {topics.length === 0 && (
        <div className="rounded-2xl border border-hairline bg-surface p-6">
          <p className="font-display text-2xl">No topics yet</p>
          <p className="mt-2 text-muted">
            Topics are what you sense God may be speaking about. Head to the Topics tab to start
            one — today's entry will appear here once it's generated.
          </p>
        </div>
      )}

      {selectedTopic && entry && (
        <>
          <p className="mb-4 text-sm text-muted">
            <span className="font-semibold text-ink">{selectedTopic.title}</span>
            {selectedTopic.focus && " · focus"}
          </p>
          <EntryCard entry={entry} />
          <NoteComposer
            entry={entry}
            notes={entryNotes}
            offline={offline}
            onAdded={(n) => setNotes((cur) => [...cur, n])}
          />
        </>
      )}

      {selectedTopic && !entry && (
        <div className="animate-rise rounded-2xl border border-hairline bg-surface p-6">
          <p className="font-display text-2xl">No entry yet for this topic</p>
          <p className="mt-2 text-muted">
            Tonight's generation hasn't run for “{selectedTopic.title}” — or the topic is new.
            You can generate today's entry now.
          </p>
          <button
            onClick={() => void generate()}
            disabled={generating || offline}
            className="pressable mt-5 min-h-[44px] w-full rounded-xl bg-moss py-3 font-semibold text-white disabled:opacity-60"
          >
            {generating ? "Listening for a word…" : "Generate today's entry"}
          </button>
          {genError && <p className="mt-3 text-sm text-rust">{genError}</p>}
        </div>
      )}
    </div>
  );
}
