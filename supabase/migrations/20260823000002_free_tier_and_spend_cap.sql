-- ============================================================
-- Ponder — free tier, supporter tier, and a hard spend ceiling
--
-- ⚠️  SCHEMA CHANGE. Apply via `supabase db push` or the dashboard SQL
--     editor. Adds one table and several functions; changes four.
--
-- Ponder is now FREE. The subscription becomes a voluntary supporter tier.
-- That inverts the economics: revenue no longer scales with cost, so cost has
-- to be bounded in code rather than by a paywall.
--
-- Three things land together because they are one change:
--
--   1. spend_ledger + a runaway TRIPWIRE. Every Anthropic call records what
--      it cost. The thresholds are NOT a budget — Antonio funds Ponder by
--      auto-reload and the user experience must never change because of
--      money. They sit far above anything real usage reaches, so crossing one
--      means a BUG (a retry loop, a resubmitting batch, a prompt that always
--      fails validation and escalates), not popularity. Crossing one halts
--      the automated nightly job only and leaves every user-facing path
--      running.
--
--   2. The entitlement gate on generation is REMOVED. has_active_entitlement()
--      survives — it now answers "is this a supporter?", not "may this user
--      use the app?". Nothing is locked behind it; supporters get more of
--      what already exists.
--
--   3. Tier-aware caps. Free: 3 threads, idle-pause at 7 days, metered
--      synthesis. Supporter: 6 threads, idle-pause at 14 days, unlimited
--      synthesis.
--
-- Deliberate: the no-arg max_active_topics() and idle_pause_days() are kept
-- and return the FREE values, so anything still calling them fails safe
-- (cheap) rather than open (expensive).
-- ============================================================

-- ------------------------------------------------------------
-- 1. Supporter — a rename of intent, not of mechanism
--
-- has_active_entitlement() is unchanged and still the source of truth. This
-- alias exists so call sites read as what they now mean. Using the old name
-- for a voluntary tier would keep implying a gate that no longer exists.
-- ------------------------------------------------------------
create or replace function public.is_supporter(p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$ select public.has_active_entitlement(p_user_id); $$;

revoke all on function public.is_supporter(uuid) from public, anon;
grant execute on function public.is_supporter(uuid) to authenticated;

-- ------------------------------------------------------------
-- 2. Spend ledger
--
-- Written from the `usage` block of every Anthropic response — never an
-- estimate. This is the first time Ponder will know what it actually costs
-- rather than what a spreadsheet guessed.
-- ------------------------------------------------------------
create table if not exists public.spend_ledger (
  id             uuid primary key default gen_random_uuid(),
  occurred_at    timestamptz not null default now(),
  -- 'entry' | 'synthesis' | 'classify' | 'pool_build'
  kind           text not null,
  model          text not null,
  input_tokens        integer not null default 0,
  output_tokens       integer not null default 0,
  cache_read_tokens   integer not null default 0,
  cache_write_tokens  integer not null default 0,
  usd_cost       numeric(12,6) not null default 0,
  -- Nullable: pool_build and other non-user-attributable spend has no owner.
  user_id        uuid references auth.users (id) on delete set null,
  detail         jsonb not null default '{}'
);

create index if not exists spend_ledger_occurred_idx
  on public.spend_ledger (occurred_at desc);
create index if not exists spend_ledger_kind_idx
  on public.spend_ledger (kind, occurred_at desc);

-- Operational table. RLS on with zero policies = deny all for anon and
-- authenticated; only the service role (the edge functions) writes here.
alter table public.spend_ledger enable row level security;

-- ------------------------------------------------------------
-- 3. The tripwire
--
-- These are NOT budgets. Ponder is funded by Console auto-reload and the user
-- experience must never change because of money. Both numbers sit far above
-- anything a real user base reaches in the next year — normal spend is cents
-- a day — so crossing one means something in this repo is misbehaving.
--
-- The daily number is the better detector. A runaway loop shows up within
-- hours; a monthly ceiling only notices after the money is already gone.
--
-- Deliberately functions and not config rows: changing a safety threshold
-- should be a reviewed migration, not an UPDATE somebody runs at 1am.
-- ------------------------------------------------------------
create or replace function public.spend_cap_usd()
returns numeric
language sql
immutable
as $$ select 150.0::numeric; $$;   -- monthly tripwire

create or replace function public.daily_spend_cap_usd()
returns numeric
language sql
immutable
as $$ select 15.0::numeric; $$;    -- daily tripwire — the real runaway detector

create or replace function public.month_to_date_spend_usd()
returns numeric
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(sum(usd_cost), 0)::numeric
  from public.spend_ledger
  where occurred_at >= date_trunc('month', now());
$$;

create or replace function public.today_spend_usd()
returns numeric
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(sum(usd_cost), 0)::numeric
  from public.spend_ledger
  where occurred_at >= date_trunc('day', now());
$$;

revoke all on function public.month_to_date_spend_usd() from public, anon, authenticated;
revoke all on function public.today_spend_usd() from public, anon, authenticated;

-- The tripwire check. CRON AND BATCH ONLY.
--
-- Nothing a user does is gated by this, deliberately. A person tapping a
-- button is rate-limited by being a person; the runaway risk lives entirely
-- in the automated path, which is also the only path that can loop unattended
-- at 3am while auto-reload quietly funds it.
--
-- Fails CLOSED on error: if we cannot tell what we have spent, we do not
-- start a batch. That costs at most one night of pre-generation, and the pool
-- covers the user-facing consequence.
create or replace function public.generation_allowed()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.month_to_date_spend_usd() < public.spend_cap_usd()
     and public.today_spend_usd()        < public.daily_spend_cap_usd();
$$;

-- NOT granted to authenticated. The client never asks and never gates on it.
revoke all on function public.generation_allowed() from public, anon, authenticated;

-- Why the tripwire fired, for the alert. Operator only.
create or replace function public.tripwire_status()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'today_usd',      public.today_spend_usd(),
    'daily_cap_usd',  public.daily_spend_cap_usd(),
    'month_usd',      public.month_to_date_spend_usd(),
    'monthly_cap_usd', public.spend_cap_usd(),
    'tripped_daily',   public.today_spend_usd()        >= public.daily_spend_cap_usd(),
    'tripped_monthly', public.month_to_date_spend_usd() >= public.spend_cap_usd()
  );
