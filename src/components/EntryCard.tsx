import type { DailyEntry } from "../lib/types";
import ReportButton from "./ReportButton";

export default function EntryCard({ entry }: { entry: DailyEntry }) {
  const challenge = entry.entry_type === "challenge";
  return (
    <article className="animate-rise">
      {challenge && (
        <div className="mb-4 inline-flex items-center gap-2 rounded-full bg-rust-soft px-3.5 py-1.5">
          <span className="h-2 w-2 rounded-full bg-rust" />
          <span className="text-xs font-bold uppercase tracking-widest text-rust">
            A harder question today
          </span>
        </div>
      )}

      {/* Verse — the typographic hero, bleeding on warm ground */}
      <section
        className={`-mx-6 px-6 py-8 ${challenge ? "bg-rust-soft" : "bg-moss-soft"}`}
      >
        <p className="font-display text-[28px] font-medium leading-snug">
          “{entry.verse_text}”
        </p>
        <p
          className={`mt-4 text-sm font-bold uppercase tracking-[0.18em] ${
            challenge ? "text-rust" : "text-moss"
          }`}
        >
          {entry.verse_ref} · WEB
        </p>
      </section>

      <section className="mt-8">
        <h2 className="mb-2 text-xs font-bold uppercase tracking-[0.18em] text-muted">
          Thought
        </h2>
        <p className="text-[17px] leading-relaxed">{entry.thought}</p>
      </section>

      <section className="mt-8">
        <h2 className="mb-2 text-xs font-bold uppercase tracking-[0.18em] text-muted">
          Illustration
        </h2>
        <p className="border-l-2 border-hairline pl-4 text-[16px] leading-relaxed text-ink/90 [font-style:italic]">
          {entry.illustration}
        </p>
      </section>

      <section className="mt-8">
        <h2 className="mb-3 text-xs font-bold uppercase tracking-[0.18em] text-muted">
          To ponder
        </h2>
        <ol className="space-y-3">
          {entry.ponder.map((q, i) => (
            <li key={i} className="flex gap-3">
              <span className="font-display text-xl font-semibold leading-6 text-moss">
                {i + 1}
              </span>
              <span className="text-[16px] leading-relaxed">{q}</span>
            </li>
          ))}
        </ol>
      </section>

      <section className="mt-8">
        <h2 className="mb-3 text-xs font-bold uppercase tracking-[0.18em] text-muted">
          Prayer
        </h2>
        <ul className="space-y-2">
          {entry.prayer_prompts.map((p, i) => (
            <li
              key={i}
              className="rounded-xl border border-hairline bg-surface px-4 py-3 text-[15px] leading-relaxed"
            >
              {p}
            </li>
          ))}
        </ul>
      </section>

      <Footnotes entry={entry} />
    </article>
  );
}

/**
 * Sources footnote. Every reference shown here was resolved against the
 * World English Bible table server-side before the entry was stored — the
 * model never supplies scripture text, only references that then had to
 * prove they exist.
 */
function Footnotes({ entry }: { entry: DailyEntry }) {
  const crossRefs = entry.cross_refs ?? [];
  return (
    <section className="mt-10 border-t border-hairline pt-4">
      <h2 className="mb-2.5 text-[11px] font-bold uppercase tracking-[0.18em] text-muted">
        Sources
      </h2>

      <ol className="space-y-1.5 text-[13px] leading-snug text-muted">
        <li className="flex gap-2">
          <span className="shrink-0 tabular-nums">1.</span>
          <span>
            Passage: <span className="text-ink/70">{entry.verse_ref}</span>, World
            English Bible (public domain).
          </span>
        </li>

        {crossRefs.length > 0 && (
          <li className="flex gap-2">
            <span className="shrink-0 tabular-nums">2.</span>
            <span>
              Also drawn on:{" "}
              <span className="text-ink/70">
                {crossRefs.map((c) => c.ref).join(" · ")}
              </span>
              , World English Bible.
            </span>
          </li>
        )}

        <li className="flex gap-2">
          <span className="shrink-0 tabular-nums">
            {crossRefs.length > 0 ? "3." : "2."}
          </span>
          <span>
            Reflection, illustration, questions and prayers written by AI as
            material for your discernment — not a word about your life.
          </span>
        </li>
      </ol>

      <div className="mt-4 flex justify-end">
        <ReportButton entry={entry} />
      </div>
    </section>
  );
}
