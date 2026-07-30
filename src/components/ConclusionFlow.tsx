import { useEffect, useMemo, useState } from "react";
import {
  concludeTopic,
  fetchTopicEntries,
  fetchTopicNotes,
  generateSynthesis,
} from "../lib/api";
import { formatLongDate } from "../lib/dates";
import type { DailyEntry, Note, Synthesis, Topic } from "../lib/types";
import SynthesisCard from "./SynthesisCard";

type TimelineItem =
  | { kind: "entry"; ts: number; entry: DailyEntry }
  | { kind: "note"; ts: number; note: Note };

/**
 * Guided conclusion flow (spec step 6): shows the thread's full timeline of
 * entries + notes, generates a looking-back synthesis, and captures a closing
 * note — then concludes (read-only thereafter).
 */
export default function ConclusionFlow({
  topic,
  onClose,
  onConcluded,
}: {
  topic: Topic;
  onClose: () => void;
  onConcluded: () => void;
}) {
  const [entries, setEntries] = useState<DailyEntry[]>([]);
  const [notes, setNotes] = useState<Note[]>([]);
  const [loading, setLoading] = useState(true);

  const [synthesis, setSynthesis] = useState<Synthesis | null>(null);
  const [synthesizing, setSynthesizing] = useState(false);
  const [synthError, setSynthError] = useState("");

  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    (async () => {
      try {
        const [e, n] = await Promise.all([
          fetchTopicEntries(topic.id),
          fetchTopicNotes(topic.id),
        ]);
        setEntries(e);
        setNotes(n);
      } catch {
        /* timeline is best-effort; conclusion still works */
      } finally {
        setLoading(false);
      }
    })();
  }, [topic.id]);

  const timeline = useMemo<TimelineItem[]>(() => {
    const items: TimelineItem[] = [
      ...entries.map((e) => ({
        kind: "entry" as const,
        ts: new Date(e.date).getTime(),
        entry: e,
      })),
      ...notes.map((n) => ({
        kind: "note" as const,
        ts: new Date(n.created_at).getTime(),
        note: n,
      })),
    ];
    return items.sort((a, b) => a.ts - b.ts);
  }, [entries, notes]);

  const hasMaterial = entries.length > 0 || notes.length > 0;

  async function lookBack() {
    setSynthesizing(true);
    setSynthError("");
    try {
      setSynthesis(await generateSynthesis(topic.id, "conclusion"));
    } catch (e) {
      setSynthError(e instanceof Error ? e.message : "Reflection failed");
    } finally {
      setSynthesizing(false);
    }
  }

  async function conclude() {
    setSaving(true);
    setError("");
    try {
      // If we already produced a looking-back synthesis here, don't regenerate.
      await concludeTopic(topic.id, {
        closingNote: note,
        skipSynthesis: !!synthesis,
      });
      onConcluded();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not conclude thread");
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-40 overflow-y-auto bg-paper">
      <div className="mx-auto max-w-lg px-6 pb-28 pt-6">
        <button
          onClick={onClose}
          className="pressable min-h-[44px] text-sm font-semibold text-muted"
        >
          ← Cancel
        </button>

        <header className="mb-6 mt-2">
          <p className="text-sm font-semibold uppercase tracking-[0.2em] text-moss">
            Concluding
          </p>
          <h1 className="font-display text-3xl font-medium leading-tight">{topic.title}</h1>
          <p className="mt-2 text-[15px] leading-relaxed text-muted">
            Sit with the whole arc before you close it. Concluded threads become read-only but
            stay fully browsable.
          </p>
        </header>

        {/* Timeline */}
        <section className="mb-8">
          <h2 className="mb-3 text-xs font-bold uppercase tracking-[0.18em] text-muted">
            The journey
          </h2>
          {loading ? (
            <p className="text-muted">Gathering the timeline…</p>
          ) : timeline.length === 0 ? (
            <p className="text-muted">No entries or notes on this thread yet.</p>
          ) : (
            <ol className="space-y-3 border-l border-hairline pl-4">
              {timeline.map((it) =>
                it.kind === "entry" ? (
                  <li key={`e-${it.entry.id}`} className="relative">
                    <span className="absolute -left-[21px] top-1.5 h-2 w-2 rounded-full bg-moss" />
                    <p className="text-xs font-bold uppercase tracking-wider text-muted">
                      {formatLongDate(it.entry.date)}
                      {it.entry.entry_type === "challenge" && (
                        <span className="ml-2 text-rust">challenge</span>
                      )}
                    </p>
                    <p className="font-display text-lg">{it.entry.verse_ref}</p>
                  </li>
                ) : (
                  <li key={`n-${it.note.id}`} className="relative">
                    <span className="absolute -left-[21px] top-1.5 h-2 w-2 rounded-full bg-ink/30" />
                    <p className="text-xs font-bold uppercase tracking-wider text-muted">
                      {new Date(it.note.created_at).toLocaleDateString("en-AU", {
                        day: "numeric",
                        month: "short",
                      })}{" "}
                      · note
                    </p>
                    <p className="whitespace-pre-wrap text-[15px] leading-relaxed text-ink/80">
                      {it.note.body}
                    </p>
                  </li>
                ),
              )}
            </ol>
          )}
        </section>

        {/* Looking-back synthesis */}
        <section className="mb-8">
          <h2 className="mb-3 text-xs font-bold uppercase tracking-[0.18em] text-muted">
            Looking back
          </h2>
          {synthesis ? (
            <SynthesisCard synthesis={synthesis} latest />
          ) : (
            <div className="rounded-2xl border border-hairline bg-surface p-5">
              <p className="text-[15px] leading-relaxed text-muted">
                Generate a reflective read of the whole journey — what keeps returning, tensions,
                and where it seems to have led.
              </p>
              <button
                onClick={() => void lookBack()}
                disabled={synthesizing || !hasMaterial}
                className="pressable mt-4 min-h-[44px] w-full rounded-xl bg-moss py-3 font-semibold text-white disabled:opacity-50"
              >
                {synthesizing ? "Listening for what returns…" : "Generate looking-back reflection"}
              </button>
              {!hasMaterial && (
                <p className="mt-2 text-xs text-muted">
                  Nothing to reflect on yet — this thread has no entries or notes.
                </p>
              )}
              {synthError && <p className="mt-3 text-sm text-rust">{synthError}</p>}
            </div>
          )}
        </section>

        {/* Closing note */}
        <section>
          <h2 className="mb-3 text-xs font-bold uppercase tracking-[0.18em] text-muted">
            A closing note
          </h2>
          <textarea
            rows={4}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Your own last word — what you heard, what settled, what's still open."
            className="w-full resize-none rounded-xl border border-hairline bg-surface px-4 py-3 outline-none focus:border-moss"
          />

          {error && <p className="mt-3 text-sm text-rust">{error}</p>}

          <div className="mt-5 flex gap-3">
            <button
              onClick={onClose}
              className="pressable min-h-[48px] flex-1 rounded-xl border border-hairline bg-surface font-semibold"
            >
              Cancel
            </button>
            <button
              onClick={() => void conclude()}
              disabled={saving}
              className="pressable min-h-[48px] flex-1 rounded-xl bg-rust font-semibold text-white disabled:opacity-50"
            >
              {saving ? "Concluding…" : "Conclude thread"}
            </button>
          </div>
        </section>
      </div>
    </div>
  );
}
