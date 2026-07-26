export type Tab = "today" | "topics" | "settings";

interface Props {
  tab: Tab;
  onChange: (tab: Tab) => void;
}

type IconProps = { active: boolean };

const svgBase = {
  width: 22,
  height: 22,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.75,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

// Today — sunrise: sun above a horizon line
function TodayIcon({ active }: IconProps) {
  return (
    <svg {...svgBase} aria-hidden="true">
      <path d="M3 18h18" />
      <path d="M12 3v3M5.6 8.6l1.4 1.4M18.4 8.6l-1.4 1.4" />
      <path d="M7 18a5 5 0 0 1 10 0" fill={active ? "currentColor" : "none"} fillOpacity={active ? 0.12 : 0} />
    </svg>
  );
}

// Topics — layered stack (multiple parallel topics)
function TopicsIcon({ active }: IconProps) {
  return (
    <svg {...svgBase} aria-hidden="true">
      <path
        d="M12 3l9 4-9 4-9-4 9-4z"
        fill={active ? "currentColor" : "none"}
        fillOpacity={active ? 0.12 : 0}
      />
      <path d="M3 12l9 4 9-4" />
      <path d="M3 16.5l9 4 9-4" />
    </svg>
  );
}

// Settings — sliders
function SettingsIcon({ active }: IconProps) {
  return (
    <svg {...svgBase} aria-hidden="true">
      <path d="M5 6h14M5 12h14M5 18h14" />
      <circle cx="9" cy="6" r="2.1" fill={active ? "currentColor" : "#FAF6EF"} />
      <circle cx="15" cy="12" r="2.1" fill={active ? "currentColor" : "#FAF6EF"} />
      <circle cx="8" cy="18" r="2.1" fill={active ? "currentColor" : "#FAF6EF"} />
    </svg>
  );
}

const TABS: Array<{ id: Tab; label: string; Icon: (p: IconProps) => JSX.Element }> = [
  { id: "today", label: "Today", Icon: TodayIcon },
  { id: "topics", label: "Topics", Icon: TopicsIcon },
  { id: "settings", label: "Settings", Icon: SettingsIcon },
];

export default function TabBar({ tab, onChange }: Props) {
  return (
    <nav className="fixed inset-x-0 bottom-0 z-20 border-t border-hairline bg-paper/95 backdrop-blur">
      <div className="mx-auto flex max-w-lg">
        {TABS.map((t) => {
          const active = tab === t.id;
          return (
            <button
              key={t.id}
              onClick={() => onChange(t.id)}
              className={`pressable flex min-h-[56px] flex-1 flex-col items-center justify-center gap-1 pb-[env(safe-area-inset-bottom)] ${
                active ? "text-moss" : "text-muted"
              }`}
            >
              <t.Icon active={active} />
              <span className={`text-xs ${active ? "font-bold" : "font-semibold"}`}>
                {t.label}
              </span>
            </button>
          );
        })}
      </div>
    </nav>
  );
}
