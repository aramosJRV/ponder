-- ============================================================
-- Ponder — Meditate: the phrases a reader is walked through before the
-- ponder questions.
--
-- One jsonb per entry, keyed by translation, because a phrase lifted from
-- one translation is usually not in another ("Trust in Yahweh" is WEB; BSB
-- and KJV read "the LORD"). The client walks whichever list matches the
-- translation on screen and skips Meditate when that key is absent.
--
-- Shape: { "WEB": ["Trust", "Trust in Yahweh", ...],
--          "BSB": [...], "KJV": [...] }
-- Every string is sliced out of bible_verses text server-side after an
-- exact match — never stored as the model typed it. A translation whose
-- list came back with fewer than two verified phrases is simply left out.
--
-- NULL is valid and expected: every entry written before this, every pooled
-- entry already sitting in entry_pool, and any entry whose phrase pass
-- failed. There is no backfill.
--
-- Purely additive — no grant, policy or existing column is touched, and no
-- shipped client selects `meditation`. See RELEASE-SAFETY.md rules 1 and 2.
-- ============================================================

alter table public.daily_entries add column if not exists meditation jsonb;
alter table public.entry_pool    add column if not exists meditation jsonb;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'daily_entries_meditation_is_object'
      and conrelid = 'public.daily_entries'::regclass
  ) then
    alter table public.daily_entries
      add constraint daily_entries_meditation_is_object
      check (meditation is null or jsonb_typeof(meditation) = 'object');
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'entry_pool_meditation_is_object'
      and conrelid = 'public.entry_pool'::regclass
  ) then
    alter table public.entry_pool
      add constraint entry_pool_meditation_is_object
      check (meditation is null or jsonb_typeof(meditation) = 'object');
  end if;
end $$;

-- ------------------------------------------------------------
-- THE TRAP, a fourth time. serve_pool_entry lists its columns explicitly,
-- so without this every pooled entry arrives with meditation = null and the
-- feature looks broken for exactly the users who never hit the live path.
--
-- Body below is 20260917000001's verbatim (checked against live on
-- 26 Sep 2026), with `meditation` added to the insert column list and the
-- select list. Nothing else changed.
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
    quote, meditation
  )
  select p_topic_id, v_user_id, p_date, p.verse_ref, p.book_number, p.chapter,
         p.verse_start, p.verse_end, p.verse_text, p.thought, p.illustration,
         p.ponder, p.prayer_prompts, p.entry_type, p.cross_refs, p.song,
         p.verse_question, p.quote, p.meditation
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

comment on column public.daily_entries.meditation is
  'Meditate phrases keyed by translation (WEB/BSB/KJV), each a verified verbatim slice of bible_verses text, walked small to large. NULL when absent. See 20260926000001.';
