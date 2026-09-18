-- ============================================================
-- Ponder — operator dashboard snapshot
--
-- ⚠️  SCHEMA CHANGE. Apply via `supabase db push` or the dashboard SQL editor.
--     Adds three tables, one cron job, and read-only reporting functions.
--     Touches NOTHING that the app reads or writes.
--
-- WHY A SNAPSHOT AND NOT LIVE QUERIES
--
-- Two of the numbers that matter most — DAU, WAU, retention — are NOT
-- backfillable. profiles.last_opened_at holds one timestamp per user, so
-- "how many were active on 3 September" is unanswerable after the fact. The
-- only way to get a trend is to write the number down each night. That is
-- what this table is: an append-only log of daily readings, and the history
-- starts the day it is applied.
--
-- Everything that IS backfillable (installs, notes, entries, spend) is
-- recomputed over 30 days on every capture, so those series are correct
-- immediately and self-heal if a night is missed.
--
-- SECURITY
--
-- The snapshot aggregates every user's activity, so it is operator-only:
-- readable by rows in admin_users and nobody else. RLS with no policy for
-- anon is deny-all; the one policy grants select to authenticated users who
-- are in admin_users. Nothing here is granted to the app.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Who counts as an operator
-- ------------------------------------------------------------
create table if not exists public.admin_users (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  note       text,
  created_at timestamptz not null default now()
);

alter table public.admin_users enable row level security;
-- No policies: deny-all for anon and authenticated. Service role and the
-- security-definer functions below are the only readers.
revoke all on public.admin_users from anon, authenticated;

