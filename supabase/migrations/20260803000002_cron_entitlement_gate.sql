-- ============================================================
-- Ponder — gate nightly generation on an active entitlement
--
-- Supersedes the body of run_daily_generation() from
-- 20260713000001_pg_cron_daily_generation.sql. The schedule itself is
-- unchanged (hourly, same job name), so this migration only replaces the
-- function.
--
-- Two problems fixed, both of which now cost real money:
--
--   1. No entitlement check. The job generated for every active topic
--      regardless of subscription state, so a churned user with 2 threads
--      kept costing ~$12/year of Claude tokens forever.
--
--   2. "Anyone due => everyone generates". The old body checked whether ANY
--      user was at their notification hour and then called the edge function
--      with an empty body, which generated for ALL active topics. With one
--      user that was a no-op; with many it means every user's entries are
--      generated at the first due user's hour, and 24x the intended
--      trigger surface.
--
-- Now the job resolves the exact set of due AND entitled users and passes
-- them to the edge function, which filters its topic query accordingly.
-- ============================================================

create or replace function public.run_daily_generation()
returns void
language plpgsql
security definer
set search_path = public, extensions, vault
as $$
declare
  v_url   text;
  v_key   text;
  v_users uuid[];
begin
  -- Users whose local time is right now at their notification_hour AND who
  -- have a live subscription or trial. Empty => nothing to do this hour.
  select coalesce(array_agg(u), '{}')
  into v_users
  from public.entitled_due_users() as u;

  if array_length(v_users, 1) is null then
    return;
  end if;

  select decrypted_secret into v_url
  from vault.decrypted_secrets where name = 'generate_entry_url';
  select decrypted_secret into v_key
  from vault.decrypted_secrets where name = 'generate_entry_service_key';

  if v_url is null or v_key is null then
    raise warning 'run_daily_generation: missing Vault secrets, skipping';
    return;
  end if;

  perform net.http_post(
    url     := v_url,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || v_key
    ),
    -- Cron path, explicitly scoped. generate-entry treats a user_ids array
    -- as "these users only"; it still re-checks entitlement itself, so a
    -- stale id here cannot spend tokens.
    body    := jsonb_build_object('user_ids', to_jsonb(v_users)),
    timeout_milliseconds := 120000
  );
end;
$$;

revoke all on function public.run_daily_generation() from public, authenticated, anon;

-- ============================================================
-- Verify:
--   select * from public.entitled_due_users();   -- who would run right now
--   select public.run_daily_generation();        -- manual trigger
--   select * from net._http_response order by created desc limit 5;
-- ============================================================
