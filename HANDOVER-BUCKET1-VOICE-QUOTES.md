# Ponder — Bucket 1: public-domain author quotes

Handover written 16 Sep 2026. Verify claims against the repo and Supabase before acting.

## What this is

Add a real, verbatim quote from a public-domain Christian author to some daily entries,
with attribution. It is ONE HALF of a two-part design:

- **Bucket 1 (this doc):** public-domain authors only. Quotes live in Postgres, the model
  emits an ID, the server resolves the text. Reader sees author + work.
- **Bucket 2 (DONE, shipped 16 Sep):** modern in-copyright authors (Keller, Piper, Willard)
  shape posture only. Never named, never quoted. Lives in `SYSTEM_PROMPT` in
  `supabase/functions/generate-entry/index.ts`. Nothing further to do.

## The non-negotiable rule

The model NEVER writes quote text. It returns `quote_id` only. The server looks it up and
pastes real text. An invalid or missing id means NO QUOTE and the entry ships without one.
This is the same pattern already used for `verse_ref` (resolved against `bible_verses`) and
`song` (resolved against Spotify). Breaking it produces fabricated quotes attributed to real
people, which is the failure this whole design exists to prevent.

## Decisions locked (do not relitigate)

| Decision | Value |
|---|---|
| Placement | Its own field on the entry card, rendered AFTER `ponder`. NOT inside `thought` or `illustration` — that would make the model write the quote text. |
| Frequency | 1 in 5 entries |
| Who decides | SERVER-SIDE roll BEFORE the Claude call, same pattern as the existing ~25% challenge weighting. Candidate quotes go into the prompt only when the roll says yes, so the model never reaches for a quote just because it was offered one. |
| Omission | "No quote" is always valid and costs nothing — same rule as `song`. |
| Source | Christian Classics Ethereal Library plain-text editions, all public domain |

## The content

`voices/candidates-2026-09-15.md` and `.json` — **213 quotes, reviewed and approved by
Antonio 16 Sep.** Verbatim from source files, not written by any model.

| Author | Work | Quotes |
|---|---|---|
| Thomas Watson | A Body of Divinity (1692) | 48 |
| Charles Spurgeon | Morning and Evening (1865) | 46 |
| Samuel Rutherford | Letters (1664) | 33 |
| William Law | A Serious Call (1729) | 25 |
| Andrew Murray | With Christ in the School of Prayer (1885) | 23 |
| Charles Spurgeon | All of Grace (1886) | 21 |
| Jonathan Edwards | Religious Affections (1746) | 17 |

Bunyan was dropped — Pilgrim's Progress is narrative and yields no standalone lines.
Richard Sibbes is not on CCEL at all.
Two denominational-polemic lines were cut to match generation guardrail 4.

## Proposed schema (NOT yet written)

```sql
create table public.voices (
  id uuid primary key default gen_random_uuid(),
  name text not null,              -- "Thomas Watson"
  died smallint not null,          -- 1686
  work_title text not null,        -- "A Body of Divinity"
  work_year smallint not null,
  pd_basis text not null,          -- why it is public domain in AU
  active boolean not null default true
);

create table public.voice_quotes (
  id uuid primary key default gen_random_uuid(),
  voice_id uuid not null references public.voices (id) on delete cascade,
  text text not null,              -- VERBATIM, never edited
  citation text,                   -- chapter/page; NOT captured yet
  theme_tags text[] not null default '{}',
  reviewed boolean not null default true,
  retired boolean not null default false,
  created_at timestamptz not null default now()
);
```

**RLS/grants warning:** on 25 Aug 2026 a column-level REVOKE on `topics` broke every
already-installed build. New tables are safe; do NOT touch grants on existing tables.
If the client must read `voice_quotes`, add a read policy deliberately. Antonio's hard rule:
schema changes go through a migration, never the dashboard, and he approves first.

## Work remaining

1. Migration for the two tables above
2. Load the 213 quotes (seed script from the .json)
3. **Theme-tag every quote** against the ~40 rows in `entry_themes` — this is the real work
4. Citations — only book + year captured; chapter/page needs a second extraction pass
5. `generate-entry/index.ts`: server-side 1-in-5 roll; inject theme-matched candidate ids
   into the prompt; add `quote_id` to the tool schema; resolve server-side; drop silently
   on a bad id. Add `used_quote_refs` tracking alongside `used_verse_refs` or the same
   quote recurs every fortnight.
6. Pool builder (`mode:"pool_build"`) must resolve quotes too, or pooled entries will have
   `quote = null` — the same gap that already exists for `song`. Fix both together.
7. EntryCard: render the quote block after `ponder`. Check `ponder-content-level` — the
   Brief/Fuller/Full setting FOLDS content, never hides it.
8. Decide: quotes on both entry types, or only one? UNRESOLVED.

## Environment gotchas

- **Do NOT run git** in the mounted repo from the Cowork sandbox — leaves a stuck `index.lock`.
- The sandbox and the Cowork VM shell are both **egress-blocked from gutenberg.org**.
  CCEL is reachable only via the built-in browser (`Claude_Browser__javascript_tool`,
  `fetch()` from a page already on the ccel.org origin).
- CCEL plaintext URL pattern: `https://www.ccel.org/ccel/<letter>/<author>/<work>/cache/<work>.txt`
- `supabase` CLI is NOT in the sandbox and `api.supabase.com` is blocked. Antonio deploys.
- `tsc --noEmit` works in the sandbox; `vite build` does not.

## Production state as of 16 Sep 2026

- Bucket 2 posture change is LIVE, shipped inside commit 26bd2f9 whose message does not
  mention it. That commit is deployed but **NOT merged to main** (main is at 80a3538) —
  a later deploy from main silently reverts it.
- Unserved CHALLENGE pool entries were retired 16 Sep so they rebuild under the new posture.
  Affirming left alone (~1383 live).
- pg_cron: `promptings-daily-generation` is `0 * * * *` (HOURLY, despite the name),
  `ponder-pool-topup` `35 * * * *`, `ponder-batch-collect` `*/10 * * * *`.
- Pool cost measured: **1.25 US cents per generated entry** (2182 entries / US$27.23).
