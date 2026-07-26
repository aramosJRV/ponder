import { useEffect, useMemo, useState } from "react";
import {
  fetchAllTopics,
  fetchSyntheses,
  fetchTopicEntries,
  fetchTopicNotes,
  generateSynthesis,
} from "../lib/api";
import { formatLongDate } from "../lib/dates";
import type { DailyEntry, Note, Synthesis, Topic } from "../lib/types";
import EntryCard from "../components/EntryCard";
import StatusChip from "../components/StatusChip";
import SynthesisCard from "../components/SynthesisCard";

type DetailTab = "entries" | "journal" | "synthesis";

interface Props {
  topicId: string;
  onBack: () => void;
}

export default function TopicDetail({ topicId, onBack }: Props) {
  const [topic, setTopic] = useState<Topic | null>(null);
  const [entries, setEntries] = useState<DailyEntry[]>([]);
  const [notes, setNotes] = useState<Note[]>([]);
  const [syntheses, setSyntheses] = useState<Synthesis[]>([]);
  const [tab, setTab] = useState<DetailTab>("entries");
  const [openEntryId, setOpenEntryId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [synthesizing, setSynthesizing] = useState(false);
  const [synthError, setSynthError] = useState("");

  useEffect(() => {
    (async () => {
      try {
        const [topics, e, n, s] = await Promise.all([
          fetchAllTopics(),
          fetchTopicEntries(topicId),
          fetchTopicNotes(topicId),
          fetchSyntheses(topicId),
        ]);
        setTopic(topics.find((t) => t.id === topicId) ?? null);
        setEntries(e);
        setNotes(n);
        setSyntheses(s);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not load topic");
      } finally {
        setLoading(false);
      }
    })();
  }, [topicId]);

  async function runSynthesis() {
    setSynthesizing(true);
    setSynthError("");
    try {
      const s = await generateSynthesis(topicId, "on_demand");
      setSyntheses((cur) => [s, ...cur]);
    } catch (err) {
      setSynthError(err instanceof Error ? err.message : "Synthesis failed");
    } finally {
      setSynthesizing(false);
    }
  }

  const entryByDate = useMemo(() => {
    const map = new Map<string, DailyEntry>();
    for (const e of entries) map.set(e.id, e);
    return map;
  }, [entries]);

  const openEntry = openEntryId ? entryByDate.get(openEntryId) ?? null : null;

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <span className="font-display text-2xl italic text-muted">Opening…</span>
      </div>
    );
  }

  if (!topic) {
    return (
      <div className="mx-auto max-w-lg px-6 pt-10">
        <button onClick={onBack} className="pressable text-sm font-semibold text-muted">
          ← Back
        </button>
        <p className="mt-6 text-muted">{error || "Topic not found."}</p>
      </div>
    );
  }

  // Entry viewer overlays the detail screen
  if (openEntry) {
    return (
      <div className="mx-auto min-h-screen max-w-lg px-6 pb-28 pt-6">
        <button
          onClick={() => setOpenEntryId(null)}
          className="pressable mb-4 min-h-[44px] text-sm font-semibold text-muted"
        >
          ← {topic.title}
        </button>
        <p className="mb-4 font-display text-xl text-muted">{formatLongDate(openEntry.date)}</p>
        <EntryCard entry={openEntry} />
        <NotesForEntry notes={notes.filter((n) => n.entry_id === openEntry.id)} />
      </div>
    );
  }

  return (
    <div className="mx-auto min-h-screen max-w-lg px-6 pb-28 pt-6">
      <button onClick={onBack} className="pressable min-h-[44px] text-sm font-semibold text-muted">
        ← Topics
      </button>

      <header className="mb-2 mt-2">
        <div className="flex items-start justify-between gap-3">
          <h1 className="font-display text-3xl font-medium leading-tight">
            {topic.focus && <span className="mr-1.5 text-moss">●</span>}
            {topic.title}
          </h1>
          <StatusChip status={topic.status} />
        </div>
        {topic.description && (
          <p className="mt-2 text-[15px] leading-relaxed text-muted">{topic.description}</p>
        )}
      </header>

      <div className="mb-6 mt-5 flex rounded-xl border border-hairline bg-surface p-1">
        {(["entries", "journal", "synthesis"] as DetailTab[]).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`min-h-[40px] flex-1 rounded-lg text-sm font-semibold capitalize transition-colors ${
              tab === t ? "bg-moss text-white" : "text-muted"
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      {error && (
        <p className="mb-4 rounded-xl bg-rust-soft px-4 py-2.5 text-sm font-semibold text-rust">
          {error}
        </p>
      )}

      {tab === "entries" && (
        <ul className="space-y-3">
          {entries.length === 0 && (
            <p className="text-muted">No entries yet — the first one arrives with tonight's generation.</p>
          )}
          {entries.map((e) => {
            const noteCount = notes.filter((n) => n.entry_id === e.id).length;
            const challenge = e.entry_type === "challenge";
            return (
              <li key={e.id}>
                <button
                  onClick={() => setOpenEntryId(e.id)}
                  className="pressable w-full rounded-2xl border border-hairline bg-surface p-4 text-left"
                >
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-semibold text-muted">
                      {formatLongDate(e.date)}
                    </span>
                    {challenge && (
                      <span className="rounded-full bg-rust-soft px-2.5 py-0.5 text-[11px] font-bold uppercase tracking-wider text-rust">
                        challenge
                      </span>
                    )}
                  </div>
                  <p className="mt-1 font-display text-xl font-medium">{e.verse_ref}</p>
                  <p className="mt-1 line-clamp-2 text-sm leading-relaxed text-ink/80">
                    {e.thought}
                  </p>
                  {noteCount > 0 && (
                    <p className="mt-2 text-xs font-semibold text-moss">
                      {noteCount} {noteCount === 1 ? "note" : "notes"}
                    </p>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {tab === "journal" && (
        <div>
          {notes.length === 0 ? (
            <p className="text-muted">
              No notes yet. Notes you write on daily entries gather here as one journal.
            </p>
          ) : (
            <ul className="space-y-5">
              {notes.map((n) => {
                const entry = entries.find((e) => e.id === n.entry_id);
                return (
                  <li key={n.id} className="border-l-2 border-moss/40 pl-4">
                    <p className="text-xs font-bold uppercase tracking-wider text-muted">
                      {new Date(n.created_at).toLocaleDateString("en-AU", {
                        day: "numeric",
                        month: "short",
                      })}
                      {entry && <span className="ml-2 text-moss">{entry.verse_ref}</span>}
                    </p>
                    <p className="mt-1.5 whitespace-pre-wrap text-[15px] leading-relaxed">
                      {n.body}
                    </p>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}

      {tab === "synthesis" && (
        <div>
          <div className="rounded-2xl border border-hairline bg-surface p-5">
            <p className="font-display text-2xl">What's emerging?</p>
            <p className="mt-1.5 text-sm leading-relaxed text-muted">
              A reflective read of this topic's entries and notes — recurring threads, honest
              tensions, and a few next steps for prayer or study.
            </p>
            {topic.status !== "concluded" && (
              <button
                onClick={() => void runSynthesis()}
                disabled={synthesizing || (entries.length === 0 && notes.length === 0)}
                className="pressable mt-4 min-h-[44px] w-full rounded-xl bg-moss py-3 font-semibold text-white disabled:opacity-50"
              >
                {synthesizing
                  ? "Listening for the threads…"
                  : syntheses.length
                    ? "Refresh synthesis"
                    : "Generate synthesis"}
              </button>
            )}
            {entries.length === 0 && notes.length === 0 && (
              <p className="mt-2 text-xs text-muted">
                Nothing to synthesize yet — entries and notes feed this.
              </p>
            )}
            {synthError && <p className="mt-3 text-sm text-rust">{synthError}</p>}
          </div>

          {syntheses.length > 0 && (
            <div className="mt-5 space-y-5">
              {syntheses.map((s, i) => (
                <SynthesisCard key={s.id} synthesis={s} latest={i === 0} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function NotesForEntry({ notes }: { notes: Note[] }) {
  if (notes.length === 0) return null;
  return (
    <section className="mt-10 border-t border-hairline pt-6">
      <h2 className="mb-3 text-xs font-bold uppercase tracking-[0.18em] text-muted">
        Your notes that day
      </h2>
      <ul className="space-y-3">
        {notes.map((n) => (
          <li key={n.id} className="rounded-xl bg-moss-soft px-4 py-3">
            <p className="whitespace-pre-wrap text-[15px] leading-relaxed">{n.body}</p>
          </li>
        ))}
      </ul>
    </section>
  );
}
