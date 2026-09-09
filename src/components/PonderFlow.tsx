import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DailyEntry, Note } from "../lib/types";
import { useContentLevel } from "../lib/contentLevel";
import { addNote } from "../lib/api";
import { loadPonderProgress, savePonderProgress } from "../lib/ponderProgress";

/**
 * The ponder section.
 *
 * The old version was an <ol> of three questions. Everything about that
 * shape said "read these and move on": they arrived together, they were
 * numbered like steps, and the eye finished all three before the mind
 * started the first. This is the same content paced differently — one
 * question at a time, revealed by the reader's own tap, with a note that
 * attaches to a single question rather than to the whole day.
 *
 * Four rules this component exists to keep:
 *
 * 1. NOTHING IS HIDDEN. "Show all three" is always one tap away, in every
 *    state. This codebase folds, it does not hide (see EntryCard's content
 *    level). A reader who wants the list gets the list.
 *
 * 2. NO TIMER. The reveal is the reader's tap and nothing else. There is no
 *    countdown, no disabled interval, no "you're going too fast". The only
 *    guard is the 420ms card entrance, during which the strip below is
 *    inert — that stops a double-tap eating a question, and is not a rule
 *    about how long anyone should think.
 *
 * 3. NO SCORING. No streak, no completion badge, no "3/3". The close is a
 *    stop, not a reward. Discernment is not a habit tracker.
 *
 * 4. THE GATE IS ASKED ONCE (9 Sep 2026). "Ready to ponder?" is an
 *    invitation; re-issuing it to someone who accepted it this morning
 *    treats a return visit as a fresh start, when the actual reason people
 *    come back is to re-read a question or the note they left on it.
 *    Returning to a begun entry skips the gate and lands on question one;
 *    returning to a finished one lands on the close screen, which is the
 *    list of all the questions with their notes — that list, not question
 *    one, is what someone re-opening a finished thread is looking for.
 *    From it every question is one tap away, notes and composer included.
 *    See lib/ponderProgress.ts.
 *
 * Navigation is three redundant affordances over the same move, because the
 * pips already promised a carousel and only the strip delivered one: swipe
 * (horizontal, direction-locked), the peeking strip / back link, and the
 * pips themselves, which are now buttons.
 */

type Q = {
  /** ponder_index for notes: 0 = the anchored question, 1..4 = ponder[n-1]. */
  idx: number;
  text: string;
  /** Verified substring of the passage. Only ever set on idx 0. */
  phrase?: string | null;
};

const COUNT_WORD = ["none", "one", "two", "three", "four"];

/**
 * Where a return visit lands. `done` beats the Brief content level: the close
 * screen lists every question in full, so it is not the "passage plus a locked
 * box" that made level 1 skip the gate in the first place.
 */
function resumeStep(entryId: string, level: number, count: number): number {
  const p = loadPonderProgress(entryId);
  if (p.done) return count;
  return level === 1 || p.begun ? 0 : -1;
}

