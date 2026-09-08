-- ============================================================
-- Ponder section redesign — verse-anchored question + per-question notes
--
-- Both changes are ADDITIVE and NULLABLE on purpose. Installed builds do
-- `select *` on daily_entries and notes; adding a column is safe for those
-- (the 25 Aug outage was a REVOKE, which is a different thing entirely).
-- Neither table carries column-level grants any more — see
-- 20260825000001_topic_themes_side_table.sql — so there is no grant list to
-- keep in sync here.
--
-- No backfill. Every existing entry and every entry already sitting in the
-- pool keeps verse_question = null and the client falls back to ponder[0]
-- with no badge. The pool turns itself over.
-- ============================================================

-- ------------------------------------------------------------
-- 1. The verse-anchored question
--
-- jsonb, not two columns, because it is one thing: { question, phrase }.
--   question — the ponder question, shown as question 1.
--   phrase   — a fragment of THIS entry's verse_text, used to highlight the
--              words the question is pointing at.
--
-- `phrase` is only ever written after generate-entry has confirmed it is a
-- substring of the verse text read from bible_verses. That check is the same
-- posture as cross_refs: the model may nominate scripture, it may never
-- supply it. A phrase that fails the check is dropped and the question is
-- stored alone.
--
-- Deliberately NOT a check constraint on the shape: a malformed payload must
-- degrade to "no anchored question", never block the night's insert.
-- ------------------------------------------------------------
alter table public.daily_entries add column if not exists verse_question jsonb;
alter table public.entry_pool    add column if not exists verse_question jsonb;

comment on column public.daily_entries.verse_question is
  '{ question, phrase } — phrase is a validated substring of verse_text. Null on entries generated before 8 Sep 2026.';

-- ------------------------------------------------------------
-- 2. Per-question notes
--
--   null   general note on the entry (every note written before today, and
--          the composer at the foot of the card, which stays)
--   0      the verse-anchored question
--   1..4   ponder[n-1]
--
-- The upper bound is 4, not 3, because daily_entries.ponder is constrained
-- `cardinality(ponder) between 1 and 4` (initial schema, line 147). The tool
-- schema asks for 2-3 and the parser tolerates 1-3, so a fourth question is
-- not reachable today — but the table permits one, and a check constraint
-- that contradicts the column it indexes into is a bug waiting for the day
-- someone widens the generator.
--
-- No foreign key to a question, because there is nothing to point at: ponder
-- is a text[] on an immutable row. The index is only meaningful next to its
-- entry, which is how it is always read.
-- ------------------------------------------------------------
alter table public.notes add column if not exists ponder_index smallint;

alter table public.notes drop constraint if exists notes_ponder_index_range;
alter table public.notes add constraint notes_ponder_index_range
  check (ponder_index is null or ponder_index between 0 and 4);

comment on column public.notes.ponder_index is
  'Which ponder question this note answers. null = general note on the entry. 0 = verse-anchored question, 1..4 = ponder[n-1] (ponder allows up to 4).';

-- notes_entry_idx already covers the per-entry read; grouping happens in the
-- client over a handful of rows. No new index.

-- ------------------------------------------------------------
-- 3. Serving a pooled entry must carry the new column
--
-- THE TRAP: serve_pool_entry lists its columns explicitly. Adding a column
-- to both tables is not enough — without this, every pooled entry silently
-- arrives with verse_question = null and the feature appears to "not work"
-- for exactly the users who never hit the live path. Same class of bug as
-- the three functions that read bible_verses unfiltered.
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
    ponder, prayer_prompts, entry_type, cross_refs, song, verse_question
  )
  select p_topic_id, v_user_id, p_date, p.verse_ref, p.book_number, p.chapter,
         p.verse_start, p.verse_end, p.verse_text, p.thought, p.illustration,
         p.ponder, p.prayer_prompts, p.entry_type, p.cross_refs, p.song,
         p.verse_question
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

-- create or replace preserves grants; re-state so a fresh database matches.
revoke all on function public.serve_pool_entry(uuid, date, uuid)
  from public, anon, authenticated;
