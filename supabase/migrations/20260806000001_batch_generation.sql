-- ============================================================
-- Ponder — batched generation, idle auto-pause, 3-thread cap
--
-- ⚠️  SCHEMA CHANGE. Apply via `supabase db push` or the dashboard SQL
--     editor. Adds two tables and one column; changes two functions.
--
-- Why all three land together: they are one economic change.
--
--   At US$9.99/yr (net ~US$8.49 after Apple's 15%), three active threads
--   cost $9.03/yr on the current synchronous Sonnet+Haiku mix — underwater.
--   The Batch API halves that to $4.52, and idle auto-pause means we only
--   pay for threads someone is actually reading. Together the cap can go to
--   3 with room to spare; without them it cannot.
--
-- The split that matters:
--
--   * CRON generation is batched. Nobody is waiting on it, it is high
--     volume, and the Batch API is 50% cheaper.
--   * ON-DEMAND generation (new thread, missing entry) stays synchronous.
--     Someone IS waiting, the volume is tiny, and latency matters more than
--     half a cent.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Thread cap 2 -> 3
--
-- Two was a cost ceiling, and a tight one for an app whose whole pitch is
-- following several threads at once and noticing the pattern between them.
-- The cross-thread verse-avoidance window (60 days) only really earns its
-- keep at three.
-- ------------------------------------------------------------
create or replace function public.max_active_topics()
returns integer
language sql
immutable
as $$ select 3; $$;

-- ------------------------------------------------------------
-- 2. Idle auto-pause
--
-- Cost is driven by threads being ACTIVE, not by anyone showing up. A
-- subscriber who stops opening Ponder but leaves three threads running costs
-- ~$4.52/year generating entries nobody reads — and comes back to a wall of
-- unread entries, which is its own reason not to return.
--
-- Pausing is reversible and non-destructive: nothing is deleted, the thread
-- keeps every entry and note, and the user can resume it in one tap.
-- ------------------------------------------------------------
alter table public.profiles
  add column if not exists last_opened_at timestamptz not null default now();

-- Days of no app opens before active threads are paused. 14 is deliberately
-- generous: a fortnight away is a holiday, not abandonment, and we would
-- rather pay two weeks of tokens than pause on someone who is coming back.
create or replace function public.idle_pause_days()
returns integer
language sql
immutable
as $$ select 14; $$;

create or replace function public.pause_idle_threads()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_paused integer;
begin
  with idle as (
    select t.id
    from public.topics t
    join public.profiles p on p.id = t.user_id
    where t.status = 'active'
      and p.last_opened_at < now() - (public.idle_pause_days() || ' days')::interval
  )
  update public.topics t
     set status = 'paused'
    from idle
   where t.id = idle.id;

  get diagnostics v_paused = row_count;
  return v_paused;
end;
$$;

revoke all on function public.pause_idle_threads() from public, anon, authenticated;

-- Let the client record an app open without granting it write access to the
-- rest of the profile row.
create or replace function public.touch_last_opened()
returns void
language sql
security definer
set search_path = public
as $$
  update public.profiles set last_opened_at = now() where id = auth.uid();
$$;

grant execute on function public.touch_last_opened() to authenticated;

-- ------------------------------------------------------------
-- 3. Batch bookkeeping
--
-- The Anthropic Batches API is asynchronous: submit many requests, poll,
-- then collect results. That means the mapping from a batch request back to
-- "which thread, which day, which entry type" has to survive between two
-- separate function invocations, so it lives here rather than in memory.
-- ------------------------------------------------------------
create table public.generation_batches (
  id uuid primary key default gen_random_uuid(),
  -- Anthropic's batch id (msgbatch_...). Unique so a double submit is caught.
  provider_batch_id text not null unique,
  status text not null default 'submitted'
    check (status in ('submitted', 'collected', 'failed', 'expired')),
  request_count integer not null default 0,
  inserted_count integer not null default 0,
  submitted_at timestamptz not null default now(),
  collected_at timestamptz,
  detail jsonb not null default '{}'
);

create index generation_batches_status_idx
  on public.generation_batches (status, submitted_at);

create table public.generation_batch_items (
  batch_id uuid not null references public.generation_batches (id) on delete cascade,
  -- Matches the custom_id sent to Anthropic. Deterministic: topic + date.
  custom_id text not null,
  topic_id uuid not null references public.topics (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  date date not null,
  entry_type entry_type not null,
  status text not null default 'pending'
    check (status in ('pending', 'inserted', 'exists', 'failed')),
  detail jsonb not null default '{}',
  primary key (batch_id, custom_id)
);

create index generation_batch_items_topic_idx
  on public.generation_batch_items (topic_id, date);

alter table public.generation_batches      enable row level security;
alter table public.generation_batch_items  enable row level security;

-- Operational tables. No client policies at all: only the service role (the
-- edge function) touches these, and users have no reason to see them.
-- RLS enabled with zero policies = deny all for anon/authenticated.

-- ------------------------------------------------------------
-- 4. Cron: submit ahead of the notification hour, collect continuously
--
-- Batches usually return in minutes but are only guaranteed within 24h, so
-- submitting AT the notification hour would risk the day's entry landing
-- after the notification that announces it. We submit BATCH_LEAD_HOURS
-- early and collect on a tight loop.
-- ------------------------------------------------------------
create or replace function public.batch_lead_hours()
returns integer
language sql
immutable
as $$ select 2; $$;

-- Users whose local time is now at (notification_hour - lead) and who are
-- entitled. Replaces entitled_due_users() for the batch path; the old
-- function is kept because the fallback synchronous path still uses it.
create or replace function public.entitled_prep_users()
returns setof uuid
language sql
stable
security definer
set search_path = public
as $$
  select p.id
  from public.profiles p
  where extract(hour from (now() at time zone p.timezone))::int
        = ((p.notification_hour - public.batch_lead_hours() + 24) % 24)
    and public.has_active_entitlement(p.id);
$$;

revoke all on function public.entitled_prep_users() from public, anon, authenticated;

-- Generic vault-backed POST to a Ponder edge function.
create or replace function public.call_edge_function(
  p_secret_name text,
  p_body jsonb
)
returns void
language plpgsql
security definer
set search_path = public, extensions, vault
as $$
declare
  v_url text;
  v_key text;
begin
  select decrypted_secret into v_url
  from vault.decrypted_secrets where name = p_secret_name;
  select decrypted_secret into v_key
  from vault.decrypted_secrets where name = 'generate_entry_service_key';

  if v_url is null or v_key is null then
    raise warning 'call_edge_function: missing Vault secret % or service key', p_secret_name;
    return;
  end if;

  perform net.http_post(
    url     := v_url,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || v_key
    ),
    body    := p_body,
    timeout_milliseconds := 120000
  );
end;
$$;

revoke all on function public.call_edge_function(text, jsonb) from public, anon, authenticated;

-- Hourly: submit tomorrow's batch for everyone entering their lead window.
create or replace function public.run_daily_generation()
returns void
language plpgsql
security definer
set search_path = public, extensions, vault
as $$
declare
  v_users uuid[];
begin
  select coalesce(array_agg(u), '{}')
  into v_users
  from public.entitled_prep_users() as u;

  if array_length(v_users, 1) is null then
    return;
  end if;

  perform public.call_edge_function(
    'generate_entry_url',
    jsonb_build_object('mode', 'batch_submit', 'user_ids', to_jsonb(v_users))
  );
end;
$$;

revoke all on function public.run_daily_generation() from public, authenticated, anon;

-- Every 10 minutes: collect anything that has finished, and pause idle
-- threads once a day's worth of ticks have gone by (the function is cheap
-- and idempotent, so running it often costs nothing).
create or replace function public.run_batch_collection()
returns void
language plpgsql
security definer
set search_path = public, extensions, vault
as $$
begin
  if not exists (
    select 1 from public.generation_batches where status = 'submitted'
  ) then
    return;
  end if;

  perform public.call_edge_function(
    'generate_entry_url',
    jsonb_build_object('mode', 'batch_collect')
  );
