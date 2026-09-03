-- Regenerate the daily_entries flagged by scan-duration-claims.sql.
-- 3 Sep 2026. Run the numbered blocks in order, in the dashboard SQL editor.
--
-- Scope: the 9 flagged entries on ACTIVE threads with no note attached.
-- Deliberately excluded (decided 3 Sep):
--   4  active threads WITH a note — regenerating rewrites what the note answered
--   10 paused threads   } generate-entry filters status = 'active', and a
--   3  concluded threads} concluded thread is meant to be frozen history
--
-- ALREADY DONE (no need to repeat):
--   - 339 entry_pool rows soft-retired (retired = true)
--   - public.duration_fix_backup_20260903 created, RLS on, grants revoked,
--     holding full copies of the 9 rows below

-- ============================================================ 1. sanity
select count(*)::int as should_be_9 from public.duration_fix_backup_20260903;

-- ============================================================ 2. the swap
-- Deletes the 9 rows and queues one generate-entry call per (thread, date).
-- pg_net is async: this returns immediately, generation lands over the next
-- minute or two. The pool is clean now, so most of these will be served from
-- it rather than costing a live Claude call.
with del as (
  delete from daily_entries d
   where d.id in (select b.id from public.duration_fix_backup_20260903 b)
  returning d.topic_id, d.date
)
select del.topic_id, del.date,
       public.call_edge_function('generate_entry_url',
         jsonb_build_object('topic_id', del.topic_id::text,
                            'force_date', to_char(del.date, 'YYYY-MM-DD'))) as queued
  from del;

-- ============================================================ 3. verify
-- Wait ~90s, then: every backed-up (thread, date) must have a row again.
select b.topic_id, b.date,
       (select count(*) from daily_entries d
         where d.topic_id = b.topic_id and d.date = b.date)::int as now_present
  from public.duration_fix_backup_20260903 b
 order by b.date;

-- Any zero above = a hole. Restore just those from the backup (block 5).

-- And confirm the new text is clean:
select d.id, d.date, left(d.thought, 160) as thought
  from daily_entries d
  join public.duration_fix_backup_20260903 b
    on b.topic_id = d.topic_id and b.date = d.date
 where concat_ws(' ', d.thought, d.illustration,
                 array_to_string(d.ponder,' '), array_to_string(d.prayer_prompts,' '))
       ~* '\m(day\s+[0-9]+|long haul|early days|a while now|all this time|these past|for so long)\M';
-- Zero rows = clean.

-- ============================================================ 4. failures
select stage, detail, created_at
  from generation_failures
 where created_at > now() - interval '10 minutes'
 order by created_at desc;

select id, status_code, left(content, 300) as body, created
  from net._http_response
 order by created desc limit 12;

-- ============================================================ 5. rollback
-- Only if block 3 shows holes. Puts the ORIGINAL (bad) text back so no day is
-- missing; better a wrong sentence than an empty day.
-- insert into daily_entries
--   select b.* from public.duration_fix_backup_20260903 b
--    where not exists (select 1 from daily_entries d
--                       where d.topic_id = b.topic_id and d.date = b.date);

-- ============================================================ 6. cleanup
-- Once block 3 is clean, drop the scratch table:
-- drop table public.duration_fix_backup_20260903;
