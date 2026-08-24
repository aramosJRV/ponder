-- ============================================================
-- Ponder — remove every tier difference
--
-- ⚠️  SCHEMA CHANGE. Apply via `supabase db push`.
--
-- Support is a one-off contribution that unlocks NOTHING. Every user gets
-- the identical app whether they have ever given a cent or not.
--
-- This reverses the tier split introduced in 20260823000002. That migration
-- kept the old subscription alive as a "supporter tier" with perks — six
-- threads, unlimited synthesis, per-user entries, the song. Antonio's call
-- (23 Aug): that is still a paywall, just a politer one. It makes the ask
-- transactional, and it means a user who cannot pay gets a lesser app.
--
-- What is deliberately NOT removed: has_active_entitlement(), is_supporter(),
-- the subscriptions table and the RevenueCat webhook. They are now unused by
-- every code path, but dropping them is a separate, riskier change and
-- leaving them inert costs nothing.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Threads — one number for everybody
-- ------------------------------------------------------------
create or replace function public.max_active_topics()
returns integer
language sql
immutable
as $$ select 3; $$;

create or replace function public.max_active_topics(p_user_id uuid)
returns integer
language sql
immutable
as $$ select 3; $$;   -- p_user_id ignored on purpose: no tiers

-- ------------------------------------------------------------
-- 2. Idle auto-pause — one threshold for everybody
--
-- Back to 14 days. Seven was a free-tier squeeze, and with the pool serving
-- themed threads at no marginal cost there is nothing to squeeze for.
-- ------------------------------------------------------------
create or replace function public.idle_pause_days()
returns integer
language sql
immutable
as $$ select 14; $$;

create or replace function public.idle_pause_days(p_user_id uuid)
returns integer
language sql
immutable
as $$ select 14; $$;   -- p_user_id ignored on purpose: no tiers

-- ------------------------------------------------------------
-- 3. Synthesis — one rule for everybody
--
-- The two limits that remain are PRODUCT rules, not tier rules, and they
-- apply to every user identically:
--
--   * 5+ notes on the thread. A synthesis of two notes tells the user
--     nothing and teaches them the feature is noise.
--   * once per thread per 30 days. "What's emerging?" is a question about a
--     season, not a refresh button; re-running it daily produces near
--     identical output and devalues it.
--
-- Both would be worth keeping even if synthesis were free to run.
-- Conclusion syntheses remain exempt from both.
-- ------------------------------------------------------------
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
  v_user_id uuid;
  v_notes   integer;
  v_last    timestamptz;
begin
  select user_id into v_user_id from public.topics where id = p_topic_id;
  if v_user_id is null then
    return jsonb_build_object('allowed', false, 'reason', 'not_found');
  end if;

  -- Concluding a thread always gets its looking-back synthesis.
  if p_kind = 'conclusion' then
    return jsonb_build_object('allowed', true, 'reason', 'conclusion');
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

  return jsonb_build_object('allowed', true, 'reason', 'ok');
end;
$$;

revoke all on function public.synthesis_allowed(uuid, text) from public, anon;
grant execute on function public.synthesis_allowed(uuid, text) to authenticated;

-- ------------------------------------------------------------
-- Verify
--
--   select public.max_active_topics('<any uuid>');   -- 3, always
--   select public.idle_pause_days('<any uuid>');     -- 14, always
--   select public.synthesis_allowed('<topic>');      -- no 'supporter' reason
-- ------------------------------------------------------------