$$;

revoke all on function public.tripwire_status() from public, anon, authenticated;

-- Operator convenience for eyeballing the month from the SQL editor.
--
-- NOT granted to authenticated, deliberately. Nothing in the app shows a user
-- what Ponder costs to run: at low volume an honest figure reads as "nobody
-- uses this" rather than "this is expensive", and anonymous accounts are free
-- to mint, so a grant to authenticated is a grant to the public.
create or replace function public.spend_status()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'month_to_date_usd', public.month_to_date_spend_usd(),
    'cap_usd',           public.spend_cap_usd(),
    'allowed',           public.generation_allowed()
  );
$$;

revoke all on function public.spend_status() from public, anon, authenticated;

-- Service-role writer. Kept as a function so the edge functions do not need
-- insert grants on the table itself.
create or replace function public.record_spend(
  p_kind text,
  p_model text,
  p_input_tokens integer,
  p_output_tokens integer,
  p_cache_read_tokens integer,
  p_cache_write_tokens integer,
  p_usd_cost numeric,
  p_user_id uuid default null,
  p_detail jsonb default '{}'::jsonb
)
returns void
language sql
security definer
set search_path = public
as $$
  insert into public.spend_ledger (
    kind, model, input_tokens, output_tokens,
    cache_read_tokens, cache_write_tokens, usd_cost, user_id, detail
  )
  values (
    p_kind, p_model, coalesce(p_input_tokens, 0), coalesce(p_output_tokens, 0),
    coalesce(p_cache_read_tokens, 0), coalesce(p_cache_write_tokens, 0),
    coalesce(p_usd_cost, 0), p_user_id, coalesce(p_detail, '{}'::jsonb)
  );
$$;

