-- Ponder — move thread classification off `topics` into a service-only table
--
-- Why this exists: 20260824000002 hid the theme columns with a column-level
-- REVOKE on public.topics. That works, and it broke every build already on a
-- device. Postgres refuses `SELECT *` when the role lacks SELECT on any
-- column of the table, so the Internal Testing build (versionCode 7, built
-- 22 Aug, still calling `.from("topics").select("*")`) started 403ing on its
-- first query and showed "Couldn't reach the server". TOPIC_COLS in
-- src/lib/api.ts only landed in d8e4812, after that AAB was cut.
--
-- The lesson, and the rule from here on: a column-level grant list is a
-- BREAKING API CHANGE for every client already in the field, and Ponder has
-- no forced update. Never use per-column grants on a table the client reads.
-- Anything the reader must not see does not live on that row.
--
-- So: the classification moves to its own table that the client has no
-- access to at all, and `topics` goes back to being fully readable. Nothing
-- to leak, no grant list to keep in sync with TOPIC_COLS, and old builds
-- start working again the moment this lands.
-- ------------------------------------------------------------

-- ------------------------------------------------------------
-- 1. The side table
--
-- 1:1 with topics. Deliberately NOT a column on topics: this is routing
-- metadata about how an entry gets produced, and a confidence score attached
-- to your own thread is the tell that something classified you.
--
-- RLS on with zero policies denies anon and authenticated outright. The edge
-- functions use the service key and bypass RLS, so classification and
-- select_pool_entry() are unaffected.
-- ------------------------------------------------------------
create table if not exists public.topic_themes (
  topic_id      uuid primary key references public.topics (id) on delete cascade,
  theme_id      uuid references public.entry_themes (id),
  confidence    real,
  classified_at timestamptz not null default now()
);

comment on table public.topic_themes is
  'Service-only: which theme a thread was classified into, and how sure the '
  'classifier was. Never exposed to the client. See 20260825000001.';

alter table public.topic_themes enable row level security;

-- Supabase default privileges grant new public tables to anon/authenticated.
-- RLS already denies them, but the grant should not exist in the first place.
revoke all on public.topic_themes from anon, authenticated;

create index if not exists topic_themes_theme_idx
  on public.topic_themes (theme_id);

-- ------------------------------------------------------------
-- 2. Backfill
--
-- A row with theme_id null but classified_at set is meaningful: it records
-- "we ran the classifier and it honestly matched nothing", which is what
-- stops ensureTheme() paying for the same answer every night. Carry that
-- across exactly as it was.
-- ------------------------------------------------------------
-- Guarded so the whole migration stays re-runnable: it is applied by hand in
-- the SQL editor, and on a second pass the source columns are already gone.
do $backfill$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name   = 'topics'
      and column_name  = 'theme_classified_at'
  ) then
    insert into public.topic_themes (topic_id, theme_id, confidence, classified_at)
    select id, theme_id, theme_confidence, coalesce(theme_classified_at, now())
    from public.topics
    where theme_classified_at is not null
    on conflict (topic_id) do nothing;
  end if;
end
$backfill$;

-- ------------------------------------------------------------
-- 3. Repoint select_pool_entry()
--
-- Identical logic to 20260823000003; only the source of the theme changes.
-- Replaced BEFORE the columns are dropped so there is no window in which the
-- live function references a column that no longer exists — pg_cron can fire
-- mid-migration.
--
-- left join, not join: a thread with no topic_themes row has never been
-- classified, which must return null (per-user generation), not no row.
-- ------------------------------------------------------------
create or replace function public.select_pool_entry(
  p_topic_id  uuid,
  p_entry_type entry_type
)
returns uuid
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_user_id uuid;
  v_theme   uuid;
  v_conf    real;
  v_age     integer;
  v_id      uuid;
begin
  select t.user_id, tt.theme_id, tt.confidence,
         greatest(0, (current_date - t.created_at::date))
    into v_user_id, v_theme, v_conf, v_age
  from public.topics t
  left join public.topic_themes tt on tt.topic_id = t.id
  where t.id = p_topic_id;

  -- No theme, or the classifier wasn't confident => per-user generation.
  if v_theme is null
     or coalesce(v_conf, 0) < public.pool_confidence_floor() then
    return null;
  end if;

  select p.id into v_id
  from public.entry_pool p
  where p.theme_id = v_theme
    and p.entry_type = p_entry_type
    and not p.retired
    -- not already served to this thread
    and not exists (
      select 1 from public.entry_pool_seen s
      where s.topic_id = p_topic_id and s.pool_entry_id = p.id
    )
    -- verse never used on this thread
    and not exists (
      select 1 from public.daily_entries d
      where d.topic_id = p_topic_id and d.verse_ref = p.verse_ref
    )
    -- verse not seen by this user on another thread in the last 60 days
    and not exists (
      select 1 from public.daily_entries d
      where d.user_id = v_user_id
        and d.topic_id <> p_topic_id
        and d.date >= current_date - 60
        and d.verse_ref = p.verse_ref
    )
  -- closest to where this thread actually is, then arbitrary among equals
  order by abs(p.day_index - v_age), random()
  limit 1;

  return v_id;   -- null when the pool is exhausted for this thread
end;
$$;

-- create or replace preserves grants, but re-state it so a fresh database
-- built from these migrations ends up in the same place.
revoke all on function public.select_pool_entry(uuid, entry_type)
  from public, anon, authenticated;

-- ------------------------------------------------------------
-- 4. Drop the columns
-- ------------------------------------------------------------
drop index if exists public.topics_theme_idx;

alter table public.topics
  drop column if exists theme_id,
  drop column if exists theme_confidence,
  drop column if exists theme_classified_at;

-- ------------------------------------------------------------
-- 5. Give `topics` back to the client, whole
--
-- REVOKE SELECT on the table also clears the per-column grants left by
-- 20260824000002; the table-level GRANT then makes `select *` work again for
-- every build, old and new. There is nothing on this table to hide any more,
-- which is the entire point — the privacy is in the schema, not in a grant
-- list that a future `alter table ... add column` can silently widen.
-- ------------------------------------------------------------
revoke select on public.topics from authenticated;
grant  select on public.topics to authenticated;

-- ------------------------------------------------------------
-- Verify
--
--   -- true for every column, including any added later:
--   select has_column_privilege('authenticated','public.topics','title','SELECT');
--
--   -- 0 rows: the client cannot see the classification at all
--   select count(*) from pg_policies
--    where schemaname='public' and tablename='topic_themes';
--
--   -- replaces the diagnostic in 20260823000003 that joined topics.theme_id
--   select e.slug, count(*)
--     from public.topic_themes tt
--     join public.entry_themes e on e.id = tt.theme_id
--    group by 1 order by 2 desc;
-- ------------------------------------------------------------
