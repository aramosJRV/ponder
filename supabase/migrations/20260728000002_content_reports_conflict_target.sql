-- ============================================================
-- Ponder — fix content_reports conflict targets
--
-- 20260728000001 created PARTIAL unique indexes:
--   unique (user_id, entry_id)     where entry_id is not null
--   unique (user_id, synthesis_id) where synthesis_id is not null
--
-- Postgres cannot infer a partial unique index for ON CONFLICT
-- unless the statement repeats the index predicate. PostgREST's
-- upsert (`onConflict=user_id,entry_id`) sends column names only,
-- so every report would fail with:
--   42P10 no unique or exclusion constraint matching the
--         ON CONFLICT specification
--
-- Plain unique CONSTRAINTS work here: Postgres treats NULLs as
-- distinct by default, so rows with entry_id IS NULL (synthesis
-- reports) never collide with each other. Same in reverse.
-- ============================================================

drop index if exists public.content_reports_unique_entry;
drop index if exists public.content_reports_unique_synthesis;

alter table public.content_reports
  add constraint content_reports_unique_entry
  unique (user_id, entry_id);

alter table public.content_reports
  add constraint content_reports_unique_synthesis
  unique (user_id, synthesis_id);
