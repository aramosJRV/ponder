import { useEffect, useState } from "react";
import type { ContentLevel, DailyEntry, Note, Song, Translation } from "../lib/types";
import { useContentLevel } from "../lib/contentLevel";
import {
  DEFAULT_TRANSLATION,
  TRANSLATIONS,
  translationName,
  usePassage,
  useTranslation,
} from "../lib/translations";
import type { PassageState } from "../lib/translations";
import PassageContextSheet from "./PassageContextSheet";
import PonderFlow from "./PonderFlow";
import ReportButton from "./ReportButton";

/**
 * The entry card.
 *
 * Content level folds sections; it never removes them. Every entry is
 * generated and stored in full regardless of the reader's level — the level
 * only decides what is open on first render, and "Read it all" opens the
 * rest in place. That matters for this app specifically: the thought and the
 * challenge framing are the parts doing the discernment work, so a setting
 * that permanently deleted them would quietly turn Ponder into a
 * verse-of-the-day app for anyone who picked Brief once and moved on.
 *
 *   1  passage + questions
 *   2  + thought
 *   3  + illustration, prayer, song
 */
export default function EntryCard({
  entry,
  notes = [],
  // Named apart from the card's own `offline` flag, which is about a
  // translation that could not be fetched, not about the network.
  offline: notesOffline = false,
  onNoteAdded,
}: {
  entry: DailyEntry;
  /** Notes on this entry. Per-question ones are shown against their question. */
  notes?: Note[];
  offline?: boolean;
  /** Omit to render the ponder flow read-only (the TopicDetail viewer does). */
  onNoteAdded?: (note: Note) => void;
}) {
  const level = useContentLevel();
  const [expanded, setExpanded] = useState(false);
  const [contextOpen, setContextOpen] = useState(false);

  // A new entry starts folded again — otherwise switching threads on Today
  // carries the previous card's expanded state across.
  useEffect(() => {
    setExpanded(false);
    setContextOpen(false);
  }, [entry.id]);

  // Which version this card is showing right now. Seeded from the standing
  // preference and reset by it — tapping KJV on today's passage is a reading
  // gesture, not a settings change, so it must not follow the reader to the
  // next entry or to tomorrow's notification.
  const preferred = useTranslation();
  const [translation, setTranslation] = useState<Translation>(preferred);
  const [offline, setOffline] = useState(false);
  useEffect(() => {
    setTranslation(preferred);
    setOffline(false);
  }, [entry.id, preferred]);

  const passage = usePassage(entry, translation);

  // NOTE: the passage is shown PLAIN, in every version. The verse_question
  // phrase is never marked up here. Highlighting it pre-answers the question —
  // the reader's eye lands on the marked words before they have been asked
  // anything, which is the opposite of what the ponder flow is for. The phrase
  // appears in the question card instead, once the reader has chosen to look.
  // Do not "restore" the highlight.

  // A version we cannot reach is not a version the reader can sit with.
  // Fall back to the text the entry already carries and say why, rather
  // than leaving a selected tab over an empty hero.
  useEffect(() => {
    if (passage.status === "unavailable" && translation !== DEFAULT_TRANSLATION) {
      setTranslation(DEFAULT_TRANSLATION);
      setOffline(true);
    }
  }, [passage.status, translation]);

  const shown: ContentLevel = expanded ? 3 : level;
  const challenge = entry.entry_type === "challenge";
  const showSong = shown >= 3 && !!entry.song;

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

      <VerseHero
        entry={entry}
        challenge={challenge}
        translation={translation}
        passage={passage}
        offline={offline}
        onSelect={(t) => {
          setOffline(false);
          setTranslation(t);
        }}
        onReadContext={() => setContextOpen(true)}
      />

      <PassageContextSheet
        entry={entry}
        translation={translation}
        open={contextOpen}
        onClose={() => setContextOpen(false)}
      />

      {shown >= 2 && (
        <section className="mt-8">
          <h2 className="mb-2 text-xs font-bold uppercase tracking-[0.18em] text-muted">
            Thought
          </h2>
          <p className="text-[17px] leading-relaxed">{entry.thought}</p>
        </section>
      )}

      {shown >= 3 && (
        <section className="mt-8">
          <h2 className="mb-2 text-xs font-bold uppercase tracking-[0.18em] text-muted">
            Illustration
          </h2>
          <p className="border-l-2 border-hairline pl-4 text-[16px] leading-relaxed text-ink/90 [font-style:italic]">
            {entry.illustration}
          </p>
        </section>
      )}

      <PonderFlow
        entry={entry}
        notes={notes}
        offline={notesOffline}
        onNoteAdded={onNoteAdded}
        challenge={challenge}
      />

      {shown >= 3 && (
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
      )}

      {showSong && <SongRow song={entry.song!} />}

      {level < 3 && (
        <MoreToggle
          expanded={expanded}
          level={level}
          onToggle={() => setExpanded((v) => !v)}
        />
      )}

      <Footnotes
        entry={entry}
        shown={shown}
        showSong={showSong}
        translation={translation}
      />
    </article>
  );
}

