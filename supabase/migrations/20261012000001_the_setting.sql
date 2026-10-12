-- ============================================================
-- "The setting" — historical background for the day's verse.
--
-- Two layers, both written offline (scripts/setting-draft.ts), reviewed
-- by a person, and loaded by a separate content migration:
--
--   bible_book_settings      one row per book: who wrote it, who first
--                            heard it, what was happening.
--   bible_pericope_settings  an optional one-line note for a passage,
--                            keyed to its bible_pericopes start. Most
--                            passages have none, on purpose.
--
-- Like passage_context, the setting is a function of the VERSE ALONE:
-- every reader on a verse sees the same setting, on every thread, every
-- day. It is background, never a reading of what the verse means.
--
-- Additive only. New tables and a new function; no shipped client reads
-- any of it, so older builds are unaffected.
-- ============================================================

create table public.bible_book_settings (
  book_number smallint primary key references public.bible_books (book_number),
  author      text not null,
  audience    text not null,
  era         text not null
);

comment on table public.bible_book_settings is
  '"The setting", book level: author, first audience, historical moment. '
  'Written offline and reviewed before loading. Never varies by user.';

create table public.bible_pericope_settings (
  book_number   smallint not null,
  start_chapter smallint not null,
  start_verse   smallint not null,
  note          text not null,
  primary key (book_number, start_chapter, start_verse),
  foreign key (book_number, start_chapter, start_verse)
    references public.bible_pericopes (book_number, start_chapter, start_verse)
);

comment on table public.bible_pericope_settings is
  '"The setting", passage level: one optional line per pericope. A '
  'missing row means the book setting is all there is to say.';

-- What the sheet calls. Takes the verse; the server picks the passage,
-- exactly as passage_context does. Zero rows only when the book has no
-- setting loaded yet — the client shows that as "not written yet".
create or replace function public.verse_setting(
  p_book_number int,
  p_chapter     int,
  p_verse       int
)
returns table (
  author   text,
  audience text,
  era      text,
  note     text
)
language sql
stable
as $$
  select b.author, b.audience, b.era, s.note
  from public.bible_book_settings b
  left join public.pericope_for(p_book_number, p_chapter, p_verse) r on true
  left join public.bible_pericope_settings s
    on  s.book_number   = b.book_number
    and s.start_chapter = r.start_chapter
    and s.start_verse   = r.start_verse
  where b.book_number = p_book_number;
$$;

comment on function public.verse_setting(int, int, int) is
  'Book setting plus the containing passage''s note (NULL if none).';

-- Same posture as the rest of the bible reference data: readable by any
-- signed-in user, no client writes.
alter table public.bible_book_settings     enable row level security;
alter table public.bible_pericope_settings enable row level security;

create policy "bible_book_settings_read" on public.bible_book_settings
  for select to authenticated using (true);
create policy "bible_pericope_settings_read" on public.bible_pericope_settings
  for select to authenticated using (true);

notify pgrst, 'reload schema';
