import type { Topic } from "../lib/types";

interface Props {
  topics: Topic[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}

export default function TopicSwitcher({ topics, selectedId, onSelect }: Props) {
  if (topics.length <= 1) return null;
  return (
    <div className="-mx-6 mb-5 flex gap-2 overflow-x-auto px-6 pb-1 [scrollbar-width:none]">
      {topics.map((t) => {
        const active = t.id === selectedId;
        return (
          <button
            key={t.id}
            onClick={() => onSelect(t.id)}
            className={`pressable min-h-[44px] shrink-0 rounded-full border px-4 text-sm font-semibold transition-colors ${
              active
                ? "border-moss bg-moss text-white"
                : "border-hairline bg-surface text-muted"
            }`}
          >
            {t.focus && <span className="mr-1.5">●</span>}
            {t.title}
          </button>
        );
      })}
    </div>
  );
}
