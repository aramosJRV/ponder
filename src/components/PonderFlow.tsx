import { useEffect, useMemo, useRef, useState } from "react";
import type { DailyEntry, Note } from "../lib/types";
import { useContentLevel } from "../lib/contentLevel";
import { addNote } from "../lib/api";

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
 * Three rules this component exists to keep:
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
 */

type Q = {
  /** ponder_index for notes: 0 = the anchored question, 1..4 = ponder[n-1]. */
  idx: number;
  text: string;
  /** Verified substring of the passage. Only ever set on idx 0. */
  phrase?: string | null;
};

const COUNT_WORD = ["none", "one", "two", "three", "four"];

export default function PonderFlow({
  entry,
  passageText,
  notes,
  offline = false,
  onNoteAdded,
  challenge,
}: {
  entry: DailyEntry;
  /** The passage text currently on screen — which version the reader picked,
   *  not necessarily the WEB the phrase was validated against. */
  passageText: string;
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
  const [step, setStep] = useState<number>(level === 1 ? 0 : -1);
  const [showAll, setShowAll] = useState(false);

  useEffect(() => {
    setStep(level === 1 ? 0 : -1);
    setShowAll(false);
  }, [entry.id, level]);

  const accent = challenge ? "rust" : "moss";

  if (questions.length === 0) return null;

  return (
    <section className="mt-8">
      <div className="mb-3 flex items-baseline justify-between">
        <h2 className="text-xs font-bold uppercase tracking-[0.18em] text-muted">To ponder</h2>
        {!showAll && step >= 0 && (
          <Pips total={questions.length} at={step} accent={accent} />
        )}
      </div>

      {showAll ? (
        <ShowAll
          questions={questions}
          passageText={passageText}
          accent={accent}
          onOneAtATime={() => {
            setShowAll(false);
            setStep(0);
          }}
        />
      ) : step === -1 ? (
        <Gate
          count={questions.length}
          accent={accent}
          onBegin={() => setStep(0)}
          onShowAll={() => setShowAll(true)}
        />
      ) : step >= questions.length ? (
        <Close
          questions={questions}
          notes={notes}
          onRevisit={setStep}
        />
      ) : (
        <Question
          key={questions[step].idx}
          entry={entry}
          passageText={passageText}
          q={questions[step]}
          position={step}
          total={questions.length}
          notes={notes.filter((n) => n.ponder_index === questions[step].idx)}
          accent={accent}
          offline={offline}
          onNoteAdded={onNoteAdded}
          onReveal={() => setStep(step + 1)}
          onBack={step > 0 ? () => setStep(step - 1) : undefined}
          onShowAll={() => setShowAll(true)}
        />
      )}
    </section>
  );
}

/** Progress, not a score. aria-hidden — "1 of 3" on the card is the accessible form. */
function Pips({ total, at, accent }: { total: number; at: number; accent: string }) {
  return (
    <div aria-hidden="true" className="flex items-center gap-1.5">
      {Array.from({ length: total }, (_, i) => (
        <span
          key={i}
          className={`h-[7px] w-[7px] rounded-full transition-all duration-300 ${
            i < at
              ? accent === "rust" ? "bg-rust/25" : "bg-moss/25"
              : i === at
                ? `scale-150 ${accent === "rust" ? "bg-rust" : "bg-moss"}`
                : "bg-hairline"
          }`}
        />
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

/**
 * One question, with the stack beneath it doubling as the reveal control.
 *
 * The peeking card is the tap target rather than a "Next" pill in the footer,
 * for two reasons. It already carries the count — making it the control means
 * the count and the advance are one object instead of two things to look at.
 * And a full-width strip is a deliberate thumb gesture, where a small pill
 * next to "Write a note" reads as a wizard step and invites the triple-tap.
 */
function Question({
  entry,
  passageText,
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
  passageText: string;
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

  // Inert for the length of the card's entrance animation. Not a rule about
  // reading speed — it stops one fat-fingered double tap from consuming two
  // questions before either has been rendered.
  useEffect(() => {
    setComposing(false);
    setLocked(true);
    const t = setTimeout(() => setLocked(false), 420);
    return () => clearTimeout(t);
  }, [q.idx]);

  // Same test the hero highlight makes, so the two can never disagree.
  const inPassage =
    !!q.phrase && passageText.toLowerCase().includes(q.phrase.toLowerCase());

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

          {/* The phrase was validated against the WEB server-side, but the
              reader may have switched to the KJV or the BSB, where those exact
              words may not appear. Quoting it anyway would put "called you by
              your name" above a hero reading "called thee by thy name" — the
              card contradicting the passage it points at. So the pull-quote is
              checked against what is on screen, by the same indexOf the hero
              highlight uses, and simply drops when it does not match. The
              question itself always stands: it is written about the passage,
              not welded to one version's wording. */}
          {inPassage && (
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

/** The escape hatch — the old <ol>, reachable from every state. */
function ShowAll({
  questions,
  passageText,
  accent,
  onOneAtATime,
}: {
  questions: Q[];
  passageText: string;
  accent: string;
  onOneAtATime: () => void;
}) {
  const line = accent === "rust" ? "text-rust" : "text-moss";
  return (
    <>
      <ol className="space-y-3">
        {questions.map((q, i) => (
          <li key={q.idx} className="flex gap-3">
            <span className={`font-display text-xl font-semibold leading-6 ${line}`}>{i + 1}</span>
            <span className="text-[16px] leading-relaxed">
              {q.phrase && passageText.toLowerCase().includes(q.phrase.toLowerCase()) && (
                <em className={`not-italic ${line}`}>&ldquo;{q.phrase}&rdquo; &mdash; </em>
              )}
              {q.text}
            </span>
          </li>
        ))}
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
