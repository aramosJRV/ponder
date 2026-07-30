-- ============================================================
-- Topic seed verse — the passage that triggered the pondering.
--
-- Optional. Stored structurally (book_number/chapter/start/end)
-- plus denormalized ref + text for offline display.
--
-- Invariant preserved from the rest of the app: verse TEXT is never
-- accepted from the client. A BEFORE INSERT/UPDATE trigger resolves
-- seed_verse_ref and seed_verse_text from bible_verses and overwrites
-- whatever the client sent. Clients only supply the coordinates.
-- ============================================================

alter table public.topics
  add column seed_book_number smallint references public.bible_books (book_number),
  add column seed_chapter     smallint,
  add column seed_verse_start smallint,
  add column seed_verse_end   smallint,
  add column seed_verse_ref   text,
  add column seed_verse_text  text;

-- all-or-nothing: either there is no seed verse, or it is fully specified
alter table public.topics
  add constraint topics_seed_verse_complete check (
    (seed_book_number is null
      and seed_chapter is null
      and seed_verse_start is null
      and seed_verse_end is null)
    or
    (seed_book_number is not null
      and seed_chapter is not null
      and seed_verse_start is not null
      and seed_verse_end is not null
      and seed_chapter > 0
      and seed_verse_start > 0
      and seed_verse_end >= seed_verse_start
      -- keep the seed passage a passage, not a chapter dump
      and seed_verse_end - seed_verse_start <= 9)
  );

-- ------------------------------------------------------------
-- display_verse_ref — matches the edge function's displayRef()
-- ("Psalms" is the WEB book name; "Psalm" is the display form).
-- ------------------------------------------------------------
create or replace function public.display_verse_ref(
  p_book text, p_chapter int, p_start int, p_end int
)
returns text
language sql
immutable
as $$
  select case when p_book = 'Psalms' then 'Psalm' else p_book end
      || ' ' || p_chapter || ':' || p_start
      || case when p_end > p_start then '-' || p_end else '' end;
$$;

-- ------------------------------------------------------------
-- parse_verse_ref — single source of truth for turning a typed
-- human reference ("1 Corinthians 13:4-7") into coordinates.
-- Used by the client for live validation on the New Topic form.
-- Returns zero rows when the reference is unparseable or does not
-- resolve in the World English Bible.
-- ------------------------------------------------------------
create or replace function public.parse_verse_ref(p_ref text)
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
begin
  if p_ref is null or btrim(p_ref) = '' then
    return;
  end if;

  -- "<book> <chapter>:<verse>[-<verse>]"  (also accepts '.' as the
  -- chapter/verse separator and en/em dashes in the range)
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
     -- tolerate "1st Corinthians", "1Cor", trailing periods
     or lower(regexp_replace(v_book_in, '[\.\s]', '', 'g'))
        = lower(regexp_replace(b.name, '[\.\s]', '', 'g'))
  limit 1;

  if v_book_num is null then
    return;
  end if;

  select string_agg(v.text, ' ' order by v.verse), count(*)
    into v_text, v_count
  from public.bible_verses v
  where v.book_number = v_book_num
    and v.chapter = v_chapter
    and v.verse between v_start and v_end;

  -- require the whole span to exist
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
-- Trigger: resolve seed verse text server-side, always.
-- The client sends coordinates; ref and text are derived here so a
-- crafted insert cannot put arbitrary prose into seed_verse_text.
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
  where v.book_number = new.seed_book_number
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

-- Fires before the existing concluded-topic guard (alphabetical order:
-- topics_guard_concluded < topics_resolve_seed) only on UPDATE; on INSERT
-- the guard does not apply. Either order is safe — the guard raises on
-- concluded topics regardless.
create trigger topics_resolve_seed
  before insert or update on public.topics
  for each row execute function public.resolve_topic_seed_verse();

comment on column public.topics.seed_verse_text is
  'World English Bible text for the seed passage. Written by the '
  'resolve_topic_seed_verse() trigger only — never trusted from the client.';
