-- ============================================================
-- bible_pericopes — "Read the full context"
--
-- The entry card shows one or two verses. This table is what lets it
-- offer the surrounding literary unit instead of "read the full
-- chapter" — including where that unit crosses a chapter break, which
-- chapter divisions (a 13th-century addition) routinely cut in half:
-- Genesis 1:1-2:3, Isaiah 52:13-53:12, John 7:53-8:11,
-- 1 Corinthians 12:31-13:13, Hebrews 11:1-12:2.
--
-- WHAT THIS IS NOT: context selected for relevance to the reader's
-- thread. That was considered and rejected — filtering context by
-- topical relevance is proof-texting with extra steps, and it would
-- trim exactly the verses that challenge the reader's framing. Psalm
-- 46:10 sits in a psalm about God ending wars and shattering spears.
-- The range here is a function of the VERSE ALONE: every reader on a
-- given verse sees the same context, on every thread, every day. If a
-- future change makes the range depend on the user, the thread or the
-- date, it has broken the feature's reason for existing.
--
-- Table adds only. No REVOKE, no column-level grant — see the 25 Aug
-- outage, where revoking select on a column 403'd every installed
-- client doing `select *`.
-- ============================================================

-- ------------------------------------------------------------
-- Starts only. Ends are DERIVED.
--
-- A pericope runs from its start to the verse before the next start;
-- the last in a book runs to the end of the book. Because only starts
-- are stored, a gap, an overlap, or a range running off the end of a
-- book are all UNREPRESENTABLE. There is no overlap constraint here
-- because there is nothing that could overlap.
--
-- start_ord collapses (chapter, verse) into one orderable integer.
-- The multiplier is safe: the longest chapter in scripture is Psalm
-- 119 at 176 verses.
-- ------------------------------------------------------------
create table public.bible_pericopes (
  book_number   smallint not null references public.bible_books (book_number),
  start_chapter smallint not null check (start_chapter >= 1),
  start_verse   smallint not null check (start_verse   >= 1),
  start_ord     int generated always as
                  (start_chapter::int * 1000 + start_verse) stored,
  primary key (book_number, start_chapter, start_verse)
);

comment on table public.bible_pericopes is
  'Literary-unit start points, one row per pericope. Ends are derived '
  'from the next start, so gaps and overlaps cannot be represented. '
  'Ranges are defined on WEB versification and applied to every '
  'translation. Never varies by user, thread or date.';

-- Every start must resolve to a real verse. Enforced by the database
-- rather than only by the import script, so a hand-edited row cannot
-- introduce a range that points at nothing.
--
-- ORDER DEPENDENCY: this reads bible_verses, so the WEB must be
-- imported before pericopes are loaded. `npm run setup` already does
-- bibles first.
create or replace function public.validate_pericope_start()
returns trigger
language plpgsql
as $$
begin
  if not exists (
    select 1 from public.bible_verses v
    where v.translation = 'WEB'
      and v.book_number = new.book_number
      and v.chapter     = new.start_chapter
      and v.verse       = new.start_verse
  ) then
    raise exception
      'pericope start book % %:% does not resolve to a WEB verse',
      new.book_number, new.start_chapter, new.start_verse;
  end if;
  return new;
end;
$$;

create trigger bible_pericopes_validate_start
  before insert or update on public.bible_pericopes
  for each row execute function public.validate_pericope_start();

-- ------------------------------------------------------------
-- The derived ranges.
--
-- end_ord is the next start minus one. For the last pericope in a book
-- there is no next start, so the bound is left open at int4 max — it is
-- only ever intersected with real verses, so an over-wide upper bound
-- costs nothing and removes a special case.
--
-- end_chapter/end_verse are for DISPLAY ("Psalm 46:1-11"). They cannot
-- be read off end_ord directly: when the next start is verse 1 of a
-- chapter, end_ord lands on verse 0 of that chapter, which is not a
-- real verse. So the display end is the last WEB verse at or below the
-- bound — which also resolves the open upper bound to the book's last
-- verse with no extra branch.
--
-- security_invoker so bible_verses RLS still applies to the caller.
-- ------------------------------------------------------------
create or replace view public.bible_pericope_ranges
with (security_invoker = true) as
with bounds as (
  select
    p.book_number,
    p.start_chapter,
    p.start_verse,
    p.start_ord,
    coalesce(
      lead(p.start_ord) over (partition by p.book_number order by p.start_ord) - 1,
      2147483647
    ) as end_ord
  from public.bible_pericopes p
)
select
  b.book_number,
  b.start_chapter,
  b.start_verse,
  b.start_ord,
  b.end_ord,
  (e.ord / 1000)::smallint as end_chapter,
  (e.ord % 1000)::smallint as end_verse
from bounds b
cross join lateral (
  select max(v.chapter::int * 1000 + v.verse) as ord
  from public.bible_verses v
  where v.translation = 'WEB'
    and v.book_number = b.book_number
    and (v.chapter::int * 1000 + v.verse) <= b.end_ord
) e;

comment on view public.bible_pericope_ranges is
  'bible_pericopes with ends derived from the following start. '
  'end_chapter/end_verse are the display bounds; start_ord/end_ord are '
  'what verse lookups compare against.';