/**
 * The passage — the typographic hero, bleeding on warm ground.
 *
 * The version tabs live inside it rather than in a toolbar because the
 * choice is about THIS passage and nothing else on the card changes with
 * it. They take the entry's posture colour so the strip never visually
 * contradicts the "harder question today" badge above it.
 *
 * Three states other than plain text, and each one is a real thing that
 * happens rather than defensive padding:
 *   loading      — dim the previous text instead of blanking the hero, so
 *                  a tap does not collapse the page and reflow everything
 *                  under it.
 *   absent       — the passage genuinely is not in that translation.
 *   (unavailable is handled by the parent, which reverts to the WEB.)
 */
function VerseHero({
  entry,
  challenge,
  translation,
  passage,
  offline,
  onSelect,
  onReadContext,
}: {
  entry: DailyEntry;
  challenge: boolean;
  translation: Translation;
  passage: PassageState;
  offline: boolean;
  onSelect: (t: Translation) => void;
  onReadContext: () => void;
}) {
  const accent = challenge ? "text-rust" : "text-moss";
  // "unavailable" is a single frame: the parent reverts to the WEB the moment
  // it sees that status. Render the text the entry already carries rather
  // than flashing an empty hero on the way there.
  const text = "text" in passage ? passage.text : entry.verse_text;
  return (
    <section className={`-mx-6 px-6 py-8 ${challenge ? "bg-rust-soft" : "bg-moss-soft"}`}>
      {passage.status === "absent" ? (
        <p className="font-display text-[22px] font-medium leading-snug text-ink/60">
          This passage isn’t in the {translationName(translation)}.
        </p>
      ) : (
        <p
          aria-busy={passage.status === "loading"}
          className={`font-display text-[28px] font-medium leading-snug transition-opacity duration-200 ${
            passage.status === "loading" ? "opacity-40" : "opacity-100"
          }`}
        >
          &ldquo;{text}&rdquo;
        </p>
      )}

      <p
        className={`mt-4 text-sm font-bold uppercase tracking-[0.18em] ${accent}`}
      >
        {entry.verse_ref} · {translation}
      </p>

      {/* Not "read the full chapter". The unit offered is the pericope the
          verse actually sits in — often tighter than a chapter, and sometimes
          crossing one. */}
      <button
        type="button"
        onClick={onReadContext}
        className={`pressable mt-3 inline-flex min-h-[40px] items-center rounded-full border px-4 text-[13px] font-semibold transition-colors ${
          challenge
            ? "border-rust/30 text-rust hover:bg-rust/10"
            : "border-moss/30 text-moss hover:bg-moss/10"
        }`}
      >
        Read the full context
      </button>

      <div
        role="radiogroup"
        aria-label="Bible version"
        className={`mt-4 flex gap-1 border-t pt-3 ${
          challenge ? "border-rust/20" : "border-moss/20"
        }`}
      >
        {TRANSLATIONS.map((t) => {
          const on = t.value === translation;
          return (
            <button
              key={t.value}
              type="button"
              role="radio"
              aria-checked={on}
              aria-label={t.name}
              onClick={() => onSelect(t.value)}
              className={`pressable rounded-full px-3.5 py-2.5 text-[11px] font-bold uppercase tracking-[0.16em] transition-colors ${
                on
                  ? challenge
                    ? "bg-rust text-paper"
                    : "bg-moss text-paper"
                  : `text-muted ${challenge ? "hover:text-rust" : "hover:text-moss"}`
              }`}
            >
              {t.label}
            </button>
          );
        })}
      </div>

      {offline && (
        <p className="mt-3 text-xs leading-snug text-muted">
          Couldn’t reach that version. Showing the {translationName(DEFAULT_TRANSLATION)}.
        </p>
      )}
    </section>
  );
}

/**
 * The fold. Deliberately not a chevron on each hidden section — three
 * disclosure rows turn a page meant for sitting still into a control panel.
 * One line, plain words, no count of what is behind it.
 */
function MoreToggle({
  expanded,
  level,
  onToggle,
}: {
  expanded: boolean;
  level: ContentLevel;
  onToggle: () => void;
}) {
  const more = level === 1 ? "There’s a thought, an illustration and a prayer with this one" : "There’s an illustration and a prayer with this one";
  return (
    <div className="mt-8">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        className="w-full rounded-xl border border-hairline bg-surface px-4 py-3 text-left text-[15px] leading-snug text-muted transition-colors hover:border-moss"
      >
        {expanded ? (
          <span className="font-semibold text-moss">Show less</span>
        ) : (
          <>
            <span className="block">{more}</span>
            <span className="mt-0.5 block font-semibold text-moss">Read it all</span>
          </>
        )}
      </button>
    </div>
  );
}