export default function PonderFlow({
  entry,
  notes,
  offline = false,
  onNoteAdded,
  challenge,
}: {
  entry: DailyEntry;
  notes: Note[];
  offline?: boolean;
  /** Omit to render read-only — no note affordances. */
  onNoteAdded?: (note: Note) => void;
  challenge: boolean;
}) {
  const level = useContentLevel();

  // The question list. An entry generated before 8 Sep 2026 — and every entry
  // that was already sitting in the pool then — has no verse_question, and
  // there is no backfill. That is the common case for months, so it is the
  // fallback path, not an error path: ponder[0] simply becomes question one
  // and no badge is shown.
  const questions = useMemo<Q[]>(() => {
    const rest = entry.ponder.map((text, i) => ({ idx: i + 1, text }));
    const vq = entry.verse_question;
    return vq?.question
      ? [{ idx: 0, text: vq.question, phrase: vq.phrase ?? null }, ...rest]
      : rest;
  }, [entry]);

  // At level 1 the questions are the only body content on the card. Gating
  // them there leaves the reader a passage and a locked box, which is a
  // regression dressed as a pause — so Brief opens straight onto question one.
  // Anything already begun opens the same way, gate spent (rule 4).
  const [step, setStep] = useState<number>(() => resumeStep(entry.id, level, questions.length));
  const [showAll, setShowAll] = useState(() => loadPonderProgress(entry.id).showAll);

  useEffect(() => {
    setStep(resumeStep(entry.id, level, questions.length));
    setShowAll(loadPonderProgress(entry.id).showAll);
  }, [entry.id, level, questions.length]);

  // Progress is written at the transition, never from an effect watching
  // `step`. An effect would fire on the render where `entry.id` has already
  // changed to the newly selected thread but `step` is still the OLD thread's
  // — the reset effect above only *schedules* its setStep — and would stamp
  // the incoming thread with the outgoing one's progress. Switching away from
  // a finished thread marked the next one finished. Handlers see a consistent
  // pair, so they cannot.
  const goTo = useCallback(
    (i: number) => {
      setShowAll(false);
      setStep(i);
      const prev = loadPonderProgress(entry.id);
      savePonderProgress(entry.id, {
        begun: true,
        showAll: false,
        done: prev.done || i >= questions.length,
      });
    },
    [entry.id, questions.length],
  );

  const openShowAll = useCallback(() => {
    setShowAll(true);
    const prev = loadPonderProgress(entry.id);
    savePonderProgress(entry.id, { ...prev, begun: true, showAll: true });
  }, [entry.id]);

  const accent = challenge ? "rust" : "moss";

  if (questions.length === 0) return null;

  return (
    <section className="mt-8">
      <div className="mb-3 flex items-baseline justify-between">
        <h2 className="text-xs font-bold uppercase tracking-[0.18em] text-muted">To ponder</h2>
        {!showAll && step >= 0 && (
          <Pips total={questions.length} at={step} accent={accent} onJump={goTo} />
        )}
      </div>

      {showAll ? (
        <ShowAll
          questions={questions}
          notes={notes}
          accent={accent}
          onOneAtATime={() => goTo(0)}
          onOpen={goTo}
        />
      ) : step === -1 ? (
        <Gate
          count={questions.length}
          accent={accent}
          onBegin={() => goTo(0)}
          onShowAll={openShowAll}
        />
      ) : step >= questions.length ? (
        <Close questions={questions} notes={notes} onRevisit={goTo} />
      ) : (
        <Question
          key={questions[step].idx}
          entry={entry}
          q={questions[step]}
          position={step}
          total={questions.length}
          notes={notes.filter((n) => n.ponder_index === questions[step].idx)}
          accent={accent}
          offline={offline}
          onNoteAdded={onNoteAdded}
          onReveal={() => goTo(step + 1)}
          onBack={step > 0 ? () => goTo(step - 1) : undefined}
          onShowAll={openShowAll}
        />
      )}
    </section>
  );
}

/**
 * Progress, and now also a control.
 *
 * These were aria-hidden decoration, which was the honest thing to do while
 * the only way through was the strip. Three dots that cannot be tapped read
 * as a carousel that is broken rather than a meter that is passive, so they
 * are buttons: the dot is still 7px, the hit area is 28px around it.
 */
function Pips({
  total,
  at,
  accent,
  onJump,
}: {
  total: number;
  at: number;
  accent: string;
  onJump: (i: number) => void;
}) {
  return (
    <div className="-my-2 flex items-center">
      {Array.from({ length: total }, (_, i) => (
        <button
          key={i}
          type="button"
          onClick={() => onJump(i)}
          aria-label={`Go to question ${i + 1} of ${total}`}
          aria-current={i === at ? "true" : undefined}
          className="flex h-7 w-[18px] items-center justify-center"
        >
          <span
            className={`h-[7px] w-[7px] rounded-full transition-all duration-300 ${
              i < at
                ? accent === "rust" ? "bg-rust/25" : "bg-moss/25"
                : i === at
                  ? `scale-150 ${accent === "rust" ? "bg-rust" : "bg-moss"}`
                  : "bg-hairline"
            }`}
          />
        </button>
      ))}
    </div>
  );
}