create or replace function public.is_admin(p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$ select exists (select 1 from public.admin_users where user_id = p_user_id); $$;

grant execute on function public.is_admin(uuid) to authenticated;

-- ------------------------------------------------------------
-- 2. Operator-editable config
--
-- The one number that cannot be derived: how much Anthropic credit is
-- sitting in the Console. There is no API that reports a balance, so the
-- operator anchors it — "it was $X on date Y" — and the dashboard subtracts
-- spend_ledger since that date. Re-anchor after every top-up or the number
-- drifts. Auto-reload makes this a burn-rate gauge, not a cliff warning.
-- ------------------------------------------------------------
create table if not exists public.admin_config (
  id                    boolean primary key default true check (id),
  credit_balance_usd    numeric(12,2) not null default 0,
  credit_balance_as_of  timestamptz   not null default now(),
  updated_at            timestamptz   not null default now()
);

insert into public.admin_config (id) values (true) on conflict (id) do nothing;

alter table public.admin_config enable row level security;

drop policy if exists admin_config_read on public.admin_config;
create policy admin_config_read on public.admin_config
  for select to authenticated using (public.is_admin(auth.uid()));

drop policy if exists admin_config_write on public.admin_config;
create policy admin_config_write on public.admin_config
  for update to authenticated
  using (public.is_admin(auth.uid()))
  with check (public.is_admin(auth.uid()));

grant select, update on public.admin_config to authenticated;

-- ------------------------------------------------------------
-- 3. The snapshot log
-- ------------------------------------------------------------
create table if not exists public.admin_snapshot (
  captured_on date primary key default current_date,
  captured_at timestamptz not null default now(),
  payload     jsonb not null
);

create index if not exists admin_snapshot_at_idx
  on public.admin_snapshot (captured_at desc);

alter table public.admin_snapshot enable row level security;

drop policy if exists admin_snapshot_read on public.admin_snapshot;
create policy admin_snapshot_read on public.admin_snapshot
  for select to authenticated using (public.is_admin(auth.uid()));

grant select on public.admin_snapshot to authenticated;

-- ------------------------------------------------------------
-- 4. The reading
--
-- One function, one jsonb document. Deliberately not a view per metric:
-- the dashboard should render exactly what was true at capture time, and a
-- view would silently re-evaluate against today's data.
-- ------------------------------------------------------------
create or replace function public.build_admin_snapshot()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, extensions
as $fn$
declare
  v_users    jsonb;
  v_funnel   jsonb;
  v_engage   jsonb;
  v_content  jsonb;
  v_pool     jsonb;
  v_fail     jsonb;
  v_cost     jsonb;
  v_cron     jsonb;
begin
  -- ---------- users ----------
  select jsonb_build_object(
    'total',        count(*),
    'new_24h',      count(*) filter (where p.created_at > now() - interval '24 hours'),
    'new_7d',       count(*) filter (where p.created_at > now() - interval '7 days'),
    'new_30d',      count(*) filter (where p.created_at > now() - interval '30 days'),
    'dau',          count(*) filter (where p.last_opened_at > now() - interval '24 hours'),
    'wau',          count(*) filter (where p.last_opened_at > now() - interval '7 days'),
    'mau',          count(*) filter (where p.last_opened_at > now() - interval '30 days'),
    'dormant_14d',  count(*) filter (where p.last_opened_at < now() - interval '14 days'),
    'email_backed', count(*) filter (where u.email is not null),
    'anonymous',    count(*) filter (where u.email is null)
  )
  into v_users
  from public.profiles p
  join auth.users u on u.id = p.id;

  -- 7-day retention: of accounts older than a week, how many opened this week
  v_users := v_users || (
    select jsonb_build_object('retention_7d', jsonb_build_object(
      'eligible', count(*),
      'returned', count(*) filter (where last_opened_at > now() - interval '7 days'),
      'pct', case when count(*) = 0 then null else
        round(100.0 * count(*) filter (where last_opened_at > now() - interval '7 days')
              / count(*), 1) end
    ))
    from public.profiles where created_at < now() - interval '7 days'
  );

  -- installs per day, 30d (backfillable — recomputed every capture)
  v_users := v_users || (
    select jsonb_build_object('installs_series', coalesce(jsonb_agg(
      jsonb_build_object('d', d::date, 'n', n) order by d), '[]'::jsonb))
    from (
      select g.d, count(p.id) as n
      from generate_series(current_date - 29, current_date, interval '1 day') g(d)
      left join public.profiles p on p.created_at::date = g.d::date
      group by g.d
    ) s
  );

  -- ---------- activation funnel (accounts created in the last 30d) ----------
  select jsonb_build_object(
    'installs',      count(*),
    'made_thread',   count(*) filter (where t.n > 0),
    'got_entry',     count(*) filter (where e.n > 0),
    'wrote_note',    count(*) filter (where nt.n > 0)
  )
  into v_funnel
  from public.profiles p
  left join lateral (select count(*) n from public.topics where user_id = p.id) t on true
  left join lateral (select count(*) n from public.daily_entries where user_id = p.id) e on true
  left join lateral (select count(*) n from public.notes where user_id = p.id) nt on true
  where p.created_at > now() - interval '30 days';

  -- ---------- engagement ----------
  select jsonb_build_object(
    'threads_active',    count(*) filter (where status = 'active'),
    'threads_paused',    count(*) filter (where status = 'paused'),
    'threads_concluded', count(*) filter (where status = 'concluded'),
    'threads_new_7d',    count(*) filter (where created_at > now() - interval '7 days'),
    'threads_total',     count(*)
  )
  into v_engage
  from public.topics;

  v_engage := v_engage || (
    select jsonb_build_object(
      'notes_total',      count(*),
      'notes_7d',         count(*) filter (where created_at > now() - interval '7 days'),
      'notes_30d',        count(*) filter (where created_at > now() - interval '30 days'),
      'note_writers_7d',  count(distinct user_id) filter (where created_at > now() - interval '7 days'),
      'note_writers_30d', count(distinct user_id) filter (where created_at > now() - interval '30 days')
    ) from public.notes
  );

  v_engage := v_engage || (
    select jsonb_build_object(
      'syntheses_7d',  count(*) filter (where created_at > now() - interval '7 days'),
      'syntheses_30d', count(*) filter (where created_at > now() - interval '30 days')
    ) from public.syntheses
  );

  -- notes per day, 30d
  v_engage := v_engage || (
    select jsonb_build_object('notes_series', coalesce(jsonb_agg(
      jsonb_build_object('d', d::date, 'n', n) order by d), '[]'::jsonb))
    from (
      select g.d, count(n.id) as n
      from generate_series(current_date - 29, current_date, interval '1 day') g(d)
      left join public.notes n on n.created_at::date = g.d::date
      group by g.d
    ) s
  );

  -- threads with zero entries — the "generated nothing, ever" cohort
  v_engage := v_engage || (
    select jsonb_build_object('active_threads_no_entries', count(*))
    from public.topics t
    where t.status = 'active'
      and not exists (select 1 from public.daily_entries d where d.topic_id = t.id)
  );

  -- ---------- content / generation ----------
  select jsonb_build_object(
    'entries_today',    count(*) filter (where date = current_date),
    'entries_7d',       count(*) filter (where created_at > now() - interval '7 days'),
    'entries_30d',      count(*) filter (where created_at > now() - interval '30 days'),
    'fallback_7d',      count(*) filter (where created_at > now() - interval '7 days' and fallback_used),
    'challenge_30d',    count(*) filter (where created_at > now() - interval '30 days' and entry_type = 'challenge'),
    'affirming_30d',    count(*) filter (where created_at > now() - interval '30 days' and entry_type = 'affirming'),
    'distinct_verses_30d', count(distinct verse_ref) filter (where created_at > now() - interval '30 days')
  )
  into v_content
  from public.daily_entries;

  v_content := v_content || (
    select jsonb_build_object('entries_series', coalesce(jsonb_agg(
      jsonb_build_object('d', d::date, 'n', n) order by d), '[]'::jsonb))
    from (
      select g.d, count(e.id) as n
      from generate_series(current_date - 29, current_date, interval '1 day') g(d)
      left join public.daily_entries e on e.date = g.d::date
      group by g.d
    ) s
  );

  -- active threads that did NOT get today's entry
  v_content := v_content || (
    select jsonb_build_object('threads_missing_today', count(*))
    from public.topics t
    where t.status = 'active'
      and not exists (
        select 1 from public.daily_entries d
        where d.topic_id = t.id and d.date = current_date)
  );

  v_content := v_content || (
    select jsonb_build_object(
      'reports_open',  count(*) filter (where resolved_at is null),
      'reports_7d',    count(*) filter (where created_at > now() - interval '7 days')
    ) from public.content_reports
  );

  -- what people are actually bringing: top themes among active threads
  v_content := v_content || (
    select jsonb_build_object('top_themes', coalesce(jsonb_agg(
      jsonb_build_object('theme', title, 'n', n) order by n desc), '[]'::jsonb))
    from (
      select coalesce(et.title, 'unclassified') as title, count(*) as n
      from public.topics t
      left join public.topic_themes tt on tt.topic_id = t.id
      left join public.entry_themes et on et.id = tt.theme_id
      where t.status = 'active'
      group by 1 order by 2 desc limit 10
    ) s
  );

  -- ---------- pool ----------
  select jsonb_build_object(
    'live',        count(*) filter (where not retired),
    'retired',     count(*) filter (where retired),
    'unreviewed_gated', count(*) filter (
                     where not retired and not reviewed and et.requires_review)
  )
  into v_pool
  from public.entry_pool ep
  join public.entry_themes et on et.id = ep.theme_id;

  v_pool := v_pool || (
    select jsonb_build_object('by_theme', coalesce(jsonb_agg(
      jsonb_build_object('theme', title, 'n', n, 'gated', gated) order by n asc), '[]'::jsonb))
    from (
      select et.title, et.requires_review as gated,
             count(ep.id) filter (where not ep.retired) as n
      from public.entry_themes et
      left join public.entry_pool ep on ep.theme_id = et.id
      where et.active
      group by et.title, et.requires_review
    ) s
  );

  -- pool burn + runway
  v_pool := v_pool || (
    select jsonb_build_object(
      'consumed_7d', count(*),
      'burn_per_day', round(count(*) / 7.0, 1)
    ) from public.entry_pool_seen
    where used_on > current_date - 7
  );

  -- ---------- failures ----------
  -- Split by stage. NEVER surface a raw total: pool_build and
  -- pool_verse_resolution are background noise and have caused a false alarm.
  select jsonb_build_object(
    'by_stage_24h', coalesce((
      select jsonb_agg(jsonb_build_object('stage', stage, 'n', n) order by n desc)
      from (select stage, count(*) n from public.generation_failures
            where created_at > now() - interval '24 hours' group by stage) a), '[]'::jsonb),
    'by_stage_7d', coalesce((
      select jsonb_agg(jsonb_build_object('stage', stage, 'n', n) order by n desc)
      from (select stage, count(*) n from public.generation_failures
            where created_at > now() - interval '7 days' group by stage) b), '[]'::jsonb),
    'actionable_24h', (
      select count(*) from public.generation_failures
      where created_at > now() - interval '24 hours'
        and stage not in ('pool_build','pool_verse_resolution','attempt_1',
                          'fallback_used','cross_ref_dropped')),
    'latest_error', (
      select left(coalesce(detail->>'error', detail::text), 200)
      from public.generation_failures
      where stage not in ('pool_build','pool_verse_resolution','attempt_1',
                          'fallback_used','cross_ref_dropped')
      order by created_at desc limit 1)
  )
  into v_fail;

  -- ---------- cost ----------
  select jsonb_build_object(
    'today_usd',     round(coalesce(sum(usd_cost) filter (where occurred_at >= date_trunc('day', now())), 0), 4),
    'yesterday_usd', round(coalesce(sum(usd_cost) filter (
                       where occurred_at >= date_trunc('day', now()) - interval '1 day'
                         and occurred_at <  date_trunc('day', now())), 0), 4),
    'd7_usd',        round(coalesce(sum(usd_cost) filter (where occurred_at > now() - interval '7 days'), 0), 4),
    'd30_usd',       round(coalesce(sum(usd_cost) filter (where occurred_at > now() - interval '30 days'), 0), 4),
    'mtd_usd',       round(coalesce(sum(usd_cost) filter (where occurred_at >= date_trunc('month', now())), 0), 4)
  )
  into v_cost
  from public.spend_ledger;

  v_cost := v_cost || (
    select jsonb_build_object('by_kind_30d', coalesce(jsonb_agg(
      jsonb_build_object('kind', kind, 'usd', usd, 'calls', calls) order by usd desc), '[]'::jsonb))
    from (
      select kind, round(sum(usd_cost), 4) as usd, count(*) as calls
      from public.spend_ledger where occurred_at > now() - interval '30 days'
      group by kind
    ) s
  );

  v_cost := v_cost || (
    select jsonb_build_object('daily_series', coalesce(jsonb_agg(
      jsonb_build_object('d', d::date, 'usd', usd) order by d), '[]'::jsonb))
    from (
      select g.d, round(coalesce(sum(sl.usd_cost), 0), 4) as usd
      from generate_series(current_date - 29, current_date, interval '1 day') g(d)
      left join public.spend_ledger sl on sl.occurred_at::date = g.d::date
      group by g.d
    ) s
  );

  v_cost := v_cost || jsonb_build_object(
    'daily_cap_usd',   public.daily_spend_cap_usd(),
    'monthly_cap_usd', public.spend_cap_usd(),
    'tripwire',        public.tripwire_status()
  );

  -- credit runway, anchored on the operator-entered balance
  v_cost := v_cost || (
    select jsonb_build_object('credit', jsonb_build_object(
      'anchor_usd',  c.credit_balance_usd,
      'anchor_at',   c.credit_balance_as_of,
      'spent_since', round(coalesce((
        select sum(usd_cost) from public.spend_ledger
        where occurred_at >= c.credit_balance_as_of), 0), 4),
      'remaining_usd', round(c.credit_balance_usd - coalesce((
        select sum(usd_cost) from public.spend_ledger
        where occurred_at >= c.credit_balance_as_of), 0), 2)
    ))
    from public.admin_config c where c.id
  );

  -- ---------- cron health ----------
  -- pg_cron's history lives outside the public schema and may not be
  -- readable depending on how the function owner is configured. Degrade to
  -- null rather than failing the whole capture.
  begin
    select coalesce(jsonb_agg(jsonb_build_object(
      'job', jobname, 'active', active, 'schedule', schedule,
      'last_run', last_run, 'last_status', last_status)), '[]'::jsonb)
    into v_cron
    from (
      select j.jobname, j.active, j.schedule,
             (select max(d.end_time) from cron.job_run_details d where d.jobid = j.jobid) as last_run,
             (select d.status from cron.job_run_details d where d.jobid = j.jobid
              order by d.end_time desc nulls last limit 1) as last_status
      from cron.job j
    ) s;
  exception when others then
    v_cron := 'null'::jsonb;
  end;

  return jsonb_build_object(
    'captured_at', now(),
    'users',    v_users,
    'funnel',   v_funnel,
    'engage',   v_engage,
    'content',  v_content,
    'pool',     v_pool,
    'failures', v_fail,
    'cost',     v_cost,
    'cron',     v_cron
  );
end;
$fn$;

revoke all on function public.build_admin_snapshot() from public, anon, authenticated;

-- ------------------------------------------------------------
-- 5. Capture — idempotent, so a manual re-run just refreshes today
-- ------------------------------------------------------------
create or replace function public.capture_admin_snapshot()
returns void
language sql
security definer
set search_path = public, extensions
as $$
  insert into public.admin_snapshot (captured_on, captured_at, payload)
  values (current_date, now(), public.build_admin_snapshot())
  on conflict (captured_on) do update
    set captured_at = excluded.captured_at,
        payload     = excluded.payload;
$$;

revoke all on function public.capture_admin_snapshot() from public, anon, authenticated;

-- ------------------------------------------------------------
-- 6. Schedule
--
-- 18:35 UTC = 04:35 AEST / 05:35 AEDT — after ponder-idle-pause (03:10 UTC)
-- and off the :00 and :35 marks the generation and pool jobs already use, so
-- a slow snapshot never sits in front of generation.
-- ------------------------------------------------------------
select cron.unschedule('ponder-admin-snapshot')
where exists (select 1 from cron.job where jobname = 'ponder-admin-snapshot');

select cron.schedule(
  'ponder-admin-snapshot',
  '35 18 * * *',
  $$ select public.capture_admin_snapshot(); $$
);

-- Seed one immediately so the dashboard is not blank on day one.
select public.capture_admin_snapshot();

-- ------------------------------------------------------------
-- Verify
--
--   -- 1. make yourself an operator (replace with your own uuid):
--   insert into public.admin_users (user_id, note)
--   select id, 'antonio' from auth.users where email = 'antonio.ramos.jr@gmail.com'
--   on conflict do nothing;
--
--   -- 2. anchor the Anthropic credit balance:
--   update public.admin_config
--      set credit_balance_usd = 50.00, credit_balance_as_of = now(), updated_at = now();
--
--   -- 3. read it back:
--   select captured_on, jsonb_pretty(payload) from public.admin_snapshot
--   order by captured_on desc limit 1;
--
--   select * from cron.job where jobname = 'ponder-admin-snapshot';
-- ------------------------------------------------------------
