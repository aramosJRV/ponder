import { useCallback, useEffect, useMemo, useState } from "react";
import {
  fetchActiveTopics,
  fetchEntriesForDate,
  fetchNotesForEntries,
  generateEntryNow,
} from "../lib/api";
import { GenerationDelayedError } from "../lib/entitlements";
import { refreshDailyReminder } from "../lib/notifications";
import { loadTodayCache, saveTodayCache } from "../lib/cache";
import { errorCopy, logError, type ErrorKind } from "../lib/errors";
import { formatLongDate, todayLocal } from "../lib/dates";
import type { DailyEntry, Note, Topic } from "../lib/types";
import TopicSwitcher from "../components/TopicSwitcher";
import EntryCard from "../components/EntryCard";
import NoteComposer from "../components/NoteComposer";

type LoadState = "loading" | "ready" | "error";

export default function Today() {
  const date = todayLocal();
  const [state, setState] = useState<LoadState>("loading");
  const [failure, setFailure] = useState<{ kind: ErrorKind; code: string } | null>(null);
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

      // (Re)schedule the daily verse reminder. Native only (no-ops on web) and
      // fire-and-forget so it never blocks the screen. Settings calls the same
      // helper after a save, so the two paths can't drift.
      void refreshDailyReminder();
    } catch (e) {
      // Never a bare catch here again: one message for four causes is exactly
      // what hid the 25 Aug column-grant outage behind "couldn't reach the
      // server". Classify first, then fall back.
      const failed = logError("Today.load", e);
      setFailure({ kind: failed.kind, code: failed.code });
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
      // GenerationDelayedError already carries user-safe wording; anything
      // else gets the same treatment rather than leaking an upstream message.
      setGenError(
        e instanceof GenerationDelayedError
          ? e.message
          : "Today's entry is running late. Try again in a little while.",
      );
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
    const copy = errorCopy(failure?.kind ?? "unknown");
    return (
      <div className="flex min-h-screen flex-col items-center justify-center px-8 text-center">
        <p className="font-display text-3xl">{copy.title}</p>
        <p className="mt-2 max-w-xs text-muted">{copy.body}</p>
        {failure && failure.kind !== "offline" && (
          // A tester's screenshot should be enough to diagnose this.
          <p className="mt-3 font-mono text-xs uppercase tracking-wider text-muted">
            code {failure.code}
          </p>
        )}
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
      <header className="mb-6">
        <p className="text-sm font-semibold uppercase tracking-[0.2em] text-moss">Today</p>
        <h1 className="font-display text-3xl font-medium">{formatLongDate(date)}</h1>
      </header>

      {offline && (
        <p className="mb-4 rounded-xl bg-rust-soft px-4 py-2.5 text-sm font-semibold text-rust">
          Offline — showing your synced copy of today
        </p>
      )}

      <TopicSwitcher topics={topics} selectedId={selectedTopicId} onSelect={setSelectedTopicId} />

      {topics.length === 0 && (
        <div className="rounded-2xl border border-hairline bg-surface p-6">
          <p className="font-display text-2xl">No threads yet</p>
          <p className="mt-2 text-muted">
            Threads are what you sense God may be speaking about. Head to the Threads tab to start
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
          <EntryCard
            entry={entry}
            notes={entryNotes}
            offline={offline}
            onNoteAdded={(n) => setNotes((cur) => [...cur, n])}
          />
          {/* The general composer stays. A note that belongs to the whole day
              rather than to one question is still the common case, and it is
              where every note written before 8 Sep 2026 lives. It shows only
              the general notes now — per-question ones appear against their
              question inside the card. */}
          <NoteComposer
            entry={entry}
            notes={entryNotes.filter((n) => n.ponder_index == null)}
            offline={offline}
            onAdded={(n) => setNotes((cur) => [...cur, n])}
          />
        </>
      )}

      {selectedTopic && !entry && (
        <div className="animate-rise rounded-2xl border border-hairline bg-surface p-6">
          <p className="font-display text-2xl">
            {genError ? "Still coming" : "No entry yet for this thread"}
          </p>
          <p className="mt-2 text-muted">
            {genError
              ? `Today's entry for “${selectedTopic.title}” hasn't landed yet. Nothing is lost — try again shortly.`
              : `Today's generation hasn't landed yet for “${selectedTopic.title}” — or the thread is new. You can generate it now.`}
          </p>
          <button
            onClick={() => void generate()}
            disabled={generating || offline}
            className="pressable mt-5 min-h-[44px] w-full rounded-xl bg-moss py-3 font-semibold text-white disabled:opacity-60"
          >
            {generating ? "Listening for a word…" : "Generate today's entry"}
          </button>
          {genError && <p className="mt-3 text-sm text-muted">{genError}</p>}
        </div>
      )}
    </div>
  );
}
