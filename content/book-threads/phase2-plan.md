# Book threads: Phase 2 technical plan

Nothing in this plan has been built, applied or deployed. The database change is
only written as a file (`supabase/migrations/20261020000001_book_threads.sql`).

---

## 1. The idea in one paragraph

A book thread is an ordinary thread with one extra fact attached: which book it is
reading. Each day it gets an ordinary entry, so every app version can show it. In
that entry, the "verse" is the key verse, and the Thought, illustration, ponder and
prayer are the shared writing for that section. The new app also shows the whole
section, the reader's place in the book, and the ending. The writing for each
section is made once, checked by the Phase 1 checks, saved, and handed to every
reader who reaches it.

---

## 2. Database changes (all additions, nothing removed or renamed)

| Change | What it's for | Can old app versions see it? |
|---|---|---|
| `topics.book_number` (new, empty for existing threads) | Marks a thread as a book thread | No. They ask for a fixed list of columns that doesn't include it |
| `daily_entries.book_section` (new, empty for normal days) | The whole section and "9 of 48" | They receive it and ignore it |
| `daily_entries.opened_on` (new, empty) | The date the reader first saw the entry, in their own time zone | They receive it and ignore it |
| New table `book_section_content` | The shared writing library, one row per section | No. It's hidden from all apps, the same way the existing entry library is |
| `mark_entry_opened` | The new app calls this when it shows an entry. It records the date and queues the next section to be written | Old versions never call it |
| `book_catalogue` | The book list with section counts for the picker | Only the new app uses it |
| Every-5-minutes job `ponder-book-build` | Writes any queued sections. Does nothing (and costs nothing) when the queue is empty | Background only |

This keeps the hard rules: no column-level permissions, nothing dropped, hidden
data in its own table. I checked against the live database: its migrations match
the repo up to 14 Oct, and none of these names exist yet.

---

## 3. Pacing: when does the next section appear?

The rule lives in one small piece of code with its own tests. Each time the
nightly job runs, or the app asks for the day's entry, the server looks at the
newest entry on that book thread:

| Situation | What happens |
|---|---|
| No entries yet (thread just started) | Create section 1 |
| Newest entry not opened yet | **Nothing moves.** That same entry is carried forward to today's date, so it's still on Today, and history still shows one entry per section |
| Opened on an earlier date than today | Create the next section |
| Opened today | Nothing. The next one comes tomorrow |
| Last section, opened | The book is finished. The new app shows the ending. The last entry stays on Today until the reader concludes it |
| Gone for a week | Same section waiting, no message about being away |

"Today" always means the reader's own date in their Settings time zone, the same
clock the nightly entries already use. Progress only ever appears as
**"Mark 4:1–20 · section 9 of 87"** plus a thin bar. Nothing about days or time.

Note: by the existing section data, Mark has 87 sections (not 48), John 75,
Philippians 12, Ruth 9 and Psalms 171.

---

## 4. Writing the sections

- **When:** a section is written the first time anyone needs it. When a reader
  opens section 9, section 10 joins the queue. The 5-minute job writes it, so it's
  ready well before tomorrow.
- **The first section of all 66 books is written in advance** (once, at launch).
  That way, starting any book is instant.
- **How:** exactly the Phase 1 recipe. Write, run the machine checks and the
  reviewer, then up to 2 fix-up rounds. Only a reading that passes everything is
  saved. If a section fails 3 times, it's marked failed, the reader sees the
  existing "running late" message, and the failure is logged where we already look.
- **Then:** the "Read slowly" phrases for the key verse, using the existing
  verse-walk code.
- **Cost (estimate, to be measured in Phase 3):** about $0.15–0.30 per section,
  once, ever. The 66 first sections come to about $10–20. If readers eventually
  reached every section of the whole Bible (3,068), the total would be roughly
  $500–900, spread over time. The existing spend tripwire covers this job too.
- No song, quote or extra cross-references on book days, to keep things simple.

---

## 5. Screens in the new app

1. **Add a thread** asks "a question" or "a book" first. "A question" is today's
   flow, unchanged.
2. **Book picker:** Mark, John, Philippians, Ruth and Psalms at the top, each with
   a one-line description and section count. Then all 66 books in Bible order.
   Draft descriptions (yours to change):
   - **Mark:** the shortest Gospel, fast and vivid, with Jesus always on the move.
   - **John:** Jesus through the eyes of a close friend, from the Word made flesh to the empty tomb.
   - **Philippians:** a warm letter from prison about joy, humility and pressing on.
   - **Ruth:** a short, quiet story of loss, loyalty and unexpected kindness.
   - **Psalms:** the Bible's prayer book of praise, lament and trust.
