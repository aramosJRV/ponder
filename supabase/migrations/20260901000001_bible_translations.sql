-- ============================================================
-- Bible translations — WEB (existing) + BSB + KJV
--
-- Why only these three: every other translation a reader would ask for
-- (NIV, ESV, NLT, NASB, CSB, The Message) is copyright-protected and
-- cannot be stored in a table, copied into daily_entries.verse_text,
-- shared through entry_pool or embedded in a local notification payload
-- without a commercial licence. WEB, BSB and KJV are public domain, so
-- they can go through the existing pipeline unchanged.
--
-- THE TRAP THIS MIGRATION EXISTS TO CLOSE:
-- three functions read bible_verses with no translation filter —
-- resolve_verse_ref(), parse_verse_ref() and resolve_topic_seed_verse().
-- The moment a second translation lands, each one sees three rows where
-- it expects one. resolve_verse_ref() would return the same verse three
-- times; the other two count rows against the span length and would
-- start rejecting every valid reference. Loading the data WITHOUT this
-- migration silently breaks entry generation and new-thread creation.
-- Every read of bible_verses from here on must name a translation.
--
-- Column adds only. No REVOKE, no column-level grant, no dropped column
-- on a client-read table — see the 25 Aug 2026 outage.
-- ============================================================

-- ------------------------------------------------------------
-- bible_translations — the catalogue the picker is built from
-- ------------------------------------------------------------
create table public.bible_translations (
  code        text primary key,          -- 'WEB' — also the tab label
  name        text not null,             -- 'World English Bible'
  blurb       text not null,             -- one line under the name in Settings
  sort_order  smallint not null unique   -- tab order, left to right
);

insert into public.bible_translations (code, name, blurb, sort_order) values
  ('WEB', 'World English Bible',   'Modern English, public domain', 1),
  ('BSB', 'Berean Standard Bible', 'Plainest modern reading',       2),
  ('KJV', 'King James Version',    '1611, traditional English',     3);

alter table public.bible_translations enable row level security;

create policy "bible_translations_read" on public.bible_translations
  for select to authenticated using (true);

-- ------------------------------------------------------------
-- bible_verses gains a translation axis
--
-- Existing rows are the WEB, so the default backfills them correctly and
-- the column can be NOT NULL from the start.
-- ------------------------------------------------------------
alter table public.bible_verses
  add column translation text not null default 'WEB'
    references public.bible_translations (code);

-- The old uniqueness rule ("one row per verse") is now wrong: it is one
-- row per verse PER TRANSLATION.
alter table public.bible_verses
  drop constraint bible_verses_book_number_chapter_verse_key;

alter table public.bible_verses
  add constraint bible_verses_translation_book_chapter_verse_key
    unique (translation, book_number, chapter, verse);

-- Same for the lookup index — translation is the leading column because
-- every query filters on it.
drop index if exists public.bible_verses_lookup_idx;
create index bible_verses_lookup_idx
  on public.bible_verses (translation, book_number, chapter, verse);

comment on column public.bible_verses.translation is
  'Public-domain translation code. Every read of this table must filter '
  'on it — an unfiltered read now returns one row per translation.';

-- ------------------------------------------------------------
-- profiles.translation — the reader's standing preference
--
-- Per-passage switching in the entry card is a reading gesture and does
-- NOT write here. This is what new entries and the notification body are
-- rendered in, so that what the notification says and what the screen
-- says cannot disagree.
-- ------------------------------------------------------------
alter table public.profiles
  add column translation text not null default 'WEB'
    references public.bible_translations (code);

-- ------------------------------------------------------------
-- resolve_verse_ref — now translation-aware.
--
-- Dropped and recreated rather than overloaded: adding a defaulted 5th
-- parameter alongside the 4-parameter original makes every existing
-- 4-argument call ambiguous ("function is not unique"), which would
-- break generate-entry, seed.mjs and seed-screenshots.mjs at once.
-- With the old signature gone, those callers keep working untouched and
-- get WEB from the default.
-- ------------------------------------------------------------
drop function if exists public.resolve_verse_ref(text, int, int, int);

create function public.resolve_verse_ref(
  p_book        text,
  p_chapter     int,
  p_verse_start int,
  p_verse_end   int default null,
  p_translation text default 'WEB'
)
returns table (
  book_number smallint,
  book text,
  chapter smallint,
  verse smallint,
  text text
)
language sql
stable
as $$
  select v.book_number, v.book, v.chapter, v.verse, v.text
  from public.bible_verses v
  join public.bible_books b on b.book_number = v.book_number
  where v.translation = coalesce(p_translation, 'WEB')
    and (lower(trim(p_book)) = lower(b.name)
         or lower(trim(p_book)) = any (b.aliases))
    and v.chapter = p_chapter
    and v.verse between p_verse_start and coalesce(p_verse_end, p_verse_start)
  order by v.verse;
$$;

-- ------------------------------------------------------------
-- parse_verse_ref — same treatment. The New Thread form validates a
-- typed reference against the reader's translation, so a reference that
-- exists only in one versification cannot be typed in and then fail to
-- render later.
-- ------------------------------------------------------------
drop function if exists public.parse_verse_ref(text);

