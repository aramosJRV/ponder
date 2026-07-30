import { useEffect, useState } from "react";
import {
  createTopic,
  fetchAllTopics,
  fetchTopicStats,
  parseVerseRef,
  setFocusTopic,
  setTopicStatus,
  type TopicStats,
} from "../lib/api";
import type { ResolvedVerseRef, Topic } from "../lib/types";
import StatusChip from "../components/StatusChip";
import ConclusionFlow from "../components/ConclusionFlow";

interface Props {
  onOpenTopic: (id: string) => void;
  /** When true, open the New Topic sheet on mount (e.g. arriving from
   *  onboarding's "Create my first thread"). */
  autoOpenCreate?: boolean;
  /** Called once the auto-open has been honored, so it fires only once. */
  onAutoOpenConsumed?: () => void;
}

export default function Topics({
  onOpenTopic,
  autoOpenCreate = false,
  onAutoOpenConsumed,
}: Props) {
  const [topics, setTopics] = useState<Topic[]>([]);
  const [stats, setStats] = useState<Record<string, TopicStats>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const [concluding, setConcluding] = useState<Topic | null>(null);

  async function load() {
    try {
      const [t, s] = await Promise.all([fetchAllTopics(), fetchTopicStats()]);
      setTopics(t);
      setStats(s);
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load threads");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  useEffect(() => {
    if (autoOpenCreate) {
      setShowCreate(true);
      onAutoOpenConsumed?.();
    }
  }, [autoOpenCreate, onAutoOpenConsumed]);

  async function act(fn: () => Promise<void>) {
    try {
      await fn();
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Action failed");
    }
  }

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <span className="font-display text-2xl italic text-muted">Threads…</span>
      </div>
    );
  }

  return (
    <div className="mx-auto min-h-screen max-w-lg px-6 pb-28 pt-6">
      <header className="mb-6 flex items-center justify-between">
        <div>
          <p className="text-sm font-semibold uppercase tracking-[0.2em] text-moss">Listening to</p>
          <h1 className="font-display text-3xl font-medium">Threads</h1>
        </div>
        <button
          onClick={() => setShowCreate(true)}
          className="pressable min-h-[44px] rounded-xl bg-moss px-4 text-sm font-semibold text-white"
        >
          + New thread
        </button>
      </header>

      {error && (
        <p className="mb-4 rounded-xl bg-rust-soft px-4 py-2.5 text-sm font-semibold text-rust">
          {error}
        </p>
      )}

      <ul className="space-y-4">
        {topics.map((t, i) => {
          const s = stats[t.id] ?? { entryCount: 0, lastNote: null };
          return (
            <li
              key={t.id}
              className="animate-rise"
              style={{ animationDelay: `${i * 60}ms` }}
            >
              <button
                onClick={() => onOpenTopic(t.id)}
                className="pressable w-full rounded-2xl border border-hairline bg-surface p-5 text-left"
              >
                <div className="flex items-start justify-between gap-3">
                  <h2 className="font-display text-2xl font-medium leading-tight">
                    {t.focus && <span className="mr-1.5 text-moss">●</span>}
                    {t.title}
                  </h2>
                  <StatusChip status={t.status} />
                </div>
                <p className="mt-1 text-sm text-muted">
                  {s.entryCount} {s.entryCount === 1 ? "day" : "days"} of entries
                </p>
                {s.lastNote && (
                  <p className="mt-3 border-l-2 border-hairline pl-3 text-sm italic leading-relaxed text-ink/80">
                    “{s.lastNote.body.length > 120 ? s.lastNote.body.slice(0, 120) + "…" : s.lastNote.body}”
                  </p>
                )}
              </button>

              {t.status !== "concluded" && (
                <div className="mt-2 flex gap-2 px-1">
                  {t.status === "active" && !t.focus && (
                    <TopicAction label="Make focus" onClick={() => act(() => setFocusTopic(t.id))} />
                  )}
                  {t.status === "active" ? (
                    <TopicAction label="Pause" onClick={() => act(() => setTopicStatus(t.id, "paused"))} />
                  ) : (
                    <TopicAction label="Resume" onClick={() => act(() => setTopicStatus(t.id, "active"))} />
                  )}
                  <TopicAction
                    label="Conclude"
                    tone="rust"
                    onClick={() => setConcluding(t)}
                  />
                </div>
              )}
            </li>
          );
        })}
      </ul>

      {showCreate && (
        <CreateTopicSheet
          onClose={() => setShowCreate(false)}
          onCreated={() => {
            setShowCreate(false);
            void load();
          }}
        />
      )}

      {concluding && (
        <ConclusionFlow
          topic={concluding}
          onClose={() => setConcluding(null)}
          onConcluded={() => {
            setConcluding(null);
            void load();
          }}
        />
      )}
    </div>
  );
}

function TopicAction({
  label,
  onClick,
  tone = "muted",
}: {
  label: string;
  onClick: () => void;
  tone?: "muted" | "rust";
}) {
  return (
    <button
      onClick={onClick}
      className={`pressable min-h-[40px] rounded-lg px-3 text-sm font-semibold ${
        tone === "rust" ? "text-rust" : "text-muted"
      }`}
    >
      {label}
    </button>
  );
}