revoke all on function public.record_spend(
  text, text, integer, integer, integer, integer, numeric, uuid, jsonb
) from public, anon, authenticated;

-- ------------------------------------------------------------
-- 4. Thread cap — 3 free, 6 supporter
--
-- 3 stays the free cap deliberately. Multiple threads in parallel is the
-- whole pitch of the app; putting it behind the supporter tier would gate the
-- core promise. 6 is a convenience, not the product.
-- ------------------------------------------------------------
create or replace function public.max_active_topics()
returns integer
language sql
immutable
as $$ select 3; $$;   -- free tier; kept so old call sites fail cheap, not open

create or replace function public.max_active_topics(p_user_id uuid)
returns integer
language sql
stable
security definer
set search_path = public
as $$ select case when public.is_supporter(p_user_id) then 6 else 3 end; $$;

revoke all on function public.max_active_topics(uuid) from public, anon;
grant execute on function public.max_active_topics(uuid) to authenticated;

create or replace function public.guard_active_topic_cap()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer;
  v_max   integer := public.max_active_topics(new.user_id);
begin
  if new.status <> 'active' then
    return new;
  end if;
  if tg_op = 'UPDATE' and old.status = 'active' then
    return new;
  end if;

  select count(*) into v_count
  from public.topics t
  where t.user_id = new.user_id
    and t.status = 'active'
    and t.id <> new.id;

  if v_count >= v_max then
    raise exception
      'Thread limit reached: % active threads allowed. Pause or conclude one first.', v_max
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

-- ------------------------------------------------------------
-- 5. Idle auto-pause — 7 days free, 14 supporter
--
-- 14 was generous when every user was paying. On a free tier the abandoned
-- tail is most of the install base, so 7 halves the cost of users who never
-- come back while still treating a week away as a week away, not abandonment.
-- Supporters keep 14: they are funding the thing.
-- ------------------------------------------------------------
create or replace function public.idle_pause_days()
returns integer
language sql
immutable
as $$ select 7; $$;   -- free tier

create or replace function public.idle_pause_days(p_user_id uuid)
returns integer
language sql
stable
security definer
set search_path = public
as $$ select case when public.is_supporter(p_user_id) then 14 else 7 end; $$;

revoke all on function public.idle_pause_days(uuid) from public, anon, authenticated;

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
      and p.last_opened_at
          < now() - (public.idle_pause_days(t.user_id) || ' days')::interval
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

-- ------------------------------------------------------------
-- 6. Who the nightly job generates for
--
-- Was: due AND entitled. Now: due AND the ceiling is intact. The entitlement
-- term is gone — that was the paywall.
--
-- entitled_prep_users() / entitled_due_users() are left in place but are no
-- longer called by anything; dropping them would break a running cron mid-
-- deploy if the function deploy and the migration land out of order.
-- ------------------------------------------------------------
create or replace function public.due_prep_users()
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
    and public.generation_allowed();
$$;

revoke all on function public.due_prep_users() from public, anon, authenticated;

create or replace function public.due_users()
returns setof uuid
language sql
stable
security definer
set search_path = public
as $$
  select p.id
  from public.profiles p
  where extract(hour from (now() at time zone p.timezone))::int = p.notification_hour
    and public.generation_allowed();
$$;

revoke all on function public.due_users() from public, anon, authenticated;

create or replace function public.run_daily_generation()
returns void
language plpgsql
security definer
set search_path = public, extensions, vault
as $$
declare
  v_users uuid[];
begin
  -- Cheap guard first. If the tripwire has fired, something is wrong in the
  -- generation code — this is not an expected state. Log it loudly and record
  -- it where it can be alerted on; users are unaffected because the pool
  -- serves the day (see migration 20260823000003).
  if not public.generation_allowed() then
    raise warning 'run_daily_generation: TRIPWIRE FIRED %', public.tripwire_status();
    insert into public.generation_failures (stage, detail)
    values ('spend_tripwire', public.tripwire_status());
    return;
  end if;

  select coalesce(array_agg(u), '{}')
  into v_users
  from public.due_prep_users() as u;

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

