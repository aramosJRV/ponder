import { useState } from "react";
import type { DailyEntry, Note } from "../lib/types";
import { addNote } from "../lib/api";

interface Props {
  entry: DailyEntry;
  notes: Note[];
  onAdded: (note: Note) => void;
  offline: boolean;
}

export default function NoteComposer({ entry, notes, onAdded, offline }: Props) {
  const [body, setBody] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  async function save() {
    const trimmed = body.trim();
    if (!trimmed) return;
    setSaving(true);
    setError("");
    try {
      const note = await addNote(entry, trimmed);
      onAdded(note);
      setBody("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save note");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="mt-10 border-t border-hairline pt-6">
      {/* "Anything else", not "Your notes". Since notes attach to individual
          ponder questions, a second box labelled "your notes" reads as the
          real one and makes the per-question composers look like a detour.
          This is the leftovers box: what belongs to the whole day rather
          than to any one question. */}
      <h2 className="mb-3 text-xs font-bold uppercase tracking-[0.18em] text-muted">
        Anything else
      </h2>

      {notes.length > 0 && (
        <ul className="mb-4 space-y-3">
          {notes.map((n) => (
            <li key={n.id} className="rounded-xl bg-moss-soft px-4 py-3">
              <p className="whitespace-pre-wrap text-[15px] leading-relaxed">{n.body}</p>
              <p className="mt-1.5 text-xs text-muted">
                {new Date(n.created_at).toLocaleTimeString("en-AU", {
                  hour: "numeric",
                  minute: "2-digit",
                })}
              </p>
            </li>
          ))}
        </ul>
      )}

      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        rows={3}
        placeholder={
          offline
            ? "You're offline — notes need a connection for now"
            : "Anything that belongs to the whole of today rather than to one question"
        }
        disabled={offline}
        className="w-full resize-none rounded-xl border border-hairline bg-surface px-4 py-3 text-[15px] leading-relaxed outline-none focus:border-moss disabled:opacity-60"
      />
      <div className="mt-2 flex items-center justify-between">
        {error ? <p className="text-sm text-rust">{error}</p> : <span />}
        <button
          onClick={save}
          disabled={saving || offline || !body.trim()}
          className="pressable min-h-[44px] rounded-xl bg-ink px-5 text-sm font-semibold text-paper disabled:opacity-40"
        >
          {saving ? "Saving…" : "Save note"}
        </button>
      </div>
    </section>
  );
}