function CreateTopicSheet({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: () => void;
}) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [focus, setFocus] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  // seed verse: what the user typed, and the resolved passage (if any)
  const [seedInput, setSeedInput] = useState("");
  const [seed, setSeed] = useState<ResolvedVerseRef | null>(null);
  const [seedState, setSeedState] = useState<"idle" | "checking" | "ok" | "bad">("idle");

  // debounced lookup against the same SQL the DB trigger uses
  useEffect(() => {
    const raw = seedInput.trim();
    if (!raw) {
      setSeed(null);
      setSeedState("idle");
      return;
    }
    setSeedState("checking");
    let cancelled = false;
    const t = setTimeout(async () => {
      try {
        const hit = await parseVerseRef(raw);
        if (cancelled) return;
        setSeed(hit);
        setSeedState(hit ? "ok" : "bad");
      } catch {
        if (cancelled) return;
        setSeed(null);
        setSeedState("bad");
      }
    }, 350);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [seedInput]);

  const seedPending = seedInput.trim().length > 0 && seedState !== "ok";

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (seedPending) {
      setError("That verse reference doesn't resolve — fix or clear it.");
      return;
    }
    setSaving(true);
    setError("");
    try {
      await createTopic({
        title: title.trim(),
        description: description.trim(),
        focus,
        seed: seed
          ? {
              book_number: seed.book_number,
              chapter: seed.chapter,
              verse_start: seed.verse_start,
              verse_end: seed.verse_end,
            }
          : null,
      });
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create thread");
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-30 flex items-end justify-center bg-ink/40" onClick={onClose}>
      <form
        onSubmit={save}
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-lg animate-rise rounded-t-3xl bg-paper p-6 pb-[max(1.5rem,env(safe-area-inset-bottom))]"
      >
        <h2 className="font-display text-3xl font-medium">New thread</h2>
        <p className="mt-1 text-sm text-muted">
          What do you sense God may be speaking about?
        </p>

        <label className="mt-5 block text-sm font-semibold text-muted" htmlFor="t-title">
          Title
        </label>
        <input
          id="t-title"
          required
          maxLength={120}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="e.g. Patience with my father"
          className="mt-1.5 w-full rounded-xl border border-hairline bg-surface px-4 py-3 outline-none focus:border-moss"
        />

        <label className="mt-4 block text-sm font-semibold text-muted" htmlFor="t-desc">
          In your own words
        </label>
        <textarea
          id="t-desc"
          rows={3}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="What you're noticing, what prompted this, what you're asking…"
          className="mt-1.5 w-full resize-none rounded-xl border border-hairline bg-surface px-4 py-3 outline-none focus:border-moss"
        />

        <label className="mt-4 block text-sm font-semibold text-muted" htmlFor="t-seed">
          Verse that prompted this{" "}
          <span className="font-normal text-muted/70">— optional</span>
        </label>
        <input
          id="t-seed"
          value={seedInput}
          onChange={(e) => setSeedInput(e.target.value)}
          placeholder="e.g. Psalm 46:10 or 1 Corinthians 13:4-7"
          autoCapitalize="words"
          autoCorrect="off"
          spellCheck={false}
          className={`mt-1.5 w-full rounded-xl border bg-surface px-4 py-3 outline-none ${
            seedState === "bad"
              ? "border-rust focus:border-rust"
              : "border-hairline focus:border-moss"
          }`}
        />
        {seedState === "checking" && (
          <p className="mt-1.5 text-sm text-muted">Looking it up…</p>
        )}
        {seedState === "bad" && (
          <p className="mt-1.5 text-sm text-rust">
            Not found in the World English Bible. Try “Book chapter:verse”.
          </p>
        )}
        {seedState === "ok" && seed && (
          <blockquote className="mt-2 rounded-xl border-l-2 border-moss bg-surface px-4 py-3">
            <p className="text-sm font-semibold text-moss">{seed.verse_ref}</p>
            <p className="mt-1 text-[15px] italic leading-relaxed text-ink/85">
              {seed.verse_text}
            </p>
          </blockquote>
        )}

        <label className="mt-4 flex min-h-[44px] items-center gap-3">
          <input
            type="checkbox"
            checked={focus}
            onChange={(e) => setFocus(e.target.checked)}
            className="h-5 w-5 accent-moss"
          />
          <span className="text-sm">
            Make this the <span className="font-semibold">focus thread</span> (daily notification)
          </span>
        </label>

        {error && <p className="mt-3 text-sm text-rust">{error}</p>}

        <div className="mt-6 flex gap-3">
          <button
            type="button"
            onClick={onClose}
            className="pressable min-h-[48px] flex-1 rounded-xl border border-hairline bg-surface font-semibold"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={saving || !title.trim() || seedPending}
            className="pressable min-h-[48px] flex-1 rounded-xl bg-moss font-semibold text-white disabled:opacity-50"
          >
            {saving ? "Creating…" : "Create thread"}
          </button>
        </div>
      </form>
    </div>
  );
}
