import type { Synthesis } from "../lib/types";
import ReportButton from "./ReportButton";

export default function SynthesisCard({
  synthesis,
  latest = false,
}: {
  synthesis: Synthesis;
  latest?: boolean;
}) {
  const { content, kind, created_at } = synthesis;
  const when = new Date(created_at).toLocaleDateString("en-AU", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
  return (
    <div
      className={`rounded-2xl border p-5 ${
        latest ? "border-moss/40 bg-moss-soft" : "border-hairline bg-surface"
      }`}
    >
      <div className="flex items-center justify-between">
        <span className="text-xs font-bold uppercase tracking-wider text-muted">
          {kind === "conclusion" ? "Looking back" : "What's emerging"} · {when}
        </span>
        {latest && (
          <span className="rounded-full bg-moss px-2.5 py-0.5 text-[11px] font-bold uppercase tracking-wider text-white">
            latest
          </span>
        )}
      </div>

      <Section title="What keeps returning" items={content.threads} />
      {content.tensions.length > 0 && (
        <Section title="Tensions & open questions" items={content.tensions} />
      )}
      <Section title="Next steps" items={content.next_steps} />

      <SynthesisFootnotes synthesis={synthesis} />
    </div>
  );
}

/**
 * Sources footnote. Counts and references are recorded server-side from the
 * rows actually fed to the model, so this describes the real input — the
 * model is never asked what it drew on.
 */
function SynthesisFootnotes({ synthesis }: { synthesis: Synthesis }) {
  const s = synthesis.content.sources;
  const fmt = (d: string) =>
    new Date(`${d}T00:00:00`).toLocaleDateString("en-AU", {
      day: "numeric",
      month: "short",
      year: "numeric",
    });
  const span =
    s?.first_entry_date && s.last_entry_date
      ? s.first_entry_date === s.last_entry_date
        ? fmt(s.first_entry_date)
        : `${fmt(s.first_entry_date)} – ${fmt(s.last_entry_date)}`
      : null;

  return (
    <div className="mt-5 border-t border-hairline pt-3">
      {s && (
        <div className="mb-3">
          <h3 className="mb-1.5 text-[11px] font-bold uppercase tracking-[0.16em] text-muted">
            Sources
          </h3>
          <ol className="space-y-1.5 text-[12.5px] leading-snug text-muted">
            <li className="flex gap-2">
              <span className="shrink-0 tabular-nums">1.</span>
              <span>
                Drawn from {s.entry_count}{" "}
                {s.entry_count === 1 ? "entry" : "entries"}
                {span ? ` (${span})` : ""} and {s.note_count} of your{" "}
                {s.note_count === 1 ? "note" : "notes"}.
              </span>
            </li>
            {s.entry_refs.length > 0 && (
              <li className="flex gap-2">
                <span className="shrink-0 tabular-nums">2.</span>
                <span>
                  Passages:{" "}
                  <span className="text-ink/70">{s.entry_refs.join(" · ")}</span>
                  , World English Bible.
                </span>
              </li>
            )}
            <li className="flex gap-2">
              <span className="shrink-0 tabular-nums">
                {s.entry_refs.length > 0 ? "3." : "2."}
              </span>
              <span>
                Patterns identified by AI as material for your discernment — not
                a verdict on the thread.
              </span>
            </li>
          </ol>
        </div>
      )}
      <div className="flex justify-end">
        <ReportButton synthesis={synthesis} />
      </div>
    </div>
  );
}

function Section({ title, items }: { title: string; items: string[] }) {
  if (!items?.length) return null;
  return (
    <section className="mt-4">
      <h3 className="text-xs font-bold uppercase tracking-[0.16em] text-moss">{title}</h3>
      <ul className="mt-1.5 space-y-1.5">
        {items.map((it, i) => (
          <li key={i} className="flex gap-2 text-[15px] leading-relaxed">
            <span className="mt-2 h-1 w-1 shrink-0 rounded-full bg-ink/40" />
            <span>{it}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
