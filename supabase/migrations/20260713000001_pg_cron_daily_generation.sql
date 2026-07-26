-- ============================================================
-- Promptings — nightly content generation via pg_cron + pg_net
--
-- Schedules the generate-entry edge function to run for every active topic
-- that is missing today's entry, at each user's local notification hour.
--
-- ⚠️  REVIEW / APPROVAL REQUIRED BEFORE APPLYING.
--     This is a schema + extension change. Apply it through the Supabase
--     dashboard SQL editor (or `supabase db push`), NOT by editing the DB
--     ad hoc. It also depends on two Vault secrets (see step 2 below).
--
-- Design notes:
--   * pg_cron schedules run in the DATABASE timezone (UTC). Per-user local
--     hours can't be expressed as a single cron expression, so we run HOURLY
--     and, inside the job, only make the HTTP call when the current UTC hour
--     equals some user's notification_hour in their own timezone.
--   * The edge function's cron path (empty body) generates for ALL active
--     topics missing today's entry and is idempotent — unique(topic_id, date)
--     plus the "missing today" check mean re-runs never duplicate.
--   * Secrets (function URL + service key) are read from Vault at call time,
--     never hardcoded, so nothing secret lands in git.
--
--   Productization gap (multi-user): the edge function currently has no
--   per-user filter, so the hourly job generates for every user whenever ANY
--   user is due. Fine for the single-user tool; when multi-user, add a
--   user_id param to generate-entry and loop per due-user here.
-- ============================================================

-- ------------------------------------------------------------
-- Step 1 — extensions (Supabase: also enable via Dashboard → Database →
-- Extensions if these CREATE statements are not permitted in your project).
-- ------------------------------------------------------------
create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;

-- ------------------------------------------------------------
-- Step 2 — Vault secrets (run ONCE, e.g. in the SQL editor; do NOT commit
-- real values). Replace the placeholders with your values:
--
--   select vault.create_secret(
--     'https://rkslrbcbncecekghwbap.supabase.co/functions/v1/generate-entry',
--     'generate_entry_url');
--   select vault.create_secret(
--     '<SUPABASE_SERVICE_ROLE_KEY or sb_secret_* key>',
--     'generate_entry_service_key');
--
-- To rotate later: select vault.update_secret(id, new_value) — look up id in
-- vault.secrets by name.
-- ------------------------------------------------------------

-- ------------------------------------------------------------
-- Step 3 — the job body. Fires the edge function only when the current hour
-- matches a user's local notification hour.
-- ------------------------------------------------------------
create or replace function public.run_daily_generation()
returns void
language plpgsql
security definer
set search_path = public, extensions, vault
as $$
declare
  v_url   text;
  v_key   text;
  v_due   boolean;
begin
  -- Any user whose local time is right now at their notification_hour?
  select exists (
    select 1
    from public.profiles p
    where extract(
      hour from (now() at time zone p.timezone)
    )::int = p.notification_hour
  )
  into v_due;

  if not v_due then
    return;  -- nothing due this hour
  end if;

  select decrypted_secret into v_url
  from vault.decrypted_secrets where name = 'generate_entry_url';
  select decrypted_secret into v_key
  from vault.decrypted_secrets where name = 'generate_entry_service_key';

  if v_url is null or v_key is null then
    raise warning 'run_daily_generation: missing Vault secrets, skipping';
    return;
  end if;

  -- Empty body => cron path: generate for all active topics missing today.
  perform net.http_post(
    url     := v_url,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || v_key
    ),
    body    := '{}'::jsonb,
    timeout_milliseconds := 120000
  );
end;
$$;

revoke all on function public.run_daily_generation() from public, authenticated, anon;

-- ------------------------------------------------------------
-- Step 4 — schedule hourly (top of every hour, UTC). Unschedule first so this
-- migration is safe to re-run.
-- ------------------------------------------------------------
do $$
begin
  perform cron.unschedule('promptings-daily-generation');
exception when others then
  null;  -- not yet scheduled
end;
$$;

select cron.schedule(
  'promptings-daily-generation',
  '0 * * * *',
  $$ select public.run_daily_generation(); $$
);

-- ------------------------------------------------------------
-- Verify / operate:
--   select * from cron.job;                       -- confirm it's scheduled
--   select * from cron.job_run_details            -- run history
--     order by start_time desc limit 20;
--   select public.run_daily_generation();         -- manual trigger (respects hour gate)
--   select net.http_post(...);                    -- see net._http_response for results
-- ============================================================
