# Book threads: Phase 3 report

Built on the feature branch `feature/book-threads`. **Nothing is live.** The live
database and the live functions haven't been touched. Everything was tested on a
private copy of the database on your Mac (structure plus Bible text only, no user
data).

## Final check output

```
PASS  deno check generate-entry
PASS  deno check synthesize
PASS  content checker, loop, pacing tests      (28 tests)
PASS  Phase 1 samples still clean              (8 of 8)
PASS  database + old-build queries             (27 of 27, incl. every query in 1.0.20 and 1.0.21)
PASS  end to end on the local copy             (16 steps)
PASS  app type check and build
```

Re-run any time with `bash scripts/book-threads-checks.sh` (the database and
end-to-end steps need the private copy: `bash scripts/localdb-setup.sh`).

**Proof the checks aren't toothless.** Each set was fed deliberate bugs and caught
them all:
- 4 bugs in pacing
- 5 in the writer loop (this exposed one missing test, which I added)
- 5 harmful database changes, including a repeat of the 25 Aug column-permission
  outage, a leaked content library, an exposed writer job, and a missing owner check
- 3 bugs in the server code (no carry-forward, book threads falling into the
  question path, Bible text replaced by the writer's text)

## Real problems the checks found along the way

1. **The checker wrongly blocked Philippians 1:5.** The passage itself says "from
   the first day until now". The real writer job refused to save the reading, which
   is correct behaviour, but the rule was wrong. Fixed with a test: phrases the
   passage itself uses are allowed.
2. **The end-of-book reflection said "about 1 weeks of reading" and "the whole
   journey".** For book threads it now gets no timeline and an explicit rule. Two
   reruns came out clean. The one remaining "years" is Naomi's ten years in the story
   itself.
3. **The sources footnote named only the key verse** (Ruth 4:13) on a card showing
   Ruth 4:13–22. It now names the whole section.

## Screenshots (folder `screens/`)

1. Add a thread: "A question" or "A book"
2. Book picker: 5 starters with descriptions and section counts, then all 66
3. A book day: progress line and bar, the whole section, key verse highlighted
4. The key verse below it, with Read slowly and Context. Translation tabs switch the
   whole section too.
5. The end of the book, leading into the existing look-back-and-close flow
6. A question thread, unchanged (still has Full passage, no progress line)
7. **The real 1.0.20 app** showing a book day as a normal entry

Screens 3–5 use stand-in writing on the private copy (the Ruth sample repeated for
each section), so the words there don't match each passage. The real writer job was
tested separately: it wrote, checked and saved Philippians 1:3–11 by itself on its
first attempt, including the Read slowly phrases.

## What changes in the live function when you approve

- `generate-entry` live (version 42) matches the repo's starting point exactly. I
  checked again just now.
- Of its existing code, 5 lines change: the thread columns it reads (adds
  `book_number`), two progress-report lines, the accepted request types, and the
  price assumed for an unknown model (raised to match Opus). Everything else is new
  code, reached only by book threads or the new writer job.
- `synthesize`: reads `book_number` and adds the book wording. Question threads get
  exactly the same prompt as before.
- ⚠️ **Order matters:** both functions now read the new `book_number` column, so the
  database change must be applied first. Deploying a function first would break the
  nightly entries for everyone.

## Checks can't judge these (yours)

- Wording: the 5 book descriptions, "Reading through the book" on the Threads list,
  and the end panel ("That's the end of Ruth… Look back and close").
- Theology and tone of the real writing across many books. Phase 1 covered 8
  samples, and the 66 first sections will be new.
- The look on a real phone. I checked a phone-sized browser, not the iOS or Android
  app.
- One known limitation (as planned): someone who only ever opens a book thread on
  an old app version stays on the same section.

## Money spent in testing

Roughly $2–4 of Claude usage: the Phase 1 rounds, one real writer-job run and a few
reflection runs.

## Next steps, in order (each needs your yes)

1. Apply the database change to the live database
2. Deploy `generate-entry` and `synthesize` (after a fresh live diff and deno check)
3. Pre-write the first section of all 66 books (about $10–20, done by the 5-minute job)
4. Build the app (1.0.22) for the stores
