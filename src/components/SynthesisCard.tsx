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

      <div className="mt-4 border-t border-hairline pt-3">
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