3. **Today, on a book thread:** the full section in the reader's translation, with
   the key verse highlighted. "Read slowly" and "Context" work on the key verse as
   they do now. Then Thought, illustration, ponder and prayer, and the progress
   line.
4. **Ending:** after the last section, Today shows "You've reached the end of
   Mark". This leads into the existing conclusion flow and its looking-back
   reflection, which then frees the slot. The reflection is told the thread was a
   read-through of the book, so it doesn't talk as if the reader brought a question.
5. **Switcher, 3-thread limit, history:** unchanged. A book thread counts as one
   thread.

---

## 6. Exactly what old app versions do (1.0.20 and 1.0.21)

- **They can't start a book thread.** Their "new thread" screen only makes question threads.
- **If the same account has a book thread** (started on the new app, opened on an
  old one), it shows as a thread called "Mark". Each entry shows as a normal day:
  the key verse, Thought, illustration, ponder, prayer, notes, Context and Read
  slowly. They don't show the whole section or the progress line.
- **Tapping "get today's entry"** on a book thread gets the right section,
  because the server handles book threads on that path too.
- **Limitation:** old versions never report "opened", so a reader who only ever
  uses an old version on a book thread keeps seeing the same section. That's only
  possible after starting the book on the new app. Opening it once on the new app
  moves it on.

---

## 7. Things that could affect existing users ⚠️

1. **The `generate-entry` deploy touches the nightly path for everyone.** Book
   threads branch off at the very start, and question threads take exactly the
   path they take now. Before deploying, I download the live version and explain
   every difference to you (the 24 Sep drift trap).
2. **The database change** adds columns to two tables every user reads. They're
   additions only, which old versions are known to tolerate. Phase 3 proves this
   by running the 1.0.20 queries against the new database (section 8).
3. **A new background job** runs every 5 minutes. When nothing is queued, it stops
   after one quick check.
4. **Spend:** see section 4. The tripwire applies.
5. **Order:** database first, then the function, then the app. The app never
   ships before the backend it needs.

---

## 8. Phase 3: checks that must all pass (built first, proven to fail on a bad example)

| # | Check | How it runs |
|---|---|---|
| 1 | Function type check: `deno check` with the CLAUDE.md flags on generate-entry and synthesize, exit 0 | Command |
| 2 | Content checker tests (Phase 1, 11 tests) | `deno test` |
| 3 | **Pacing tests:** opened today → next tomorrow; not opened → stays put; away a week → same section; last section → finished; opened just before / just after midnight in Sydney, London and Los Angeles; first section of a new thread | `deno test`, no network |
| 4 | **Book writer job tests**, with a fake model (no network): passes → saved; fails 3 times → marked failed; only ready rows are served; book threads never reach the question-thread library or classifier | `deno test` |
| 5 | **Migration test** on a private copy of the live schema (copied read-only, run in a throwaway database on your Mac): the migration applies; book library hidden from apps; a reader can't mark someone else's entry; catalogue returns 66 books | Script, exit code |
| 6 | **Old-build check:** the exact queries from 1.0.20's `src/lib/api.ts` run against the new schema and succeed, and a book-day row reads back with every field the old app needs | Script, exit code |
| 7 | **Old-build render:** the 1.0.20 app, run in a browser against the private copy, shows a book day as a normal entry (screenshot) | Run + screenshot |
| 8 | **Content samples:** Phase 1 preview re-run after any prompt change, 8 of 8 clean | Script, exit code |
| 9 | **App:** `npm run build` (type check + build) passes | Command |
| 10 | **App run-through** in the browser against the private copy: picker, book day, progress, ending, plus a question thread unchanged. I compare the screenshots with this plan before showing you | Run + screenshots |
| 11 | **Before any deploy:** live function downloaded and diffed, every difference explained | Command + my notes |

Nothing in the loop writes to the live database. The live database is only read,
to copy its structure.

---

## 9. Build order for Phase 3 (on the feature branch)

1. Checks 3–6 first, and show they fail.
2. Database file, then `generate-entry` book path and the 5-minute writer, then
   the synthesize framing. Loop until checks 1–6 pass.
3. App screens. Loop until checks 9–10 pass.
4. Come back to you with all check output, screenshots, the live diff, and three
   separate yes/no questions: apply the database change, deploy the function,
   pre-write the 66 first sections. Then the app build goes to the stores after that.

## Left for you to judge

- The starter book descriptions (section 5).
- Whether the carried-forward entry (section 3) feels right in history.
- Tone of the "end of the book" screen (shown in Phase 3).
