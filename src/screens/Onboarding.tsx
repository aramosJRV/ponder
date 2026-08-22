import { useRef, useState } from "react";

interface Props {
  /** Called when onboarding finishes. `createFirstTopic` is true when the
   *  user tapped the primary CTA and wants to open the New Thread sheet. */
  onDone: (createFirstTopic: boolean) => void;
}

type Slide = {
  eyebrow: string;
  title: string;
  saying?: string; // featured line, shown in display italic
  body: string;
  verse?: string; // scripture epigraph (WEB), shown with a reference
  verseRef?: string; // e.g. "Luke 2:19"
  footnote?: string; // smaller supporting line
  Mark: () => JSX.Element;
};

const SLIDES: Slide[] = [
  {
    eyebrow: "Welcome to",
    title: "Ponder",
    saying: "God speaks loudest when we are quiet.",
    body:
      "A quiet daily space to listen for what God may be stirring — and to watch it take shape over time.",
    verse: "But Mary kept all these sayings, pondering them in her heart.",
    verseRef: "Luke 2:19",
    Mark: MarkSunrise,
  },
  {
    eyebrow: "Bring what's stirring",
    title: "Start with a thread",
    body:
      "A thread is something you sense God may be speaking to you about — patience, a decision, a relationship. Hold several at once; each unfolds a day at a time.",
    footnote: "Notice what stirs. Name what you sense.",
    Mark: MarkStack,
  },
  {
    eyebrow: "Each day",
    title: "A verse, and room to sit with it",
    saying: "Pause and ponder when something stands out.",
    body:
      "Every day brings a passage, a short reflection, an image to picture, a few questions, and prayer to carry with you.",
    footnote: "Some days it will gently press back — honest questions to help you listen well.",
    Mark: MarkVerse,
  },
  {
    eyebrow: "As it lands",
    title: "Keep what surfaces",
    saying: "Let the word of God sink deep into our souls.",
    body:
      "Jot a note on any entry. Your notes gather into a journal for each thread, so patterns become visible over time.",
    Mark: MarkNote,
  },
  {
    eyebrow: "A gentle rhythm",
    title: "One quiet nudge a day",
    body:
      "Choose a time that suits your morning. The day's verse arrives as a single, unhurried reminder — nothing more.",
    footnote: "A steady rhythm, gentle enough to keep.",
    Mark: MarkBell,
  },
  {
    eyebrow: "When you're ready",
    title: "Begin with one thing on your heart",
    body:
      "Name the first thing you sense God may be speaking about. You can add more threads anytime.",
    footnote:
      "Your threads and notes are kept on this phone. No sign-up needed. Add your email in Settings whenever you like \u2014 it\u2019s what lets you export your journal or move it to a new phone.",
    Mark: MarkSeed,
  },
];

