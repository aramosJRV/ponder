-- ============================================================
-- Ponder — subscriptions & entitlement
--
-- Source of truth for "may this user cost us Claude tokens?".
--
-- The row is written ONLY by the rc-webhook edge function (service role).
-- Clients read their own row but can never write it — otherwise the paywall
-- is a single PATCH away from being free.
--
-- ⚠️  Schema change. Apply via `supabase db push` or the dashboard SQL
--     editor, not ad hoc.
--
-- Design notes:
--   * The 7-day free trial is a STORE-level introductory offer (App Store
--     Connect / Play Console), not app logic. RevenueCat reports it as
--     period_type = 'TRIAL' with a real expires_at, so trial and paid are
--     the same check here — there is no separate trial clock to drift.
--   * expires_at is the entitlement expiry RevenueCat computes, which
--     already includes billing grace period. Null = non-expiring (lifetime
--     or promotional grant).
--   * SANDBOX rows are honoured deliberately: TestFlight and Play internal
--     testing both report SANDBOX, and gating them off makes the paid build
--     untestable. environment is stored so production reporting can filter.
-- ============================================================

-- ------------------------------------------------------------
-- subscriptions — one row per user, upserted from RevenueCat events
-- ------------------------------------------------------------
create table public.subscriptions (
  user_id uuid primary key references auth.users (id) on delete cascade,

  -- RevenueCat identity. Equals user_id for our app (we set the RC app user
  -- id explicitly at login) but is stored so anonymous-RC-id aliases and
  -- TRANSFER events remain traceable.
  rc_app_user_id text not null,
  entitlement_id text not null default 'pro',

  product_id  text,
  store       text,                    -- APP_STORE | PLAY_STORE | PROMOTIONAL | STRIPE
  period_type text,                    -- TRIAL | INTRO | NORMAL
  environment text not null default 'PRODUCTION'
    check (environment in ('PRODUCTION', 'SANDBOX')),

  purchased_at timestamptz,
  -- null = never expires. Includes RevenueCat's billing grace period.
  expires_at   timestamptz,

  -- Set when the user turns off auto-renew, cleared on resubscribe. The
  -- entitlement stays live until expires_at; this only drives UI copy.
  unsubscribe_detected_at   timestamptz,
  billing_issue_detected_at timestamptz,

  -- Idempotency / out-of-order protection. RevenueCat retries webhooks and
  -- does not guarantee ordering, so a stale retry must not resurrect an
  -- expired subscription.
  last_event_id text,
  last_event_at timestamptz not null default now(),

  raw jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index subscriptions_expires_idx on public.subscriptions (expires_at);
create index subscriptions_rc_app_user_idx on public.subscriptions (rc_app_user_id);

alter table public.subscriptions enable row level security;

-- Read own row only. No insert/update/delete policy exists, so the client
-- cannot write here at all — the service role bypasses RLS for the webhook.
create policy "subscriptions_select_own" on public.subscriptions
  for select using (auth.uid() = user_id);

-- ------------------------------------------------------------
-- has_active_entitlement — the single gate
--
-- Used by: the nightly cron, generate-entry, synthesize. Everything that
-- spends Claude tokens goes through this. security definer so it can be
-- called from an RLS-restricted context and still see the row.
-- ------------------------------------------------------------
create or replace function public.has_active_entitlement(p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.subscriptions s
    where s.user_id = p_user_id
      and (s.expires_at is null or s.expires_at > now())
  );
$$;

revoke all on function public.has_active_entitlement(uuid) from public, anon;
grant execute on function public.has_active_entitlement(uuid) to authenticated;

-- Convenience for the client: "am I entitled?" without passing an id.
create or replace function public.my_entitlement()
returns table (
  entitled boolean,
  expires_at timestamptz,
  period_type text,
  store text,
  unsubscribe_detected_at timestamptz,
  billing_issue_detected_at timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  select
    (s.expires_at is null or s.expires_at > now()) as entitled,
    s.expires_at,
    s.period_type,
    s.store,
    s.unsubscribe_detected_at,
    s.billing_issue_detected_at
  from public.subscriptions s
  where s.user_id = auth.uid();
$$;

revoke all on function public.my_entitlement() from public, anon;
grant execute on function public.my_entitlement() to authenticated;

-- ------------------------------------------------------------
-- entitled_due_users — who the nightly job should generate for
--
-- Replaces the old "generate for everyone whenever anyone is due" behaviour.
-- That was tolerable when generation was free; it is not now. Returns users
-- whose LOCAL hour equals their notification_hour AND who are entitled.
-- ------------------------------------------------------------
create or replace function public.entitled_due_users()
returns setof uuid
language sql
stable
security definer
set search_path = public
as $$
  select p.id
  from public.profiles p
  where extract(hour from (now() at time zone p.timezone))::int = p.notification_hour
    and public.has_active_entitlement(p.id);
$$;

revoke all on function public.entitled_due_users() from public, anon, authenticated;

-- ------------------------------------------------------------
-- Active thread cap
--
-- The paid tier allows 2 concurrent active threads. This is a cost ceiling,
-- not a UX preference: each active thread is ~365 generations/year and the
-- annual price only covers about two of them.
--
-- Enforced here rather than in the client because the client is not a
-- security boundary and topics are directly insertable under RLS.
--
-- Only fires when a row is ADDED to the active set (insert-as-active, or an
-- update transitioning into active), so an account that is already over the
-- cap — e.g. seeded before this migration — can still be edited and paused
-- back down rather than being frozen.
-- ------------------------------------------------------------
create or replace function public.max_active_topics()
returns integer
language sql
immutable
as $$ select 2; $$;

create or replace function public.guard_active_topic_cap()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer;
  v_max   integer := public.max_active_topics();
begin
  -- Only care about transitions INTO the active set.
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

create trigger topics_guard_active_cap
  before insert or update on public.topics
  for each row execute function public.guard_active_topic_cap();

-- ------------------------------------------------------------
-- updated_at maintenance
-- ------------------------------------------------------------
create or replace function public.touch_subscriptions_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger subscriptions_touch_updated_at
  before update on public.subscriptions
  for each row execute function public.touch_subscriptions_updated_at();

-- ============================================================
-- Verify:
--   select public.has_active_entitlement('<uuid>');
--   select * from public.entitled_due_users();
--   -- cap: third active thread must fail
--   insert into public.topics (user_id, title) values ('<uuid>', 'three');
-- ============================================================
