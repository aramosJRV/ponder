-- ============================================================
-- Book threads — read a book of the Bible one section a day.
--
-- PLAN STAGE: written in phase 2, NOT applied. Antonio approves before
-- `supabase db push`. Backend (this + generate-entry) ships before the app.
--
-- Additive only. Old builds (no forced update) keep working because:
--   * topics: they select an explicit column list, which never includes
--     book_number, so a book thread reaches them as an ordinary thread
--     titled with the book's name.
--   * daily_entries: they `select *`; two new nullable columns arrive as
--     extra keys they ignore. A book day fills every existing NOT NULL
--     field (key verse in verse_*, thought, illustration, ponder, prayer),
--     so it renders as a normal day.
--   * No column-level GRANT/REVOKE anywhere (25 Aug outage). The shared
--     content library is a separate table hidden by RLS with no policy,
--     the same pattern as entry_pool.
-- ============================================================

-- ------------------------------------------------------------
-- 1. A thread is a book thread when book_number is set. Title holds the
--    book's name, so every build has something sensible to show.
-- ------------------------------------------------------------
alter table public.topics
  add column book_number smallint references public.bible_books (book_number);

comment on column public.topics.book_number is
  'Set for a book thread (read one bible_pericopes section a day); null for '
  'a question thread. Only the app from 1.0.22 creates these.';

-- ------------------------------------------------------------
-- 2. Per entry: where it sits in the book, and when it was first opened.
--
-- book_section: {start_chapter, start_verse, end_chapter, end_verse,
--                index, count} — the whole section (the verse_* columns hold
--                only the key verse) and its position, e.g. 9 of 48.
-- opened_on:    the reader's local date (profile timezone) the entry was
--               first shown. Pacing reads it: the next section appears on
--               a later local date than this. Null = not opened yet.
-- ------------------------------------------------------------
alter table public.daily_entries
  add column book_section jsonb,
  add column opened_on date;

alter table public.daily_entries
  add constraint daily_entries_book_section_is_object check (
    book_section is null or (
      jsonb_typeof(book_section) = 'object'
      and book_section ?& array['start_chapter','start_verse','end_chapter','end_verse','index','count']
    )
  );

-- ------------------------------------------------------------
-- 3. Shared content library: one row per section, the same for every
--    reader. Translation-neutral writing; verse text always comes from
--    bible_verses at read time, never from here.
--
-- status: pending (queued) -> ready, or failed after `attempts` tries.
-- review: the problems each check round found and the writer fixed, kept
--         so a bad reading can be traced.
-- ------------------------------------------------------------
create table public.book_section_content (
  book_number     smallint not null,
  start_chapter   smallint not null,
  start_verse     smallint not null,
  status          text not null default 'pending'
                    check (status in ('pending', 'ready', 'failed')),
  attempts        smallint not null default 0,
  key_chapter     smallint,
  key_verse_start smallint,
  key_verse_end   smallint,
  thought         text,
  illustration    text,
  ponder          text[],
  prayer_prompts  text[],
  meditation      jsonb,
  review          jsonb,
  model           text,
  requested_at    timestamptz not null default now(),
  ready_at        timestamptz,
  primary key (book_number, start_chapter, start_verse),
  foreign key (book_number, start_chapter, start_verse)
    references public.bible_pericopes (book_number, start_chapter, start_verse),
  check (status <> 'ready' or (
    key_chapter is not null and key_verse_start is not null
    and key_verse_end >= key_verse_start
    and thought is not null and illustration is not null
    and cardinality(ponder) between 1 and 4
    and cardinality(prayer_prompts) between 1 and 4
  ))
);

-- Service role only: RLS on, no policy (same as entry_pool).
alter table public.book_section_content enable row level security;

create index book_section_content_pending_idx
  on public.book_section_content (requested_at) where status = 'pending';

-- ------------------------------------------------------------
-- 4. Queue a section for writing. Idempotent; a failed section is
--    re-queued. Called by mark_entry_opened (next section) and by
--    generate-entry when a thread starts.
-- ------------------------------------------------------------
create or replace function public.queue_book_section(
  p_book_number int, p_start_chapter int, p_start_verse int
) returns void
language sql
security definer
set search_path = public
as $$
  insert into public.book_section_content (book_number, start_chapter, start_verse)
  values (p_book_number, p_start_chapter, p_start_verse)
  on conflict (book_number, start_chapter, start_verse) do update
    set status = 'pending', attempts = 0, requested_at = now()
    where book_section_content.status = 'failed';
$$;

revoke execute on function public.queue_book_section(int, int, int) from public, anon, authenticated;
grant execute on function public.queue_book_section(int, int, int) to service_role;

-- ------------------------------------------------------------
-- 5. The app calls this when it shows an entry. Records the first-open
--    date in the reader's own timezone and, for a book day, queues the
--    next section so it is written before it is needed.
--    Only ever touches the caller's own entry.
-- ------------------------------------------------------------
create or replace function public.mark_entry_opened(p_entry_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_entry public.daily_entries;
  v_next  record;
begin
  update public.daily_entries e
     set opened_on = (now() at time zone coalesce(p.timezone, 'UTC'))::date
    from public.profiles p
   where e.id = p_entry_id
     and e.user_id = auth.uid()
     and p.id = e.user_id
     and e.opened_on is null
  returning e.* into v_entry;

  if v_entry.id is null or v_entry.book_section is null then
    return;
  end if;

  select bp.start_chapter, bp.start_verse into v_next
    from public.bible_pericopes bp
   where bp.book_number = v_entry.book_number
     and bp.start_ord > (v_entry.book_section->>'start_chapter')::int * 1000
                      + (v_entry.book_section->>'start_verse')::int
   order by bp.start_ord
   limit 1;

  if found then
    perform public.queue_book_section(v_entry.book_number, v_next.start_chapter, v_next.start_verse);
  end if;
end;
$$;

revoke execute on function public.mark_entry_opened(uuid) from public, anon;
grant execute on function public.mark_entry_opened(uuid) to authenticated;

-- ------------------------------------------------------------
-- 6. Book picker: every book in Bible order with its section count.
-- ------------------------------------------------------------
create or replace function public.book_catalogue()
returns table (book_number smallint, name text, section_count int)
language sql
stable
security definer
set search_path = public
as $$
  select b.book_number, b.name, count(p.*)::int
    from public.bible_books b
    join public.bible_pericopes p using (book_number)
   group by b.book_number, b.name
   order by b.book_number;
$$;

revoke execute on function public.book_catalogue() from public, anon;
grant execute on function public.book_catalogue() to authenticated;

-- ------------------------------------------------------------
-- 7. Writer job: every 5 minutes, if anything is queued and the spend
--    tripwire is clear, ask generate-entry to write queued sections.
--    generate-entry keeps verify_jwt OFF (pg_net call); it checks the
--    service key itself and refuses book_build from user tokens.
-- ------------------------------------------------------------
create or replace function public.run_book_build()
returns void
language plpgsql
security definer
set search_path = public, extensions, vault
as $$
begin
  if not exists (select 1 from public.book_section_content where status = 'pending') then
    return;
  end if;
  if not public.generation_allowed() then
    raise warning 'run_book_build: TRIPWIRE FIRED %', public.tripwire_status();
    return;
  end if;
  perform public.call_edge_function('generate_entry_url', jsonb_build_object('mode', 'book_build'));
end;
$$;

-- Cron (postgres) only: from an app this would let anyone poke the writer.
revoke execute on function public.run_book_build() from public, anon, authenticated;

select cron.schedule('ponder-book-build', '*/5 * * * *', $$ select public.run_book_build(); $$);