create function public.parse_verse_ref(
  p_ref text,
  p_translation text default 'WEB'
)
returns table (
  book_number smallint,
  book        text,
  chapter     smallint,
  verse_start smallint,
  verse_end   smallint,
  verse_ref   text,
  verse_text  text
)
language plpgsql
stable
as $$
declare
  m           text[];
  v_book_in   text;
  v_chapter   int;
  v_start     int;
  v_end       int;
  v_book_num  smallint;
  v_book_name text;
  v_text      text;
  v_count     int;
  v_tr        text := coalesce(p_translation, 'WEB');
begin
  if p_ref is null or btrim(p_ref) = '' then
    return;
  end if;

  m := regexp_match(
    btrim(p_ref),
    '^(.+?)\s+(\d{1,3})\s*[:.]\s*(\d{1,3})\s*(?:[-–—]\s*(\d{1,3}))?\.?$'
  );
  if m is null then
    return;
  end if;

  v_book_in := btrim(m[1]);
  v_chapter := m[2]::int;
  v_start   := m[3]::int;
  v_end     := coalesce(m[4]::int, v_start);

  if v_end < v_start or v_end - v_start > 9 then
    return;
  end if;

  select b.book_number, b.name
    into v_book_num, v_book_name
  from public.bible_books b
  where lower(v_book_in) = lower(b.name)
     or lower(v_book_in) = any (b.aliases)
     or lower(regexp_replace(v_book_in, '[\.\s]', '', 'g'))
        = lower(regexp_replace(b.name, '[\.\s]', '', 'g'))
  limit 1;

  if v_book_num is null then
    return;
  end if;

  select string_agg(v.text, ' ' order by v.verse), count(*)
    into v_text, v_count
  from public.bible_verses v
  where v.translation = v_tr
    and v.book_number = v_book_num
    and v.chapter = v_chapter
    and v.verse between v_start and v_end;

  if v_count is null or v_count <> (v_end - v_start + 1) then
    return;
  end if;

  return query select
    v_book_num,
    v_book_name,
    v_chapter::smallint,
    v_start::smallint,
    v_end::smallint,
    public.display_verse_ref(v_book_name, v_chapter, v_start, v_end),
    v_text;
end;
$$;

-- ------------------------------------------------------------
-- resolve_topic_seed_verse — pinned to the WEB.
--
-- topics.seed_verse_text is written once, at insert, and displayed from
-- the row forever. Making it follow a preference the reader can change
-- later would leave every existing thread showing text from a
-- translation the reader has since abandoned, with no backfill path.
-- The seed passage stays WEB until it gets the same re-resolve treatment
-- the entry card now has.
-- ------------------------------------------------------------
create or replace function public.resolve_topic_seed_verse()
returns trigger
language plpgsql
security definer set search_path = public
as $$
declare
  v_book  text;
  v_text  text;
  v_count int;
begin
  if new.seed_book_number is null then
    new.seed_verse_ref  := null;
    new.seed_verse_text := null;
    return new;
  end if;

  select b.name into v_book
  from public.bible_books b
  where b.book_number = new.seed_book_number;

  select string_agg(v.text, ' ' order by v.verse), count(*)
    into v_text, v_count
  from public.bible_verses v
  where v.translation = 'WEB'
    and v.book_number = new.seed_book_number
    and v.chapter = new.seed_chapter
    and v.verse between new.seed_verse_start and new.seed_verse_end;

  if v_count is null
     or v_count <> (new.seed_verse_end - new.seed_verse_start + 1) then
    raise exception 'Seed verse % %:%-% does not resolve in the World English Bible',
      v_book, new.seed_chapter, new.seed_verse_start, new.seed_verse_end;
  end if;

  new.seed_verse_ref := public.display_verse_ref(
    v_book, new.seed_chapter, new.seed_verse_start, new.seed_verse_end
  );
  new.seed_verse_text := v_text;
  return new;
end;
$$;

-- ------------------------------------------------------------
-- passage_text — what the entry card calls when a tab is tapped.
--
-- Takes coordinates, not a reference string: daily_entries already
-- stores book_number/chapter/verse_start/verse_end, so there is nothing
-- to re-parse and no way for a display string to drift from what is
-- fetched.
--
-- Returns NULL — not a partial passage — when the span is not fully
-- present in that translation. Three references in the WEB have no KJV
-- row at all (Romans 14:24-26, which the KJV versifies as 16:25-27) and
-- fifteen have no BSB row (the textual-critical omissions: Matthew
-- 17:21, Mark 9:44, John 5:4 and the rest). A half-rendered passage
-- would be worse than an honest "not in this translation", so the
-- caller gets NULL and says so.
--
-- Not SECURITY DEFINER: it runs as the caller, so bible_verses RLS
-- still applies and an anonymous session gets nothing.
-- ------------------------------------------------------------
create or replace function public.passage_text(
  p_book_number int,
  p_chapter     int,
  p_verse_start int,
  p_verse_end   int,
  p_translation text
)
returns text
language sql
stable
as $$
  select case
           when count(*) = (p_verse_end - p_verse_start + 1)
             then string_agg(v.text, ' ' order by v.verse)
           else null
         end
  from public.bible_verses v
  where v.translation = p_translation
    and v.book_number = p_book_number
    and v.chapter = p_chapter
    and v.verse between p_verse_start and p_verse_end;
$$;

comment on function public.passage_text(int, int, int, int, text) is
  'Full text of a passage in one translation, or NULL when the span is '
  'not completely present in it. Backs the version tabs on the entry card.';

-- PostgREST caches the schema. Without this it keeps serving the old shape
-- and the client gets "column profiles.translation does not exist" /
-- "function passage_text does not exist" until something else nudges it.
notify pgrst, 'reload schema';
