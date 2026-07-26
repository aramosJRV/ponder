import { useRef, useState } from "react";

interface Props {
  /** Called when onboarding finishes. `createFirstTopic` is true when the
   *  user tapped the primary CTA and wants to open the New Topic sheet. */
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
    title: "Start with a topic",
    body:
      "A topic is something you sense God may be speaking to you about — patience, a decision, a relationship. Hold several at once; each keeps its own daily thread.",
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
      "Jot a note on any entry. Your notes gather into a journal for each topic, so threads and patterns become visible over time.",
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
      "Name the first thing you sense God may be speaking about. You can add more topics anytime.",
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
    <div className="flex min-h-screen flex-col bg-paper">
      {/* Skip — always available, marks onboarding done without creating a topic */}
      <div className="flex h-14 items-center justify-end px-5">
        {index < last && (
          <button
            onClick={() => onDone(false)}
            className="pressable min-h-[44px] px-2 text-sm font-semibold text-muted"
          >
            Skip
          </button>
        )}
      </div>

      {/* Paged, swipeable slides */}
      <div
        ref={scroller}
        onScroll={onScroll}
        className="flex flex-1 snap-x snap-mandatory overflow-x-auto scroll-smooth"
        style={{ scrollbarWidth: "none" }}
      >
        {SLIDES.map((s, i) => (
          <section
            key={i}
            className="flex min-w-full snap-center flex-col items-center justify-center px-9 text-center"
          >
            <div className="text-moss" aria-hidden="true">
              <s.Mark />
            </div>

            <p className="mt-8 text-xs font-semibold uppercase tracking-[0.28em] text-moss">
              {s.eyebrow}
            </p>
            <h1 className="mt-2 font-display text-4xl font-medium leading-tight text-ink">
              {s.title}
            </h1>

            {s.saying && (
              <p className="mt-6 max-w-sm font-display text-2xl italic leading-snug text-moss-deep">
                “{s.saying}”
              </p>
            )}

            <p className="mt-5 max-w-sm text-[15px] leading-relaxed text-muted">
              {s.body}
            </p>

            {s.verse && (
              <figure className="mt-6 max-w-xs border-t border-hairline pt-5">
                <p className="font-display text-lg italic leading-snug text-ink/80">
                  “{s.verse}”
                </p>
                {s.verseRef && (
                  <figcaption className="mt-2 text-xs font-semibold uppercase tracking-[0.22em] text-moss">
                    {s.verseRef}
                  </figcaption>
                )}
              </figure>
            )}

            {s.footnote && (
              <p className="mt-6 max-w-xs border-t border-hairline pt-5 font-display text-lg italic text-ink/70">
                {s.footnote}
              </p>
            )}
          </section>
        ))}
      </div>

      {/* Progress dots */}
      <div className="flex items-center justify-center gap-2 py-6">
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
      <div className="px-6 pb-[max(1.5rem,env(safe-area-inset-bottom))]">
        {index < last ? (
          <button
            onClick={() => goTo(index + 1)}
            className="pressable min-h-[52px] w-full rounded-2xl bg-moss text-base font-semibold text-white"
          >
            {index === 0 ? "Begin" : "Next"}
          </button>
        ) : (
          <div className="animate-rise space-y-3">
            <button
              onClick={() => onDone(true)}
              className="pressable min-h-[52px] w-full rounded-2xl bg-moss text-base font-semibold text-white"
            >
              Create my first topic
            </button>
            <button
              onClick={() => onDone(false)}
              className="pressable min-h-[48px] w-full rounded-2xl border border-hairline bg-surface text-base font-semibold text-ink"
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
    <svg width={64} height={64} viewBox="0 0 48 48" aria-hidden="true">
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