/**
 * The gate.
 *
 * Fixed copy. Rotating "encouragement" is the thing that goes stale fastest,
 * and a line the reader has learned to skip is worse than no line.
 *
 * "Stay with each until it's finished with you" is doing specific work: it
 * reverses who is acting. The reader is not processing a question and moving
 * on — the question is working on them, and they leave when it is done, not
 * when they are.
 *
 * Shown once per entry. See rule 4 above.
 */
function Gate({
  count,
  accent,
  onBegin,
  onShowAll,
}: {
  count: number;
  accent: string;
  onBegin: () => void;
  onShowAll: () => void;
}) {
  const word = COUNT_WORD[count] ?? String(count);
  return (
    <div
      className={`rounded-2xl border border-dashed px-6 py-7 text-center ${
        accent === "rust" ? "border-rust/25 bg-rust-soft" : "border-moss/25 bg-moss-soft"
      }`}
    >
      <p className="font-display text-[27px] font-medium italic leading-tight">
        Ready to ponder?
      </p>
      <p className="mx-auto mt-2.5 max-w-[270px] text-[14.5px] leading-relaxed text-muted">
        {count === 1 ? "One question." : `${word[0].toUpperCase()}${word.slice(1)} questions, one at a time.`}
        <br />
        Stay with {count === 1 ? "it" : "each"} until it&rsquo;s finished with you.
      </p>
      <button
        type="button"
        onClick={onBegin}
        className={`pressable mt-6 min-h-[48px] rounded-2xl px-8 text-[15px] font-bold tracking-wide text-paper ${
          accent === "rust" ? "bg-rust" : "bg-moss"
        }`}
      >
        Begin
      </button>
      <button
        type="button"
        onClick={onShowAll}
        className="mt-3 block w-full py-2.5 text-[13px] text-muted underline underline-offset-[3px]"
      >
        Show all {count === 1 ? "of it" : word} instead
      </button>
    </div>
  );
}

/** Past this much horizontal travel, letting go commits the move. */
const SWIPE_COMMIT_PX = 56;
/** Below this, the gesture has no direction yet and we do not claim it. */
const SWIPE_SLOP_PX = 10;
/** How much more horizontal than vertical before we call it a swipe, not a scroll. */
const SWIPE_BIAS = 1.3;

/**
 * One question. Three ways forward, all the same move.
 *
 * The peeking card below is still the primary control — it carries the count,
 * so the count and the advance stay one object rather than two things to look
 * at, and a full-width strip is a deliberate thumb gesture where a small pill
 * would read as a wizard step and invite the triple-tap.
 *
 * Swipe is added on top because the pips were already promising it. It is
 * direction-locked: the first 10px of travel decide whether the gesture
 * belongs to this card or to the page's vertical scroll, and once the page
 * has it we never take it back mid-gesture. `touch-action: pan-y` tells the
 * browser the same thing, so vertical scrolling stays native and smooth.
 *
 * Dragging translates a wrapper, not the <article>. The article carries
 * `animate-rise`, and a CSS animation on `transform` beats an inline
 * `transform` outright — put them on the same element and the drag silently
 * does nothing for the first 420ms.
 */