/**
 * Song of the day.
 *
 * Only ever rendered when the server resolved a real Spotify track, so there
 * is no loading, error or empty state to handle here — absence is silence.
 * Challenge entries never carry one.
 *
 * Rendering rules are Spotify's, not ours: title, artist and artwork must
 * appear exactly as the API returned them, artwork gets a 4px radius with
 * nothing overlaid, and the link text must be one of Spotify's approved
 * phrases. Do not "improve" the copy here.
 *
 * The plain <a target="_blank"> is deliberate. Capacitor routes external
 * http(s) navigations out to the system browser, which honours the
 * open.spotify.com universal link and hands off to the Spotify app if it is
 * installed. @capacitor/browser would open SFSafariViewController instead,
 * which does NOT reliably honour universal links — the user would get the
 * web player in a sheet rather than their own Spotify.
 */
function SongRow({ song }: { song: Song }) {
  return (
    <section className="mt-8">
      <h2 className="mb-3 text-xs font-bold uppercase tracking-[0.18em] text-muted">
        Something to listen to
      </h2>
      <a
        href={song.url}
        target="_blank"
        rel="noreferrer"
        className="flex items-center gap-3 rounded-xl border border-hairline bg-surface px-3 py-3"
      >
        {song.art && (
          <img
            src={song.art}
            alt=""
            loading="lazy"
            className="h-12 w-12 shrink-0 rounded-[4px]"
          />
        )}
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[15px] font-medium">{song.name}</span>
          <span className="block truncate text-[13px] text-muted">{song.artist}</span>
        </span>
        <span className="flex shrink-0 items-center gap-1.5">
          <SpotifyIcon />
          <span className="text-[11px] font-bold uppercase tracking-wider text-[#1DB954]">
            Play on Spotify
          </span>
        </span>
      </a>
    </section>
  );
}

/**
 * TODO before store submission: replace with the official Spotify full logo
 * (icon + wordmark) downloaded from Spotify's brand assets page. Spotify's
 * guidelines forbid recreating or altering the mark, and this is a hand-drawn
 * approximation of the icon standing in until the real asset is dropped in.
 * The approved link text beside it is doing the "full logo" job in the
 * meantime, which the guidelines allow where space is constrained.
 */
function SpotifyIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="h-[18px] w-[18px]" fill="#1DB954">
      <path d="M12 0C5.4 0 0 5.4 0 12s5.4 12 12 12 12-5.4 12-12S18.66 0 12 0zm5.52 17.28a.75.75 0 0 1-1.03.25c-2.82-1.72-6.36-2.11-10.54-1.16a.75.75 0 1 1-.33-1.46c4.57-1.04 8.49-.59 11.65 1.34.35.22.46.68.25 1.03zm1.47-3.27a.94.94 0 0 1-1.29.31c-3.23-1.98-8.15-2.56-11.97-1.4a.94.94 0 1 1-.54-1.8c4.36-1.32 9.78-.68 13.49 1.6.44.27.58.85.31 1.29zm.13-3.41C15.25 8.3 8.9 8.09 5.19 9.22a1.12 1.12 0 0 1-.65-2.15c4.26-1.29 11.28-1.04 15.72 1.59a1.12 1.12 0 1 1-1.14 1.94z" />
    </svg>
  );
}

/**
 * Sources footnote. Every reference shown here was resolved against the
 * bible_verses table server-side before the entry was stored — the model
 * never supplies scripture text, only references that then had to prove
 * they exist.
 *
 * The passage line names whichever version is on screen. It has to: the
 * whole point of a citation is that it says where the words in front of
 * you came from, and a tab switch changes the words.
 */
function Footnotes({
  entry,
  shown,
  showSong,
  translation,
}: {
  entry: DailyEntry;
  shown: ContentLevel;
  showSong: boolean;
  translation: Translation;
}) {
  // Cross references belong to the thought and the illustration; with those
  // folded away there is nothing on screen that drew on them.
  const crossRefs = shown >= 2 ? (entry.cross_refs ?? []) : [];
  return (
    <section className="mt-10 border-t border-hairline pt-4">
      <h2 className="mb-2.5 text-[11px] font-bold uppercase tracking-[0.18em] text-muted">
        Sources
      </h2>

      <ol className="space-y-1.5 text-[13px] leading-snug text-muted">
        <li className="flex gap-2">
          <span className="shrink-0 tabular-nums">1.</span>
          <span>
            Passage: <span className="text-ink/70">{entry.verse_ref}</span>,{" "}
            {translationName(translation)} (public domain).
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
              . References only — no text from them is shown.
            </span>
          </li>
        )}

        <li className="flex gap-2">
          <span className="shrink-0 tabular-nums">
            {crossRefs.length > 0 ? "3." : "2."}
          </span>
          <span>
            Everything here other than the passage was written by AI as
            material for your discernment — not a word about your life.
          </span>
        </li>

        {showSong && (
          <li className="flex gap-2">
            <span className="shrink-0 tabular-nums">
              {crossRefs.length > 0 ? "4." : "3."}
            </span>
            <span>
              Song metadata and artwork from Spotify. Ponder is not affiliated
              with Spotify AB.
            </span>
          </li>
        )}
      </ol>

      <div className="mt-4 flex justify-end">
        <ReportButton entry={entry} />
      </div>
    </section>
  );
}
