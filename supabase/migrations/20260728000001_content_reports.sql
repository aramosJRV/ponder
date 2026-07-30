-- ============================================================
-- Ponder — content_reports
--
-- Google Play's Generative AI policy requires apps that produce
-- AI-generated content to give users an in-app way to report
-- offensive output without leaving the app. This table backs
-- that mechanism.
--
-- Reports may target a daily entry OR a synthesis — exactly one.
-- ============================================================

create type report_target as enum ('daily_entry', 'synthesis');

create type report_reason as enum (
  'offensive',        -- hateful, demeaning, or abusive
  'harmful_guidance', -- spiritually or personally harmful direction
  'scripture_error',  -- verse misquoted, mis-referenced, or misapplied
  'nonsense',         -- incoherent or clearly broken output
  'other'
);

create table public.content_reports (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  target report_target not null,
  entry_id uuid references public.daily_entries (id) on delete cascade,
  synthesis_id uuid references public.syntheses (id) on delete cascade,
  reason report_reason not null,
  detail text check (detail is null or char_length(detail) <= 2000),
  -- Snapshot of what was on screen. Entries can in principle be
  -- regenerated or deleted; a report is useless without the text
  -- that prompted it.
  reported_content jsonb,
  resolved_at timestamptz,
  created_at timestamptz not null default now(),

  -- exactly one target, matching the discriminator
  constraint content_reports_target_match check (
    (target = 'daily_entry' and entry_id is not null and synthesis_id is null)
    or
    (target = 'synthesis' and synthesis_id is not null and entry_id is null)
  )
);

create index content_reports_user_idx on public.content_reports (user_id, created_at desc);
create index content_reports_open_idx on public.content_reports (created_at desc)
  where resolved_at is null;

-- One report per user per item. A second submission updates the first
-- rather than piling up duplicates (see the upsert in src/lib/api.ts).
-- NOTE: superseded by 20260728000002 — these partial indexes are dropped
-- and replaced with plain unique constraints, because ON CONFLICT cannot
-- infer a partial index without repeating its predicate.
create unique index content_reports_unique_entry
  on public.content_reports (user_id, entry_id)
  where entry_id is not null;
create unique index content_reports_unique_synthesis
  on public.content_reports (user_id, synthesis_id)
  where synthesis_id is not null;

alter table public.content_reports enable row level security;

-- Users may file and read their own reports. Updating lets a user
-- correct or re-submit; deleting lets them withdraw one.
-- resolved_at is set by service role only (no client update path to it
-- that matters — a user marking their own report resolved is harmless).
create policy "content_reports_select_own" on public.content_reports
  for select using (auth.uid() = user_id);
create policy "content_reports_insert_own" on public.content_reports
  for insert with check (auth.uid() = user_id);
create policy "content_reports_update_own" on public.content_reports
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "content_reports_delete_own" on public.content_reports
  for delete using (auth.uid() = user_id);
