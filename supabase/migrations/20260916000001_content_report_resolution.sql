-- ============================================================
-- Ponder — closing the loop on content reports
--
-- SCHEMA CHANGE. Apply via `supabase db push` or the dashboard SQL editor.
-- Adds one enum and three columns to content_reports, two functions, and
-- folds a report digest into the nightly admin snapshot. Nothing the app
-- reads or writes changes shape.
--
-- WHY
--
-- content_reports has had exactly one piece of resolution state since July:
-- `resolved_at`. A timestamp records THAT something happened, never what. So
-- a report could only ever be closed, not answered — and in practice none
-- were closed at all: on 16 Sep 2026 both reports in the table were still
-- open, one of them 49 days old.
--
-- The missing half is the operator's answer. A report saying "doesn't seem
-- related to the topic I entered" is a bug report about verse selection;
-- resolving it means recording the diagnosis, so the next occurrence is
-- recognised rather than re-investigated.
-- ============================================================

-- ------------------------------------------------------------
-- 1. What was actually done about it
--
-- Deliberately coarse. These are the only five outcomes that change what
-- happens next; a finer taxonomy would be guessed at rather than used.
-- ------------------------------------------------------------
do $mig$
begin
  if not exists (select 1 from pg_type where typname = 'report_action') then
    create type report_action as enum (
      'fixed',
      'regenerated',
      'no_action',
      'invalid',
      'wont_fix'
    );
  end if;
end $mig$;

alter table public.content_reports
  add column if not exists action      report_action,
  add column if not exists resolution  text,
  add column if not exists resolved_by uuid references auth.users (id) on delete set null;

comment on column public.content_reports.resolution is
  'What was done and why, in the operator''s words. The durable half of a resolution.';

alter table public.content_reports
  drop constraint if exists content_reports_resolution_complete;
alter table public.content_reports
  add constraint content_reports_resolution_complete check (
    resolved_at is null
    or (action is not null and resolution is not null and char_length(resolution) > 0)
  );

create index if not exists content_reports_open_idx
  on public.content_reports (created_at) where resolved_at is null;

-- ------------------------------------------------------------
-- 2. Resolving one. Operator only; nothing in the app calls this.
-- ------------------------------------------------------------
create or replace function public.resolve_content_report(
  p_report_id  uuid,
  p_action     report_action,
  p_resolution text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_row public.content_reports;
begin
  if p_resolution is null or char_length(trim(p_resolution)) = 0 then
    raise exception 'a resolution note is required';
  end if;

  update public.content_reports
     set action      = p_action,
         resolution  = trim(p_resolution),
         resolved_at = coalesce(resolved_at, now()),
         resolved_by = auth.uid()
   where id = p_report_id
   returning * into v_row;

  if v_row.id is null then
    raise exception 'no report %', p_report_id;
  end if;

  return jsonb_build_object('id', v_row.id, 'action', v_row.action,
                            'resolved_at', v_row.resolved_at);
end;
$fn$;

revoke all on function public.resolve_content_report(uuid, report_action, text)
  from public, anon, authenticated;

-- ------------------------------------------------------------
-- 3. The digest the dashboard renders.
--
-- Age is the field that matters — a report nobody looked at for seven weeks
-- is the failure this exists to prevent. The reporter's user_id is
-- deliberately omitted: who complained changes nothing about whether the
-- content was wrong.
-- ------------------------------------------------------------
create or replace function public.admin_report_digest()
returns jsonb
language sql
stable
security definer
set search_path = public
as $fn$
  select jsonb_build_object(
    'open_count', (select count(*) from public.content_reports where resolved_at is null),
    'oldest_open_days', (select max(extract(day from now() - created_at))::int
                           from public.content_reports where resolved_at is null),
    'open', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', r.id,
        'created_at', r.created_at,
        'age_days', extract(day from now() - r.created_at)::int,
        'target', r.target,
        'reason', r.reason,
        'detail', r.detail,
        'thread', t.title,
        'verse_ref', e.verse_ref,
        'entry_date', e.date
      ) order by r.created_at)
      from public.content_reports r
      left join public.daily_entries e on e.id = r.entry_id
      left join public.topics t on t.id = coalesce(e.topic_id, (
        select s.topic_id from public.syntheses s where s.id = r.synthesis_id))
      where r.resolved_at is null), '[]'::jsonb),
    'recently_resolved', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', r.id, 'resolved_at', r.resolved_at, 'reason', r.reason,
        'action', r.action, 'resolution', r.resolution
      ) order by r.resolved_at desc)
      from (select * from public.content_reports
             where resolved_at is not null
             order by resolved_at desc limit 10) r), '[]'::jsonb),
    'by_reason_90d', coalesce((
      select jsonb_agg(jsonb_build_object('reason', reason, 'n', n) order by n desc)
      from (select reason, count(*) n from public.content_reports
             where created_at > now() - interval '90 days' group by reason) a), '[]'::jsonb)
  );
$fn$;

revoke all on function public.admin_report_digest() from public, anon, authenticated;

-- ------------------------------------------------------------
-- 4. Fold it into the nightly snapshot.
--
-- build_admin_snapshot() is left untouched; the digest is merged at capture
-- time, so this migration cannot break the metrics that already work.
-- ------------------------------------------------------------
create or replace function public.capture_admin_snapshot()
returns void
language sql
security definer
set search_path = public, extensions
as $fn$
  insert into public.admin_snapshot (captured_on, captured_at, payload)
  values (current_date, now(),
          public.build_admin_snapshot()
            || jsonb_build_object('reports', public.admin_report_digest()))
  on conflict (captured_on) do update
    set captured_at = excluded.captured_at,
        payload     = excluded.payload;
$fn$;

revoke all on function public.capture_admin_snapshot() from public, anon, authenticated;

select public.capture_admin_snapshot();
