import { useEffect, useState } from "react";
import {
  createTopic,
  fetchBookCatalogue,
  generateEntryNow,
  fetchAllTopics,
  fetchTopicStats,
  parseVerseRef,
  setTopicStatus,
  maxActiveThreadsForUser,
  type TopicStats,
} from "../lib/api";
import type { BookCatalogueRow, ResolvedVerseRef, Topic } from "../lib/types";
import StatusChip from "../components/StatusChip";
import ConclusionFlow from "../components/ConclusionFlow";
import { useKeyboardInset } from "../lib/keyboardInset";

interface Props {
  onOpenTopic: (id: string) => void;
  /** When true, open the New Topic sheet on mount (e.g. arriving from
   *  onboarding's "Create my first thread"). */
  autoOpenCreate?: boolean;
  /** Called once the auto-open has been honored, so it fires only once. */
  onAutoOpenConsumed?: () => void;
  /** Called after the user's FIRST thread is created, so the app can take them
   *  straight to Today where its entry is already waiting. Not fired for
   *  later threads — those shouldn't yank you off the list you're managing. */
  onFirstThreadCreated?: () => void;
}

export default function Topics({
  onOpenTopic,
  autoOpenCreate = false,
  onAutoOpenConsumed,
  onFirstThreadCreated,
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

  // The database enforces the cap; this just avoids letting someone fill in
  // the whole create sheet only to be rejected on submit.
  const activeCount = topics.filter((t) => t.status === "active").length;
  const threadCap = maxActiveThreadsForUser();
  const atCap = activeCount >= threadCap;

  return (
    <div className="mx-auto min-h-screen max-w-lg px-6 pb-28 pt-6">
      <header className="mb-6 flex items-center justify-between">
        <div>
          <p className="text-sm font-semibold uppercase tracking-[0.2em] text-moss">Listening to</p>
          <h1 className="font-display text-3xl font-medium">Threads</h1>
        </div>
        <button
          onClick={() => setShowCreate(true)}
          disabled={atCap}
          className="pressable min-h-[44px] rounded-xl bg-moss px-4 text-sm font-semibold text-white disabled:opacity-40"
        >
          + New thread
        </button>
      </header>

      {atCap && (
        <p className="mb-4 rounded-xl border border-hairline bg-surface px-4 py-2.5 text-sm text-muted">
          You’re running {threadCap} threads — the most Ponder keeps going at
          once. Pause or conclude one to start another.
        </p>
      )}

      {error && (
        <p className="mb-4 rounded-xl bg-rust-soft px-4 py-2.5 text-sm font-semibold text-rust">
          {error}
        </p>
      )}

      {/* Dismissing the auto-opened create sheet (Cancel, or a tap on the
          backdrop) used to leave a brand-new user on a literally blank screen
          — header plus a small corner chip. The auto-open has already been
          consumed by then, so nothing brings the sheet back. */}
      {topics.length === 0 && (
        <div className="animate-rise rounded-2xl border border-hairline bg-surface p-6 text-center">
          <p className="font-display text-2xl">Begin with one thing</p>
          <p className="mt-2 text-muted">
            Name the first thing you sense God may be speaking about. You can add
            more threads whenever you like.
          </p>
          <button
            onClick={() => setShowCreate(true)}
            className="pressable mt-5 min-h-[48px] w-full rounded-xl bg-moss py-3 font-semibold text-white"
          >
            Create my first thread
          </button>
        </div>
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
                    {t.title}
                  </h2>
                  <StatusChip status={t.status} />
                </div>
                <p className="mt-1 text-sm text-muted">
                  {t.book_number
                    ? "Reading through the book"
                    : `${s.entryCount} ${s.entryCount === 1 ? "day" : "days"} of entries`}
                </p>
                {s.lastNote && (
                  <p className="mt-3 border-l-2 border-hairline pl-3 text-sm italic leading-relaxed text-ink/80">
                    “{s.lastNote.body.length > 120 ? s.lastNote.body.slice(0, 120) + "…" : s.lastNote.body}”
                  </p>
                )}
              </button>

              {t.status !== "concluded" && (
                <div className="mt-2 flex gap-2 px-1">
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
          firstThread={topics.length === 0}
          onClose={() => setShowCreate(false)}
          onCreated={(wasFirst) => {
            setShowCreate(false);
            void load();
            if (wasFirst) onFirstThreadCreated?.();
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
  firstThread = false,
}: {
  onClose: () => void;
  onCreated: (wasFirst: boolean) => void;
  /** True when this is the user's first thread: the sheet then waits for the
   *  first entry before handing back, so they land on content, not on a
   *  "Generate today's entry" button they have to find and press. */
  firstThread?: boolean;
}) {
  const [kind, setKind] = useState<"question" | "book" | null>(null);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [saving, setSaving] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState("");

  // seed verse: what the user typed, and the resolved passage (if any)
  const [seedInput, setSeedInput] = useState("");
  const [seed, setSeed] = useState<ResolvedVerseRef | null>(null);
  const [seedState, setSeedState] = useState<"idle" | "checking" | "ok" | "bad">("idle");

  // How much of the viewport the on-screen keyboard is covering. Without this
  // the sheet stays pinned to the bottom of the window and the fields the user
  // is typing into sit underneath the keyboard.
  const kbInset = useKeyboardInset();

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
      const created = await createTopic({
        title: title.trim(),
        description: description.trim(),
        seed: seed
          ? {
              book_number: seed.book_number,
              chapter: seed.chapter,
              verse_start: seed.verse_start,
              verse_end: seed.verse_end,
            }
          : null,
      });

      // pg_cron doesn't run until tonight, so a thread created now has nothing
      // to show. Generate the first entry here rather than making a brand-new
      // user find Today and press "Generate today's entry" — most of the time
      // this is served straight from the pool and returns quickly.
      //
      // Only on the FIRST thread: someone adding their fourth already knows
      // where entries come from and shouldn't be held in a modal.
      //
      // A failure must never fail thread creation. The thread exists either
      // way, Today still offers a retry, and tonight's cron fills the gap.
      if (firstThread) {
        setGenerating(true);
        try {
          await generateEntryNow(created.id);
        } catch {
          /* non-fatal — see above */
        }
      }

      onCreated(firstThread);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create thread");
      setSaving(false);
      setGenerating(false);
    }
  }

  if (kind !== "question") {
    return (
      <div className="fixed inset-0 z-30 flex items-end justify-center bg-ink/40" onClick={onClose}>
        <div
          onClick={(e) => e.stopPropagation()}
          className="max-h-[calc(100dvh-2rem)] w-full max-w-lg animate-rise overflow-y-auto overscroll-contain rounded-t-3xl bg-paper p-6 pb-[max(1.5rem,env(safe-area-inset-bottom))]"
        >
          {kind === "book" ? (
            <BookPicker onBack={() => setKind(null)} onCreated={() => onCreated(firstThread)} />
          ) : (
            <>
              <h2 className="font-display text-3xl font-medium">New thread</h2>
              <p className="mt-1 text-sm text-muted">What would you like to follow?</p>
              <div className="mt-5 space-y-3">
                <KindChoice
                  title="Something I’m sensing"
                  body="Something you sense God may be speaking about. Each day brings a passage to sit with."
                  onClick={() => setKind("question")}
                />
                <KindChoice
                  title="A book"
                  body="Read through a book of the Bible from the beginning, one passage at a time."
                  onClick={() => setKind("book")}
                />
              </div>
              <button
                type="button"
                onClick={onClose}
                className="pressable mt-6 min-h-[48px] w-full rounded-xl border border-hairline bg-surface font-semibold"
              >
                Cancel
              </button>
            </>
          )}
        </div>
      </div>
    );
  }

  return (
    <div
      className="fixed inset-0 z-30 flex items-end justify-center bg-ink/40"
      style={{ paddingBottom: kbInset }}
      onClick={onClose}
    >
      <form
        onSubmit={save}
        onClick={(e) => e.stopPropagation()}
        style={{ maxHeight: `calc(100dvh - ${kbInset}px - 2rem)` }}
        className="w-full max-w-lg animate-rise overflow-y-auto overscroll-contain rounded-t-3xl bg-paper p-6 pb-[max(1.5rem,env(safe-area-inset-bottom))]"
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
          placeholder="e.g. My identity in Christ"
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
            <p className="mt-1 text-base italic leading-relaxed text-ink/85">
              {seed.verse_text}
            </p>
          </blockquote>
        )}

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
            {generating ? "Listening for a word…" : saving ? "Creating…" : "Create thread"}
          </button>
        </div>
      </form>
    </div>
  );
}

function KindChoice({ title, body, onClick }: { title: string; body: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="pressable w-full rounded-2xl border border-hairline bg-surface p-5 text-left hover:border-moss"
    >
      <span className="block font-display text-2xl font-medium">{title}</span>
      <span className="mt-1 block text-base leading-relaxed text-muted">{body}</span>
    </button>
  );
}

/** Suggested first books, by book_number, with a line each. */
const STARTER_BOOKS: [number, string][] = [
  [41, "The shortest Gospel, fast and vivid, with Jesus always on the move."],
  [43, "Jesus through the eyes of a close friend, from the Word made flesh to the empty tomb."],
  [50, "A warm letter from prison about joy, humility and pressing on."],
  [8, "A short, quiet story of loss, loyalty and unexpected kindness."],
  [19, "The Bible’s prayer book of praise, lament and trust."],
];

/**
 * Choose a book. A book thread always starts at the beginning, counts toward
 * the same thread limit, and its first section is already written, so the
 * first reading is fetched straight away.
 */
function BookPicker({ onBack, onCreated }: { onBack: () => void; onCreated: () => void }) {
  const [books, setBooks] = useState<BookCatalogueRow[] | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    fetchBookCatalogue()
      .then(setBooks)
      .catch(() => setError("Couldn’t load the books. Check your connection and try again."));
  }, []);

  async function start(book: BookCatalogueRow) {
    setBusy(book.book_number);
    setError("");
    try {
      const created = await createTopic({ title: book.name, description: "", book_number: book.book_number });
      try {
        await generateEntryNow(created.id);
      } catch {
        /* non-fatal: Today fetches it again */
      }
      onCreated();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not start this book");
      setBusy(null);
    }
  }

  const byNumber = new Map((books ?? []).map((b) => [b.book_number, b]));
  const row = (b: BookCatalogueRow, line?: string) => (
    <li key={b.book_number}>
      <button
        type="button"
        disabled={busy !== null}
        onClick={() => void start(b)}
        className="pressable w-full rounded-xl border border-hairline bg-surface px-4 py-3 text-left hover:border-moss disabled:opacity-60"
      >
        <span className="flex items-baseline justify-between gap-3">
          <span className="font-display text-xl font-medium">{b.name}</span>
          <span className="shrink-0 text-sm text-muted">
            {busy === b.book_number ? "Starting…" : `${b.section_count} ${b.section_count === 1 ? "passage" : "passages"}`}
          </span>
        </span>
        {line && <span className="mt-1 block text-sm leading-relaxed text-muted">{line}</span>}
      </button>
    </li>
  );

  return (
    <>
      <button type="button" onClick={onBack} className="pressable min-h-[44px] text-sm font-semibold text-muted">
        ← Back
      </button>
      <h2 className="font-display text-3xl font-medium">Choose a book</h2>
      <p className="mt-1 text-sm text-muted">You’ll start at the beginning and read one passage at a time.</p>
      {error && <p className="mt-3 text-sm text-rust">{error}</p>}
      {!books && !error && <p className="mt-5 text-muted">Opening the library…</p>}
      {books && (
        <>
          <h3 className="mb-2 mt-6 text-xs font-bold uppercase tracking-[0.18em] text-muted">A good place to start</h3>
          <ul className="space-y-2">
            {STARTER_BOOKS.map(([n, line]) => byNumber.get(n) && row(byNumber.get(n)!, line))}
          </ul>
          <h3 className="mb-2 mt-8 text-xs font-bold uppercase tracking-[0.18em] text-muted">Every book</h3>
          <ul className="space-y-2">{books.map((b) => row(b))}</ul>
        </>
      )}
    </>
  );
}