end;
$$;

revoke all on function public.run_batch_collection() from public, authenticated, anon;

-- ------------------------------------------------------------
-- 5. Schedules
-- ------------------------------------------------------------
do $$
begin
  perform cron.unschedule('ponder-batch-collect');
exception when others then null;
end;
$$;

do $$
begin
  perform cron.unschedule('ponder-idle-pause');
exception when others then null;
end;
$$;

select cron.schedule(
  'ponder-batch-collect',
  '*/10 * * * *',
  $$ select public.run_batch_collection(); $$
);

-- Daily at 03:10 UTC. Timezone-agnostic on purpose: the threshold is 14 days,
-- so the hour it runs is immaterial.
select cron.schedule(
  'ponder-idle-pause',
  '10 3 * * *',
  $$ select public.pause_idle_threads(); $$
);

-- ============================================================
-- Setup note — one new Vault secret is NOT needed; batch submit and collect
-- both post to the existing generate_entry_url with a different `mode`.
--
-- Verify:
--   select public.max_active_topics();          -- 3
--   select * from public.entitled_prep_users(); -- who submits this hour
--   select public.pause_idle_threads();         -- returns rows paused
--   select * from public.generation_batches order by submitted_at desc;
--   select status, count(*) from public.generation_batch_items group by 1;
-- ============================================================