function Question({
  entry,
  q,
  position,
  total,
  notes,
  accent,
  offline,
  onNoteAdded,
  onReveal,
  onBack,
  onShowAll,
}: {
  entry: DailyEntry;
  q: Q;
  position: number;
  total: number;
  notes: Note[];
  accent: string;
  offline: boolean;
  onNoteAdded?: (note: Note) => void;
  onReveal: () => void;
  onBack?: () => void;
  onShowAll: () => void;
}) {
  const [composing, setComposing] = useState(false);
  const [locked, setLocked] = useState(true);
  const [dx, setDx] = useState(0);
  const [dragging, setDragging] = useState(false);
  const gesture = useRef<{ x: number; y: number; axis: null | "x" | "y" } | null>(null);

  // Inert for the length of the card's entrance animation. Not a rule about
  // reading speed — it stops one fat-fingered double tap from consuming two
  // questions before either has been rendered.
  useEffect(() => {
    setComposing(false);
    setLocked(true);
    setDx(0);
    setDragging(false);
    gesture.current = null;
    const t = setTimeout(() => setLocked(false), 420);
    return () => clearTimeout(t);
  }, [q.idx]);

  function onTouchStart(e: React.TouchEvent) {
    // Never start a swipe from inside the composer — the textarea owns those
    // touches (caret placement, selection drag).
    if (locked || composing || e.touches.length !== 1) return;
    const t = e.touches[0];
    gesture.current = { x: t.clientX, y: t.clientY, axis: null };
  }

  function onTouchMove(e: React.TouchEvent) {
    const g = gesture.current;
    if (!g) return;
    const t = e.touches[0];
    const ddx = t.clientX - g.x;
    const ddy = t.clientY - g.y;

    if (g.axis === null) {
      if (Math.abs(ddx) < SWIPE_SLOP_PX && Math.abs(ddy) < SWIPE_SLOP_PX) return;
      g.axis = Math.abs(ddx) > Math.abs(ddy) * SWIPE_BIAS ? "x" : "y";
      if (g.axis === "y") {
        gesture.current = null; // the page has it; do not fight the scroll
        return;
      }
      setDragging(true);
    }
    // Rubber-band rather than refuse: dragging right on question one still
    // moves, just reluctantly, so the edge is felt instead of guessed at.
    setDx(ddx > 0 && !onBack ? ddx * 0.28 : ddx);
  }

  function onTouchEnd() {
    const g = gesture.current;
    gesture.current = null;
    setDragging(false);
    const travelled = dx;
    setDx(0);
    if (!g || g.axis !== "x") return;
    if (travelled <= -SWIPE_COMMIT_PX) onReveal();
    else if (travelled >= SWIPE_COMMIT_PX && onBack) onBack();
  }

  const left = total - position - 1;
  const word = COUNT_WORD[total] ?? String(total);
  const strip =
    left >= 2 ? "Next question" : left === 1 ? "Last question" : `That’s the ${word}`;
  const line = accent === "rust" ? "text-rust" : "text-moss";

  return (
    <>
      <div className="relative pb-[34px]">
        {left >= 2 && (
          <div
            aria-hidden="true"
            className="absolute inset-x-[22px] bottom-[-11px] z-[1] h-[34px] rounded-2xl border border-hairline border-b-0 bg-surface opacity-50"
          />
        )}
        <button
          type="button"
          onClick={onReveal}
          disabled={locked}
          aria-label={
            left === 0
              ? "Finish and see all the questions"
              : `Reveal question ${position + 2} of ${total}`
          }
          className={`pressable absolute inset-x-[10px] bottom-[-1px] z-[2] flex h-[34px] items-start justify-center rounded-2xl border border-hairline border-b-0 bg-surface pt-[9px] text-[12.5px] font-bold uppercase tracking-[0.13em] transition-opacity ${line} ${
            locked ? "opacity-40" : "opacity-100"
          }`}
        >
          {strip}
        </button>

        <div
          onTouchStart={onTouchStart}
          onTouchMove={onTouchMove}
          onTouchEnd={onTouchEnd}
          onTouchCancel={onTouchEnd}
          style={{
            touchAction: "pan-y",
            transform: dx ? `translateX(${dx}px)` : undefined,
            transition: dragging ? "none" : "transform 260ms cubic-bezier(0.22, 1, 0.36, 1)",
          }}
        >
          <article className="animate-rise relative rounded-2xl border border-hairline bg-surface px-5 pb-4 pt-5 shadow-[0_2px_10px_rgba(31,27,22,0.04)]">
            {q.idx === 0 && (
              <div
                className={`mb-3.5 inline-flex items-center gap-2 rounded-full px-3 py-1.5 ${
                  accent === "rust" ? "bg-rust-soft" : "bg-moss-soft"
                }`}
              >
                <span
                  className={`h-1.5 w-1.5 rounded-full ${accent === "rust" ? "bg-rust" : "bg-moss"}`}
                />
                <span
                  className={`text-[10px] font-bold uppercase tracking-[0.16em] ${line}`}
                >
                  In today&rsquo;s verse
                </span>
              </div>
            )}

            {/* Shown whichever version is on screen.
                The phrase is verbatim WEB — validated server-side as a substring
                of verse_text — so a reader who has switched to the KJV or the
                BSB may not find these exact words in the passage above. That is
                a deliberate call: the pull-quote is what gives the question
                something to point at, and a question that sometimes arrives
                bare is a worse read than a quote whose wording differs by a
                pronoun. The passage itself is never marked up (see EntryCard),
                so the two are never in direct visual contradiction. */}
            {q.phrase && (
              <p className={`mb-2.5 font-display text-[23px] italic leading-tight ${line}`}>
                &ldquo;{q.phrase}&rdquo;
              </p>
            )}

            <p className="text-[18.5px] leading-relaxed">{q.text}</p>
            <p className="mt-4 text-xs tracking-wide text-muted">
              {position + 1} of {total}
            </p>

            {notes.map((n) => (
              <div
                key={n.id}
                className={`mt-3.5 rounded-r-xl border-l-2 px-3.5 py-3 ${
                  accent === "rust" ? "border-rust bg-rust-soft" : "border-moss bg-moss-soft"
                }`}
              >
                <p className="whitespace-pre-wrap text-[14.5px] leading-relaxed">{n.body}</p>
                <p className="mt-1.5 text-[11.5px] text-muted">
                  {new Date(n.created_at).toLocaleTimeString("en-AU", {
                    hour: "numeric",
                    minute: "2-digit",
                  })}
                </p>
              </div>
            ))}

            {onNoteAdded && composing && (
              <QuestionNote
                entry={entry}
                ponderIndex={q.idx}
                offline={offline}
                onDone={(n) => {
                  if (n) onNoteAdded(n);
                  setComposing(false);
                }}
              />
            )}

            {onNoteAdded && !composing && (
              <div className="mt-4 flex items-center border-t border-hairline pt-3">
                <button
                  type="button"
                  onClick={() => setComposing(true)}
                  disabled={offline}
                  className={`min-h-[44px] text-sm font-semibold disabled:opacity-40 ${line}`}
                >
                  {offline
                    ? "Notes need a connection"
                    : notes.length
                      ? "＋  Add another note"
                      : "＋  Write a note"}
                </button>
              </div>
            )}
          </article>
        </div>
      </div>

      <p className="mt-4 text-center">
        {onBack ? (
          <button
            type="button"
            onClick={onBack}
            className="py-2.5 text-[13px] text-muted underline underline-offset-[3px]"
          >
            &larr; Question {position}
          </button>
        ) : (
          <button
            type="button"
            onClick={onShowAll}
            className="py-2.5 text-[13px] text-muted underline underline-offset-[3px]"
          >
            Show all {word}
          </button>
        )}
      </p>
    </>
  );
}

