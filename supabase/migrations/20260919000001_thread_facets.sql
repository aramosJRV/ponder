-- 20260919000001_thread_facets.sql
-- Per-thread facet rotation (live generation path).
-- Additive only: three nullable columns, no grant changes, no backfill.
-- Rollback: drop the three columns; nothing depends on them yet.

alter table public.topic_themes
  add column if not exists facets jsonb;

alter table public.topic_themes
  add column if not exists facets_generated_at timestamptz;

alter table public.daily_entries
  add column if not exists facet text;

comment on column public.topic_themes.facets is
  'Array of {slug,label,brief} generated once per thread from its description. Drives least-recently-used facet rotation in live generation.';
comment on column public.topic_themes.facets_generated_at is
  'Set only on successful facet generation. Null = not yet generated or last attempt failed; safe to retry.';
comment on column public.daily_entries.facet is
  'topic_themes.facets[].slug this entry was written against. Null = pooled or pre-migration.';

create index if not exists daily_entries_topic_facet_date_idx
  on public.daily_entries (topic_id, facet, date desc)
  where facet is not null;
