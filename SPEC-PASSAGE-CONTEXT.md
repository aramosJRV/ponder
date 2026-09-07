# SPEC — Read the full context

Status: **planned, not built.** Written 7 Sep 2026.

Give the reader the verse of the day inside its literary unit — the
pericope — instead of "read the full chapter". The unit may span a
chapter boundary, because chapter divisions are a 13th-century
addition and routinely cut a passage in half (Isaiah 52:13–53:12,
1 Corinthians 12:31–13:13, John 7:53–8:11).

## Rejected: context filtered by topic relevance

The first framing was "show only the adjacent verses related to the
thread." **Do not build that.** Selecting context by relevance to the
thread is proof-texting with extra steps: it trims exactly the verses
that would challenge the user's framing. Psalm 46:10 is the standard
example — "Be still and know that I am God" sits in a psalm about God
ending wars and shattering spears, which cuts against the calm
devotional read. A relevance filter would remove that. It works
directly against the challenge-entry principle the app is built on.

The unit is the literary one. It is not chosen per user, per thread,
or per day, and it is identical for every reader of that verse.

## Verified source findings — do not re-research

Checked 7 Sep 2026 against the WEB USFX
(`raw.githubusercontent.com/seven1m/open-bibles/master/eng-web.usfx.xml`,
6.2 MB, the only mirror this session's egress can reach):

- **The WEB has no section headings.** Zero `\s` / `<s>` markers. The
  WEB deliberately omits editorial headings — they are not in the
  source text. There is no pericope data to import from it.
- Paragraph markers exist (~8.6k `<p>`) but average 2–3 verses. Too
  short to serve as "context" on their own.
- `\nb` (paragraph continues across a chapter break) appears **7 times
  in the whole Bible**. So WEB paragraph data would produce context
  that essentially never crosses a chapter — the one thing this
  feature exists to do.
- `scrollmapper/bible_databases` BSB.json (already in the pipeline)
  has no heading/section/pericope fields either.
- `ebible.org` is 403'd by the egress proxy from both the sandbox and
  Antonio's Mac. `codeload.github.com` and `api.github.com` are also
  blocked. Only `raw.githubusercontent.com` resolves.

Conclusion: no free deterministic pericope dataset is reachable. The
ranges have to be curated once, offline, and checked into the repo.

## The curated file

`data/pericopes.csv` — **committed to the repo**, unlike the
translation CSVs which are gitignored. It is small (~1,100 rows) and
it is the feature's only unreproducible input, so it must be in git.

Columns: `book_number, start_chapter, start_verse`.

**Starts only. Ends are derived.** Each pericope ends at the verse
immediately before the next start; the last in a book ends at the
book's final verse. This is the important design choice: it makes a
complete, non-overlapping tiling of every book true *by
construction*. There is no way to express a gap, an overlap, or a
range that runs off the end. The generator cannot produce an invalid
partition even if it tries.

Generation: one batch job, per book, model supplies the ordered start
list. Validation, all assertions, all fatal:

1. Every start resolves to a real WEB row in `bible_verses`.
2. Starts strictly increasing within a book (by `chapter*1000+verse`).
3. First start of every book is exactly `1:1`.
4. Derived ranges cover every WEB verse in the 66 books exactly once —
   assert total covered == `count(*) from bible_verses where
   translation = 'WEB'`.
5. No pericope longer than 40 verses (catches a dropped start).

Review: Antonio reviews only the rows where the derived range crosses
a chapter boundary — i.e. any start that is not verse 1 of a chapter.
That is the interesting subset and the one that carries the feature.
The rest is spot-checked.

## Schema

New migration. **Column and table adds only — no REVOKE, no
column-level grant** (see the 25 Aug outage note).

```
create table public.bible_pericopes (
  id            int generated always as identity primary key,
  book_number   smallint not null references public.bible_books(book_number),
  start_chapter smallint not null,
  start_verse   smallint not null,
  end_chapter   smallint not null,
  end_verse     smallint not null,
  span          int4range not null,   -- [start_ord, end_ord] on chapter*1000+verse
  unique (book_number, start_chapter, start_verse)
);
```

`span` uses ordinal `chapter*1000 + verse`. Safe: the longest chapter
is Psalm 119 at 176 verses. With `btree_gist` enabled this supports a
real overlap constraint:

```
exclude using gist (book_number with =, span with &&)
```

so a bad import is rejected by the database, not by a test.

Lookup is one indexed row: `book_number = ? and span @> (chapter*1000+verse)`.

`bible_pericopes` is **translation-independent**. Ranges are defined
on WEB versification and applied to all three translations. RLS: same
public read policy as `bible_verses`.

`daily_entries` is unchanged. It stores a single `chapter`, so it
cannot express a chapter-spanning range — but it does not need to.
Context is resolved at read time from
`(book_number, chapter, verse_start)`.

## Server

New RPC `passage_span(book_number, start_chapter, start_verse,
end_chapter, end_verse, translation)`.

It **returns rows** — `(chapter, verse, text)` — not a single string.
This is the deliberate difference from `passage_text`, which returns
NULL for the whole span when any verse is missing. That all-or-nothing
rule is right for a 1–2 verse hero and wrong here: one missing KJV
verse would blank a 15-verse context. Rows let the client render what
exists and mark the gap inline.

Known gaps this hits: Romans 14:24-26 has no KJV row (KJV versifies it
at 16:25-27); 15 refs have no BSB row (Matthew 17:21, Mark 9:44,
John 5:4, Acts 8:37 and the rest — deliberate textual-critical
omissions). The client shows a per-verse "not in this translation"
marker rather than hiding the omission.

Not SECURITY DEFINER — runs as the caller, so `bible_verses` RLS
still applies. End the migration with `notify pgrst, 'reload schema'`.

## Client

- `src/lib/passageContext.ts` — `usePassageContext(entry, translation)`,
  same shape as the existing `usePassage`. Reuse the bounded
  localStorage cache in `translations.ts` under its own key; a context
  passage is ~10x a hero passage, so give it a smaller limit (~30) and
  keep it out of the offline day cache.
- Entry point: a "Read the full context" affordance under `VerseHero`
  in `EntryCard`, opening a sheet. The day's verse is visually marked
  within the passage so the reader keeps their place.
- The sheet header shows the **range reference only** ("Psalm 46:1–11").
  No editorial heading label. A heading is an interpretation, and the
  point of this feature is unmediated context. Reversible if it reads
  as bare in testing.
- Translation follows the active tab, per-read, non-sticky — same rule
  as the hero.
- **Network-gated.** `daily_entries` carries only the day's own
  `verse_text`; the surrounding verses are server-side. Offline shows
  the existing offline copy, not an error. Failures are not cached; a
  genuinely-absent verse is.
- All errors through `classifyError`/`errorCopy` in `src/lib/errors.ts`.
  No bare catch on a failure surface.

## Guardrails

- Verse text still comes only from `bible_verses`. The model supplies
  *range start points*, once, offline, reviewed by a human and
  validated against the database. It never supplies text and never
  runs at read time.
- No per-user, per-thread or per-day variation in the range. Two users
  on the same verse see the same context. This is what stops the
  feature drifting back into the rejected framing.
- Nothing about the pool is observable here. The lookup is a function
  of the verse alone, so there is no new surface to leak through.
- No duration or day-count language anywhere in this UI.

## Out of scope

- Applying pericopes to `entry_cross_refs` footnotes.
- Applying them to `topics.seed_verse_text`, which is still WEB-only
  and has no backfill path.
- Deuterocanonical books. The WEB USFX carries 86 books; the tiling
  assertion covers the 66 in `bible_books`.

## Build order

1. Generate + validate `data/pericopes.csv` in the sandbox.
2. Antonio reviews the chapter-crossing subset.
3. Migration: table, exclusion constraint, `passage_span`, RLS, tests.
4. Import script (`scripts/import-pericopes.mjs`), idempotent.
5. Client: hook, sheet, entry point, offline and gap states.
6. Device test on Internal, then promote.

## Open decisions

- Heading label: none (recommended above) vs. a neutral descriptive
  label. Defer until the sheet is on a device.
- Long pericopes: Hebrews 11 is 40 verses, some prophetic units are
  longer. Cap the rendered span with a "continue" affordance, or
  render the whole thing and let it scroll?

---

## STATUS 7 Sep 2026 — step 1 and 2 data complete

`data/pericopes.csv` — **3,068 pericopes**, generated and audited. All assertions pass:
coverage exactly 31,103 WEB verses, no gap, no overlap, every start resolves,
every book starts at 1:1, no non-Psalm unit over 40 verses.
189 units cross a chapter boundary (6.2%). Mean 10.1, median 8 verses.

Quality gate — a 16-case checklist of well-known chapter-crossing units:
**11/16 after generation, 15/16 after the boundary audit**, 16th fixed by hand.

`data/pericopes-crossing-review.csv` — the 189 crossing passages, for the
step-2 human review pass.

Two calls made during generation:
- **Psalms are exempt from the 40-verse cap.** A psalm is one literary unit;
  Psalm 78 is 72 verses. The "continue" affordance in the open decisions
  below handles the length. Psalm 119 is split into its 22 acrostic stanzas.
  Psalms 9/10 and 42/43 are arguably single poems and were left separate —
  a known judgement call.
- **`.gitignore` line 3 is `data/`.** The CSV needs a `!data/pericopes.csv`
  exception before step 3, or it will never be committed.

Generation method, for anyone regenerating: two passes of subagents over 20
book-groups. Pass 1 emitted start lists from versification bounds and produced
only 56 crossings (1.8%) — recall alone yields chapter divisions dressed as
pericopes. Pass 2 handed each agent the **actual WEB verse text** either side
of all 1,067 verse-1 starts and asked one narrow question; that produced 136
removals and 13 additions. Give the agents the text, not the question.

---

## STATUS 7 Sep 2026 — step 3 complete (migration + tests)

`supabase/migrations/20260907000003_bible_pericopes.sql`, `scripts/test-pericopes.mjs`,
`npm run test:pericopes` — **19 tests, all passing.** test:migration (14) and
test:translations (23) still pass. **Not applied to the live project yet.**

### The schema section above is superseded

That draft stored `end_chapter`/`end_verse` plus an `int4range` column and an
`exclude using gist` overlap constraint (needing `btree_gist`). All of that is
gone. **The table stores starts only** — `(book_number, start_chapter,
start_verse)` plus a generated `start_ord`. Ends are derived in the
`bible_pericope_ranges` view via `lead(start_ord) - 1`.

The reason is the same one that made "starts only" right for the CSV: with no
ends stored, an overlap is not something the database has to reject, it is
something that cannot be written down. A constraint that guards against an
unrepresentable state is dead weight, and it dragged in an extension.
**Do not reintroduce end columns.**

### The RPC is `passage_context`, not `passage_span`

It takes the **verse**, not a range: `passage_context(book_number, chapter,
verse, translation)`. The server decides the unit, so the client cannot widen,
narrow or shift the context it is shown — which is the read-time half of the
"range is a function of the verse alone" invariant. Each row carries the range
bounds as well as the verse, so the sheet header needs no second call.

Gap handling landed as planned but with the mechanism named: the **WEB is the
skeleton** and the chosen translation is LEFT JOINed onto it, so a verse absent
from that translation returns `verse_text` NULL instead of vanishing.

### Display ends need care

`end_chapter`/`end_verse` cannot be read off `end_ord`. When the next start is
verse 1 of a chapter, `end_ord` lands on verse 0 of that chapter, which is not
a real verse. The view resolves the display end as the last real WEB verse at
or below the bound — which also collapses the last-unit-in-a-book open bound to
the book's true last verse with no special case.

### Two traps for whoever does step 4

- **Migration numbering.** `20260907000001` and `...000002` were already taken
  (pool confidence floor, doctrinal themes). `ls supabase/migrations/` before
  naming one.
- **`.gitignore`.** Line 3 was `data/`. Git cannot re-include a file inside an
  ignored *directory*, so `!data/pericopes.csv` on its own did nothing. The
  line is now `data/*`; everything else in `data/` stays ignored.
- The validate trigger reads `bible_verses`, so **the WEB must be imported
  before pericopes load**. `npm run setup` already orders it that way.

---

## STATUS 7 Sep 2026 — step 4 complete (import script)

`scripts/import-pericopes.mjs`, `npm run import:pericopes`. Added to `setup`,
which is now `import:bibles && import:pericopes && seed` — the order matters,
because the validate trigger checks every start against the WEB.

Idempotent (skips when rows exist, `--force` clears first). Refuses a load
under 2,500 rows rather than leaving a partial tiling in place.

Shape assertions run before anything touches the database — complete 66-book
coverage, strictly increasing starts per book, first start of every book
exactly 1:1. Dry-run against the real CSV passes at 3,068 rows, and the three
negative cases (missing Genesis 1:1, a whole book absent, a duplicated start)
each fail with a message naming the book.

Two post-insert checks, both through the RPCs rather than raw selects:
- **1 Cor 13:4 must resolve to the unit starting at 12:31.** If it comes back
  starting at 13:1, the table is chapter divisions wearing a pericope table's
  name, and the import fails loudly.
- **`pericope_coverage_gaps()`** — new in the migration. Every WEB verse must
  fall in exactly one unit. Zero rows is healthy; it exists to catch a partial
  load, which a row count alone cannot. Full scan, setup-time only, never
  called from a client.

Test count is now 21 (was 19), covering both coverage-gap cases.

Remaining: step 2 (Antonio's review of the 189 crossings), step 5 (client
sheet), step 6 (device test). The migration is still **not applied** to the
live project.

---

## STATUS 7 Sep 2026 — step 5 complete (client)

`tsc --noEmit` clean. Files:

- `src/lib/types.ts` — `PassageContextRow`.
- `src/lib/api.ts` — `fetchPassageContext(coords, translation)`. Takes the
  verse, not a range, so the client cannot narrow its own context.
- `src/lib/passageContext.ts` — `usePassageContext(entry, code, enabled)`,
  its own localStorage cache (`ponder.context.v1`, limit **30** — a context
  read is 10-20 verses where a hero is 1-2, so the passage cache's 120 would
  be an order of magnitude more storage), plus `bookLabel()` and
  `rangeLabel()`.
- `src/components/PassageContextSheet.tsx` — the sheet.
- `src/components/EntryCard.tsx` — "Read the full context" under the
  reference, above the version tabs; sheet state resets on entry change.

Decisions taken while building, beyond what the spec above settled:

- **The affordance sits above the version tabs**, not below. It is about the
  passage; the tabs are about which wording of it.
- **Verses render as continuous prose with small verse numbers**, not one
  line per verse. Verse-per-line is a study-Bible convention that makes a
  paragraph look like a list of separate claims — the reading habit this
  feature is trying to loosen. A chapter number appears inline only where the
  unit actually crosses a break, so the reader can see that it did.
- **Fetch is gated on `open`.** The card costs nothing until the reader asks.
- **The open decision on long passages is resolved as: render it all, scroll
  the sheet.** `max-h-[85vh]` with the header and Close button pinned. No
  "continue" affordance — a cap would need a rule for where to cut, and the
  only honest cut is the one the pericope already makes. Revisit on device if
  Psalm 78 (72 verses) reads badly.
- **No heading label**, as specced — reference only.

### Pre-existing issues found, NOT fixed here

- **`clearPassageCache()` is exported and never called**, despite its comment
  saying it runs on sign-out. Sign-out leaves cached passage text on the
  device. `clearContextCache()` has the same shape and the same gap; both
  should be wired into `signOutAndFlagForRestore()` together. Left alone
  because it touches auth.
- **`npm run build` cannot run in the Cowork Linux VM.** `node_modules`
  carries `@rollup/rollup-darwin-arm64`, so `vite build` dies with
  MODULE_NOT_FOUND on the native binary. `tsc --noEmit` runs fine. Build on
  the Mac directly.