/** Composer for one question. Opens inside the card so the question stays
 *  visible above what is being written. */
function QuestionNote({
  entry,
  ponderIndex,
  offline,
  onDone,
}: {
  entry: DailyEntry;
  ponderIndex: number;
  offline: boolean;
  onDone: (note: Note | null) => void;
}) {
  const [body, setBody] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    ref.current?.focus();
  }, []);

  async function save() {
    const trimmed = body.trim();
    if (!trimmed) return;
    setSaving(true);
    setError("");
    try {
      onDone(await addNote(entry, trimmed, ponderIndex));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save note");
      setSaving(false);
    }
  }

  return (
    <div className="animate-rise mt-4">
      <textarea
        ref={ref}
        value={body}
        onChange={(e) => setBody(e.target.value)}
        rows={4}
        disabled={offline}
        placeholder="What comes to mind?"
        className="w-full resize-none rounded-xl border border-hairline bg-paper px-3.5 py-3 text-[15px] leading-relaxed outline-none focus:border-moss disabled:opacity-60"
      />
      <div className="mt-2.5 flex items-center justify-between">
        {error ? (
          <p className="text-sm text-rust">{error}</p>
        ) : (
          <button
            type="button"
            onClick={() => onDone(null)}
            className="py-2 text-[13px] text-muted underline underline-offset-[3px]"
          >
            Cancel
          </button>
        )}
        <button
          type="button"
          onClick={save}
          disabled={saving || offline || !body.trim()}
          className="pressable min-h-[44px] rounded-xl bg-ink px-5 text-sm font-semibold text-paper disabled:opacity-40"
        >
          {saving ? "Saving…" : "Save"}
        </button>
      </div>
    </div>
  );
}