export default function Onboarding({ onDone }: Props) {
  const scroller = useRef<HTMLDivElement>(null);
  const [index, setIndex] = useState(0);
  const last = SLIDES.length - 1;

  function goTo(next: number) {
    const clamped = Math.max(0, Math.min(last, next));
    const el = scroller.current;
    if (el) el.scrollTo({ left: clamped * el.clientWidth, behavior: "smooth" });
    setIndex(clamped);
  }

  function onScroll() {
    const el = scroller.current;
    if (!el) return;
    const i = Math.round(el.scrollLeft / el.clientWidth);
    if (i !== index) setIndex(i);
  }

  return (
    <div className="flex w-full flex-col overflow-hidden overscroll-none bg-paper" style={{ height: "calc(100svh - env(safe-area-inset-top) - env(safe-area-inset-bottom))" }}>
      {/* Skip — always available, marks onboarding done without creating a thread */}
      <div className="flex h-11 shrink-0 items-center justify-end px-5">
        {index < last && (
          <button
            onClick={() => onDone(false)}
            className="pressable min-h-[40px] px-2 text-sm font-semibold text-muted"
          >
            Skip
          </button>
        )}
      </div>

      {/* Paged, swipeable slides */}
      <div
        ref={scroller}
        onScroll={onScroll}
        className="flex min-h-0 w-full flex-1 snap-x snap-mandatory overflow-x-auto overflow-y-hidden overscroll-x-contain scroll-smooth"
        style={{ scrollbarWidth: "none" }}
      >
        {SLIDES.map((s, i) => (
          <section
            key={i}
            className="flex h-full w-full min-w-full shrink-0 snap-center flex-col items-center justify-center overflow-hidden px-6 text-center"
          >
            <div className="w-full max-w-sm shrink">
              <div className="flex justify-center text-moss" aria-hidden="true">
                <s.Mark />
              </div>

              <p className="mt-[3vh] text-[11px] font-semibold uppercase tracking-[0.24em] text-moss">
                {s.eyebrow}
              </p>
              <h1 className="mt-1 font-display text-[clamp(1.375rem,5.5vw,2rem)] font-medium leading-tight text-ink">
                {s.title}
              </h1>

              {s.saying && (
                <p className="mt-[1.6vh] font-display text-[clamp(1rem,4vw,1.3rem)] italic leading-snug text-moss-deep">
                  “{s.saying}”
                </p>
              )}

              <p className="mt-[1.4vh] text-[clamp(13px,3.6vw,15px)] leading-relaxed text-muted">
                {s.body}
              </p>

              {s.verse && (
                <figure className="mx-auto mt-[1.8vh] max-w-xs border-t border-hairline pt-[1.6vh]">
                  <p className="font-display text-[clamp(13px,3.6vw,16px)] italic leading-snug text-ink/80">
                    “{s.verse}”
                  </p>
                  {s.verseRef && (
                    <figcaption className="mt-1.5 text-[11px] font-semibold uppercase tracking-[0.2em] text-moss">
                      {s.verseRef}
                    </figcaption>
                  )}
                </figure>
              )}

              {s.footnote && (
                <p className="mx-auto mt-[1.8vh] max-w-xs border-t border-hairline pt-[1.6vh] font-display text-[clamp(13px,3.6vw,16px)] italic leading-snug text-ink/70">
                  {s.footnote}
                </p>
              )}
            </div>
          </section>
        ))}
      </div>

      {/* Progress dots */}
      <div className="flex shrink-0 items-center justify-center gap-2 py-2.5">
        {SLIDES.map((_, i) => (
          <button
            key={i}
            onClick={() => goTo(i)}
            aria-label={`Go to screen ${i + 1}`}
            className="pressable p-1.5"
          >
            <span
              className={`block h-1.5 rounded-full transition-all duration-300 ${
                i === index ? "w-6 bg-moss" : "w-1.5 bg-hairline"
              }`}
            />
          </button>
        ))}
      </div>

      {/* Controls */}
      <div className="shrink-0 px-6 pb-3">
        {index < last ? (
          <button
            onClick={() => goTo(index + 1)}
            className="pressable min-h-[50px] w-full rounded-2xl bg-moss text-base font-semibold text-white"
          >
            {index === 0 ? "Begin" : "Next"}
          </button>
        ) : (
          <div className="animate-rise space-y-2.5">
            <button
              onClick={() => onDone(true)}
              className="pressable min-h-[50px] w-full rounded-2xl bg-moss text-base font-semibold text-white"
            >
              Create my first thread
            </button>
            <button
              onClick={() => onDone(false)}
              className="pressable min-h-[46px] w-full rounded-2xl border border-hairline bg-surface text-base font-semibold text-ink"
            >
              I’ll explore first
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

/* ── Decorative marks ─────────────────────────────────────────────
   Thin, hand-drawn feel — echoes the tab-bar iconography, colored via
   the parent's text-moss. Kept inline so onboarding has no asset deps. */

const stroke = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.5,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

function frame(children: JSX.Element) {
  return (
    <svg viewBox="0 0 48 48" aria-hidden="true" className="h-[clamp(40px,7vh,64px)] w-[clamp(40px,7vh,64px)]">
      {children}
    </svg>
  );
}

function MarkSunrise() {
  return frame(
    <g {...stroke}>
      <path d="M4 34h40" />
      <path d="M24 8v6M9 18l4 4M39 18l-4 4" />
      <path d="M13 34a11 11 0 0 1 22 0" fill="currentColor" fillOpacity={0.1} />
    </g>
  );
}

function MarkStack() {
  return frame(
    <g {...stroke}>
      <path d="M24 6l18 8-18 8-18-8 18-8z" fill="currentColor" fillOpacity={0.1} />
      <path d="M6 24l18 8 18-8" />
      <path d="M6 32l18 8 18-8" />
    </g>
  );
}

function MarkVerse() {
  return frame(
    <g {...stroke}>
      <path d="M24 12c-3-2.5-8-3-12-2v22c4-1 9-.5 12 2 3-2.5 8-3 12-2V10c-4-1-9-.5-12 2z" fill="currentColor" fillOpacity={0.1} />
      <path d="M24 12v22" />
    </g>
  );
}

function MarkNote() {
  return frame(
    <g {...stroke}>
      <path d="M12 8h16l8 8v24H12z" fill="currentColor" fillOpacity={0.1} />
      <path d="M28 8v8h8" />
      <path d="M18 24h12M18 30h9" />
    </g>
  );
}

function MarkBell() {
  return frame(
    <g {...stroke}>
      <path d="M24 8a10 10 0 0 1 10 10c0 8 3 10 3 10H11s3-2 3-10A10 10 0 0 1 24 8z" fill="currentColor" fillOpacity={0.1} />
      <path d="M21 38a3 3 0 0 0 6 0" />
      <path d="M24 5v3" />
    </g>
  );
}

function MarkSeed() {
  return frame(
    <g {...stroke}>
      <path d="M24 40V22" />
      <path d="M24 26c0-6-4-10-10-11 0 6 4 10 10 11z" fill="currentColor" fillOpacity={0.1} />
      <path d="M24 22c0-7 4-11 11-12 0 7-4 11-11 12z" fill="currentColor" fillOpacity={0.1} />
      <path d="M16 40h16" />
    </g>
  );
}