-- ------------------------------------------------------------
-- 7. Synthesis metering
--
-- Synthesis is the most expensive single call in the app — it ships every
-- entry and every note for a thread — and it is user-triggered, so on a free
-- tier it is the one thing that can run away.
--
-- Free: one per thread per 30 days, and only once the thread has 5+ notes.
-- The note floor is a product rule as much as a cost one: a synthesis of two
-- notes tells the user nothing and teaches them the feature is noise.
--
-- Supporter: unlimited, subject only to the global ceiling.
-- ------------------------------------------------------------
create or replace function public.min_notes_for_synthesis()
returns integer
language sql
immutable
as $$ select 5; $$;

create or replace function public.free_synthesis_interval()
returns interval
language sql
immutable
as $$ select '30 days'::interval; $$;

-- Returns { allowed: bool, reason: text, notes: int, next_available_at: ts }
--
-- p_kind matters: concluding a thread generates a "looking back" synthesis,
-- and that one is FREE FOR EVERYONE, exempt from both the note floor and the
-- monthly limit. Concluding is the emotional payoff of the whole app and the
-- last thing a user does on a thread — metering it would mean someone who
-- finished a thread in week three gets a blank ending. Only the global spend
-- ceiling applies to it.
create or replace function public.synthesis_allowed(
  p_topic_id uuid,
  p_kind text default 'on_demand'
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_user_id   uuid;
  v_notes     integer;
  v_last      timestamptz;
  v_supporter boolean;
begin
  select user_id into v_user_id from public.topics where id = p_topic_id;
  if v_user_id is null then
    return jsonb_build_object('allowed', false, 'reason', 'not_found');
  end if;

  -- Deliberately NOT gated on the spend tripwire. Synthesis is user-
  -- triggered, so it is rate-limited by a human pressing a button, and the
  -- quota below already bounds it. Gating it would make the user experience
  -- change because of money, which is exactly what this app must never do.
  if p_kind = 'conclusion' then
    return jsonb_build_object('allowed', true, 'reason', 'conclusion');
  end if;

  v_supporter := public.is_supporter(v_user_id);
  if v_supporter then
    return jsonb_build_object('allowed', true, 'reason', 'supporter');
  end if;

  select count(*) into v_notes
  from public.notes where topic_id = p_topic_id;

  if v_notes < public.min_notes_for_synthesis() then
    return jsonb_build_object(
      'allowed', false,
      'reason',  'too_few_notes',
      'notes',   v_notes,
      'needed',  public.min_notes_for_synthesis()
    );
  end if;

  select max(created_at) into v_last
  from public.syntheses where topic_id = p_topic_id;

  if v_last is not null
     and v_last > now() - public.free_synthesis_interval() then
    return jsonb_build_object(
      'allowed', false,
      'reason',  'rate_limited',
      'next_available_at', to_jsonb(v_last + public.free_synthesis_interval())
    );
  end if;

  return jsonb_build_object('allowed', true, 'reason', 'free_quota');
end;
$$;

revoke all on function public.synthesis_allowed(uuid, text) from public, anon;
grant execute on function public.synthesis_allowed(uuid, text) to authenticated;

-- An older single-argument version may exist from a partial apply. Drop it so
-- there is exactly one resolution and a caller cannot silently get the version
-- without the conclusion exemption.
drop function if exists public.synthesis_allowed(uuid);

-- ------------------------------------------------------------
-- Verify
--
--   select public.spend_status();
--   select public.tripwire_status();
--   select public.generation_allowed();                -- true unless a bug
--   select public.max_active_topics('<uuid>');         -- 3, or 6 for supporters
--   select public.idle_pause_days('<uuid>');           -- 7, or 14
--   select public.synthesis_allowed('<topic uuid>');               -- on_demand
--   select public.synthesis_allowed('<topic uuid>', 'conclusion'); -- always ok
--   select * from public.due_prep_users();             -- who submits this hour
--
--   select kind, count(*), round(sum(usd_cost), 4) as usd
--   from public.spend_ledger
--   where occurred_at >= date_trunc('month', now())
--   group by kind order by usd desc;
-- ------------------------------------------------------------
