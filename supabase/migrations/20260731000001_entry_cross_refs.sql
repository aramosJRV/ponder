-- ============================================================
-- Cross-references cited by a daily entry.
--
-- Populated by generate-entry ONLY with references that resolved
-- against bible_verses. Unresolvable refs are dropped before insert
-- and logged to generation_failures (stage = 'cross_ref_dropped'),
-- so anything in this column is a passage that provably exists in
-- the World English Bible.
--
-- Shape: [{ "ref": "Romans 8:26", "book": "Romans", "chapter": 8,
--           "verse_start": 26, "verse_end": 26 }]
--
-- Text is deliberately NOT stored: the footnote shows references
-- only, and any text must be read from bible_verses. Same rule as
-- verse_text — model output never becomes scripture.
-- ============================================================

alter table public.daily_entries
  add column if not exists cross_refs jsonb not null default '[]'::jsonb;

-- idempotent: `add constraint` has no IF NOT EXISTS form
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'daily_entries_cross_refs_is_array'
      and conrelid = 'public.daily_entries'::regclass
  ) then
    alter table public.daily_entries
      add constraint daily_entries_cross_refs_is_array
      check (jsonb_typeof(cross_refs) = 'array'
             and jsonb_array_length(cross_refs) <= 3);
  end if;
end $$;

comment on column public.daily_entries.cross_refs is
  'Validated supporting references shown in the entry footnote. Every element resolved against bible_verses at generation time. Never contains verse text.';
