-- ============================================================
-- Ponder — Bucket 1, step 5a: the quote as the reader receives it.
--
-- Denormalised onto the entry, exactly like `song` and `verse_text`: every
-- field is copied from voice_quotes/voices at generation time, never from
-- model output. The model only ever emits an id (see 20260916000002). This
-- keeps voice_quotes off the client's wire and keeps today's entry readable
-- offline.
--
-- NULL is valid and expected: 4 entries in 5 carry no quote by design, and a
-- quote id that does not resolve means no quote rather than a failed entry.
--
-- Purely additive — no grant, policy or existing column is touched, and no
-- client reads `quote` yet. See RELEASE-SAFETY.md rules 1 and 2.
-- ============================================================

alter table public.daily_entries add column if not exists quote jsonb;
alter table public.entry_pool    add column if not exists quote jsonb;

-- Shape: { "id": "watson-divinity-41f23f2d",
--          "text": "<verbatim>", "author": "Thomas Watson",
--          "work": "A Body of Divinity", "year": 1692 }
-- `year` is optional so a future source without one still fits.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'daily_entries_quote_is_object'
      and conrelid = 'public.daily_entries'::regclass
  ) then
    alter table public.daily_entries
      add constraint daily_entries_quote_is_object
      check (quote is null or (
        jsonb_typeof(quote) = 'object'
        and quote ? 'id'     and quote ? 'text'
        and quote ? 'author' and quote ? 'work'));
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'entry_pool_quote_is_object'
      and conrelid = 'public.entry_pool'::regclass
  ) then
    alter table public.entry_pool
      add constraint entry_pool_quote_is_object
      check (quote is null or (
        jsonb_typeof(quote) = 'object'
        and quote ? 'id'     and quote ? 'text'
        and quote ? 'author' and quote ? 'work'));
  end if;
end $$;

-- Repeat avoidance: "which quotes has this thread already been given?"
-- Same pattern as daily_entries_song_track_idx (20260823000001).
create index if not exists daily_entries_quote_id_idx
  on public.daily_entries ((quote ->> 'id'))
  where quote is not null;

-- ------------------------------------------------------------
-- THE TRAP, again. serve_pool_entry lists its columns explicitly, so adding
-- `quote` to both tables is NOT enough: without this, every pooled entry
-- arrives with quote = null and the feature looks broken for exactly the
-- users who never hit the live path. This is the same bug that still leaves
-- pooled entries with song = null, and the one 20260908000001 had to fix for
-- verse_question.
--
-- Body below is 20260908000001's verbatim, with `quote` added to the insert
-- column list and the select list. Nothing else changed.
-- ------------------------------------------------------------
create or replace function public.serve_pool_entry(
  p_topic_id uuid,
  p_date     date,
  p_pool_id  uuid
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid;
  v_new_id  uuid;
begin
  select user_id into v_user_id from public.topics where id = p_topic_id;
  if v_user_id is null then return null; end if;

  insert into public.daily_entries (
    topic_id, user_id, date, verse_ref, book_number, chapter,
    verse_start, verse_end, verse_text, thought, illustration,
    ponder, prayer_prompts, entry_type, cross_refs, song, verse_question,
    quote
  )
  select p_topic_id, v_user_id, p_date, p.verse_ref, p.book_number, p.chapter,
         p.verse_start, p.verse_end, p.verse_text, p.thought, p.illustration,
         p.ponder, p.prayer_prompts, p.entry_type, p.cross_refs, p.song,
         p.verse_question, p.quote
  from public.entry_pool p
  where p.id = p_pool_id
  on conflict (topic_id, date) do nothing
  returning id into v_new_id;

  if v_new_id is null then
    return null;  -- someone else filled this day first
  end if;

  insert into public.entry_pool_seen (topic_id, pool_entry_id, used_on)
  values (p_topic_id, p_pool_id, p_date)
  on conflict do nothing;

  return v_new_id;
end;
$$;

revoke all on function public.serve_pool_entry(uuid, date, uuid)
  from public, anon, authenticated;

comment on column public.daily_entries.quote is
  'Public-domain author quote for this entry, or NULL. Every field copied from voice_quotes/voices server-side; the model emits only an id. NULL on ~4 entries in 5 by design. See 20260917000001.';
