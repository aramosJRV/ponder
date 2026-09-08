# SPEC — "To ponder" redesign

Status: **design only, nothing built.** 8 Sep 2026.
Mock: `ponder-section-mock.html` (open in a browser, tap through frame 1).

Goal: stop the ponder questions reading as three bullets to skim. Pace them,
anchor one of them in today's actual passage, and let a note attach to a
single question rather than to the whole entry.

---

## 1. What changes

| | Today | Proposed |
|---|---|---|
| Layout | `<ol>` of 2–3 questions, all visible | one card at a time, stacked-card affordance showing how many remain |
| Entry | questions just sit there | gate card: "Ready to ponder?" → Begin |
| Q1 | generic | **verse-anchored** — names a real phrase from today's passage |
| Notes | one composer at the bottom of the entry | a note per question, plus the existing general composer |
| Journal | loose note bodies | each note carries the question it answered |

Non-goals: no streaks, no completion badge, no timer the reader can see, no
new setting.

---

## 2. The pacing mechanism — tap to reveal

**DECIDED 8 Sep: no timer.** The next question is revealed by the reader's tap,
whenever they are ready. Agency over enforcement.

The tap target is **the stacked card peeking beneath the current one**, not a
"Next" button in the footer. Two reasons this matters:

- The stack is doing double duty — it already shows how many questions remain,
  and making it the control means the count and the advance are the same
  object. A footer button plus a decorative stack is two things to look at.
- A full-width strip at the bottom of the card is a deliberate, thumb-sized
  gesture. A small pill button next to "Write a note" reads as a wizard step
  and invites the triple-tap.

Strip copy: `NEXT QUESTION` → `LAST QUESTION` → `THAT'S THE THREE`.

The only guard is mechanical, not a rule: the strip is inert for the 420ms of
the incoming card's existing `rise` animation, so a double-tap cannot chain two
questions past the reader. That is not a countdown and nothing is displayed —
it just stops a fat-finger from eating a question.

Rejected: timed fade-in of the Next control (reader is being managed), visible
progress/countdown (turns reflection into a timed exercise), swipe-only
(inaccessible, undiscoverable).

### The gate

One tap, inline, not a modal. Fixed copy — rotating "encouragement" goes stale
fastest.

```
Ready to ponder?                      ← Cormorant, italic, 27px

Three questions, one at a time.
Stay with each until it's finished     ← 14.5px, muted, two lines
with you.

        [ Begin ]

    Show all three instead
```

Why this line and not "there's nothing here to get through": it reverses who is
doing the work. The reader isn't processing a question and moving on — the
question is working on *them*, and they leave when it's done, not when they
are. That reversal is the app's whole premise stated in eight words. Keep the
count ("three questions") — hiding it doesn't slow anyone down, it just makes
the reader guess.

