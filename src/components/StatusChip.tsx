import type { TopicStatus } from "../lib/types";

const STYLES: Record<TopicStatus, string> = {
  active: "bg-moss-soft text-moss",
  paused: "bg-hairline text-muted",
  concluded: "bg-ink/10 text-ink/70",
};

export default function StatusChip({ status }: { status: TopicStatus }) {
  return (
    <span
      className={`rounded-full px-2.5 py-1 text-[11px] font-bold uppercase tracking-wider ${STYLES[status]}`}
    >
      {status}
    </span>
  );
}