-- The containing unit for one verse. Total by construction: every verse
-- in every book falls inside exactly one pericope, so this never
-- returns zero rows for a valid reference.
create or replace function public.pericope_for(
  p_book_number int,
  p_chapter     int,
  p_verse       int
)
returns table (
  start_chapter smallint,
  start_verse   smallint,
  end_chapter   smallint,
  end_verse     smallint,
  start_ord     int,
  end_ord       int
)
language sql
stable
as $$
  select r.start_chapter, r.start_verse, r.end_chapter, r.end_verse,
         r.start_ord, r.end_ord
  from public.bible_pericope_ranges r
  where r.book_number = p_book_number
    and (p_chapter * 1000 + p_verse) between r.start_ord and r.end_ord
  limit 1;
$$;

comment on function public.pericope_for(int, int, int) is
  'The literary unit containing one verse. Range only, no text.';

-- ------------------------------------------------------------
-- passage_context — what the "Read the full context" sheet calls.
--
-- Takes the verse, not a range: the client passes the coordinates
-- daily_entries already stores and the server decides the unit, so the
-- client cannot widen, narrow or shift the context it is shown.
--
-- Returns ROWS, not a joined string. This is the deliberate difference
-- from passage_text(), which returns NULL for the whole span when any
-- verse is missing from a translation. That rule is right for a
-- one-verse hero and wrong here: a single absent KJV verse would blank
-- a fifteen-verse context. Instead the WEB skeleton is the spine and
-- the chosen translation is LEFT JOINed onto it, so a verse missing
-- from that translation comes back with verse_text NULL and the client
-- marks the gap inline rather than silently dropping it.
--
-- Real gaps this hits: Romans 14:24-26 has no KJV row (the KJV
-- versifies that doxology at 16:25-27), and fifteen references have no
-- BSB row — the textual-critical omissions (Matthew 17:21, Mark 9:44,
-- John 5:4, Acts 8:37 and the rest).
--
-- Not SECURITY DEFINER: it runs as the caller, so bible_verses RLS
-- still applies and an unauthenticated session gets nothing.
-- ------------------------------------------------------------
create or replace function public.passage_context(
  p_book_number int,
  p_chapter     int,
  p_verse       int,
  p_translation text
)
returns table (
  start_chapter smallint,
  start_verse   smallint,
  end_chapter   smallint,
  end_verse     smallint,
  chapter       smallint,
  verse         smallint,
  verse_text    text
)
language sql
stable
as $$
  select r.start_chapter, r.start_verse, r.end_chapter, r.end_verse,
         w.chapter, w.verse, t.text
  from public.pericope_for(p_book_number, p_chapter, p_verse) r
  join public.bible_verses w
    on  w.translation = 'WEB'
    and w.book_number = p_book_number
    and (w.chapter::int * 1000 + w.verse) between r.start_ord and r.end_ord
  left join public.bible_verses t
    on  t.translation = p_translation
    and t.book_number = w.book_number
    and t.chapter     = w.chapter
    and t.verse       = w.verse
  order by w.chapter, w.verse;
$$;

comment on function public.passage_context(int, int, int, text) is
  'The full literary unit around a verse, one row per verse, WEB as the '
  'skeleton. verse_text NULL means that verse is absent from the '
  'requested translation — show the gap, do not hide it.';

-- ------------------------------------------------------------
-- pericope_coverage_gaps — the tiling assertion, as a query.
--
-- Every WEB verse must fall inside exactly one pericope. That is true by
-- construction of the starts-only design, so this returns zero rows on a
-- healthy table; it exists to catch a PARTIAL LOAD, which a row count
-- alone will not. scripts/import-pericopes.mjs calls it after inserting.
--
-- Full scan of the WEB (~31k rows) with a lateral per verse. Slow on
-- purpose and only ever run at setup — do not call it from the client.
-- ------------------------------------------------------------
create or replace function public.pericope_coverage_gaps()
returns table (
  book_number smallint,
  chapter     smallint,
  verse       smallint,
  hits        bigint
)
language sql
stable
as $$
  select v.book_number, v.chapter, v.verse, count(p.*) as hits
  from public.bible_verses v
  left join lateral public.pericope_for(v.book_number, v.chapter, v.verse) p on true
  where v.translation = 'WEB'
  group by v.book_number, v.chapter, v.verse
  having count(p.*) <> 1
$$;

comment on function public.pericope_coverage_gaps() is
  'Verses not covered by exactly one pericope. Zero rows is healthy. '
  'Setup-time assertion against a partial load; never call it from a client.';

-- Ordinal lookups scan a range of (chapter, verse) pairs, which the
-- existing (translation, book_number, chapter, verse) index cannot
-- serve as one contiguous read once a range crosses a chapter.
create index bible_verses_ord_idx
  on public.bible_verses (translation, book_number, ((chapter::int * 1000 + verse)));

-- ------------------------------------------------------------
-- RLS — same posture as the rest of the bible reference data:
-- readable by any signed-in user, no client writes.
-- ------------------------------------------------------------
alter table public.bible_pericopes enable row level security;

create policy "bible_pericopes_read" on public.bible_pericopes
  for select to authenticated using (true);

-- PostgREST caches the schema. Without this it keeps serving the old
-- shape and the client gets "function passage_context does not exist".
notify pgrst, 'reload schema';