**The gate has a real cost worth naming:** it is a daily interstitial. By week
three it is muscle memory for a returning user. Mitigations built in:
- `Show all three instead` is always present (mirrors the existing `Read it all`
  fold — this codebase's rule is *fold, never hide*).
- Skipped entirely at content level 1 (see §5).
- It is a wrapper, not a dependency: if it proves to be a speed bump it can be
  dropped without touching the flow beneath it.

## 3. Verse-anchored question

New nullable column, on **both** `daily_entries` and `entry_pool`:

```sql
verse_question jsonb null   -- { "question": "...", "phrase": "..." }
```

Rules:
- `phrase` MUST be validated server-side as a case-insensitive substring of the
  WEB `verse_text` for that entry, exactly like `cross_refs` are validated
  against `bible_verses`. Fails validation → keep `question`, drop `phrase`,
  render without the pull-quote and without the highlight. Model output never
  reaches the screen as scripture.
- Null on every existing entry and every entry already in the pool. The card
  falls back to today's behaviour: `ponder[0]` becomes question 1, no badge.
  **No backfill.** The pool turns over on its own.
- The phrase drives a highlight in the verse hero (`<span class="hl">`), which
  is why substring validation is non-negotiable — a phrase that isn't in the
  text can't be highlighted.
- Generation: add `verse_question` to the `record_devotional` tool schema as
  required; the system prompt gets a rule that the phrase must be copied
  verbatim from the passage supplied to it, and the question must be
  unanswerable without having read the verse ("what stands out", "what does
  <word> mean to you today", "which clause needs more thought").
- Pool builder needs the same change or new pool entries arrive without it.
  Check both call sites — `generate-entry` writes the live path and the pool
  path, and they have diverged before.

`ponder` stays `text[]`. No array-shape migration, no breaking change for
installed clients doing `select *`.

---

## 4. Per-question notes

```sql
alter table public.notes
  add column ponder_index smallint null
  check (ponder_index is null or ponder_index between 0 and 3);
```

- `null` = general note (every existing note, and the composer at the bottom
  of the card — unchanged).
- `0` = the verse-anchored question. `1..3` = `ponder[n-1]`.
- Additive column: safe for old installed builds doing `select *` on notes.
  (The 25 Aug outage was a **revoke**, not an add — different failure.)
- `guard_notes_on_concluded` trigger, RLS, cascade deletes: untouched.
- Index: existing `notes_entry_idx` covers the per-entry read; no new index
  needed at this scale.

**The payoff is synthesis, not the composer.** `synthesize` currently sends
free-floating note bodies. With `ponder_index` it can send question→answer
pairs, which is a materially better prompt: the model stops guessing what the
user was responding to.

**The cost is real too.** Note volume per entry goes from ~1 to up to 4.
Consequences to accept up front:
- Thread journal gets denser — grouping by entry with the question as a
  sub-heading (mocked) handles it, but the "one journal" reading experience
  changes shape.
- Synthesis input tokens grow. Currently unbounded — a long-running thread
  already sends every note. This makes that bite sooner. **Cap or summarise
  note input in `synthesize` as part of this work, not after.**
- Delete-a-note UI in TopicDetail needs the question shown so the user knows
  which one they're deleting.

---

## 5. Content level interaction

Level 1 (Brief) is defined as "passage and questions". Gating the questions
leaves a Brief reader with a passage and a locked box — that is a regression,
not a pause.

Rule: **at level 1 the gate is skipped** and the card opens on question 1.
At levels 2 and 3 the gate shows. The one-at-a-time flow is identical in all
three; only the gate is conditional.

---

## 6. States to build

| State | Note |
|---|---|
| Gate | levels 2–3 only |
| Question (verse-anchored) | badge + phrase pull-quote |
| Question (plain) | no badge |
| Note composing | inline in the card, question stays visible above the textarea |
| Reveal strip | inert 420ms during card entrance; label changes on the last card |
| Note saved | shown under the question, moss left-rule |
| Close | "That's the three", revisit list, then the general composer |
| Show-all | the current `<ol>`, reachable at any point |
| Challenge posture | rust throughout, same as the hero |
| Offline | note button disabled with the existing offline copy |
| Legacy entry (`verse_question` null) | flow runs on `ponder[]` alone |

Accessibility: the card is a live region; the reveal strip is a real `<button>`
with an accessible label ("Reveal question 2 of 3"), not a swipe target. Swipe can be added as an *additional* gesture, never the only one.
Pips get `aria-hidden`; the "1 of 3" line is the accessible progress.

---

## 7. Build order

1. Migration: `verse_question` on `daily_entries` + `entry_pool`, `ponder_index`
   on `notes`. **Needs approval before applying.**
2. `generate-entry`: tool schema + prompt rule + phrase substring validation.
   Both the live path and the pool path.
3. Types (`DailyEntry.verse_question`, `Note.ponder_index`), `api.addNote`
   signature.
4. New `PonderFlow` component; `EntryCard` renders it in place of the `<ol>`.
   `NoteComposer` unchanged for the general case.
5. `TopicDetail` journal grouping; delete dialog copy.
6. `synthesize`: Q→A pairing **and** a cap on note input.
7. Verify: `npx tsc --noEmit` (a real build cannot run in the Cowork VM),
   then a legacy entry with `verse_question` null on a device.