/**
 * The close. Deliberately not a reward screen — no streak, no tick, no count
 * of what was answered. It says the questions have run out and leaves
 * everything in reach.
 */
function Close({
  questions,
  notes,
  onRevisit,
}: {
  questions: Q[];
  notes: Note[];
  onRevisit: (step: number) => void;
}) {
  const word = COUNT_WORD[questions.length] ?? String(questions.length);
  return (
    <div className="rounded-2xl border border-hairline bg-surface p-5">
      <p className="font-display text-2xl italic">That&rsquo;s the {word}.</p>
      <p className="mt-2 text-[14.5px] leading-relaxed text-muted">
        Stay as long as you like. Nothing here expires.
      </p>
      <div className="mt-4 flex flex-col gap-2">
        {questions.map((q, i) => {
          const count = notes.filter((n) => n.ponder_index === q.idx).length;
          return (
            <button
              key={q.idx}
              type="button"
              onClick={() => onRevisit(i)}
              className="pressable flex w-full gap-2.5 rounded-xl border border-hairline bg-paper px-3.5 py-3 text-left"
            >
              <span className="font-display text-[17px] font-semibold leading-tight text-moss">
                {i + 1}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-sm leading-snug">{q.text}</span>
                <span className="mt-1 block text-xs text-muted">
                  {count === 0
                    ? "No note"
                    : `Your note${count > 1 ? `s · ${count} saved` : " · 1 saved"}`}
                </span>
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/**
 * The escape hatch — the old <ol>, reachable from every state.
 *
 * Now rows rather than list items, because this is the view a returning
 * reader scans to find the question they left a note on. Showing the note
 * count without a way to reach the note would be the worst of both.
 */
function ShowAll({
  questions,
  notes,
  accent,
  onOneAtATime,
  onOpen,
}: {
  questions: Q[];
  notes: Note[];
  accent: string;
  onOneAtATime: () => void;
  onOpen: (step: number) => void;
}) {
  const line = accent === "rust" ? "text-rust" : "text-moss";
  return (
    <>
      <ol className="space-y-3">
        {questions.map((q, i) => {
          const count = notes.filter((n) => n.ponder_index === q.idx).length;
          return (
            <li key={q.idx}>
              <button
                type="button"
                onClick={() => onOpen(i)}
                aria-label={`Open question ${i + 1}`}
                className="pressable flex w-full gap-3 rounded-xl px-1 py-1 text-left"
              >
                <span className={`font-display text-xl font-semibold leading-6 ${line}`}>
                  {i + 1}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-[16px] leading-relaxed">
                    {q.phrase && (
                      <em className={`not-italic ${line}`}>&ldquo;{q.phrase}&rdquo; &mdash; </em>
                    )}
                    {q.text}
                  </span>
                  {count > 0 && (
                    <span className={`mt-1 block text-xs font-semibold ${line}`}>
                      {count === 1 ? "1 note" : `${count} notes`}
                    </span>
                  )}
                </span>
              </button>
            </li>
          );
        })}
      </ol>
      <p className="mt-4 text-center">
        <button
          type="button"
          onClick={onOneAtATime}
          className="py-2.5 text-[13px] text-muted underline underline-offset-[3px]"
        >
          Take them one at a time
        </button>
      </p>
    </>
  );
}
