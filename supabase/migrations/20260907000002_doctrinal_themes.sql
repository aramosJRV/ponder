-- ------------------------------------------------------------
-- Doctrinal theme cluster + a review gate for it
--
-- WHY (7 Sep 2026):
-- All 40 seeded themes are SITUATIONAL — a circumstance the person is in
-- (grief, waiting, parenting, conflict). "Holy Spirit In Me" is DOCTRINAL —
-- an aspect of God the person wants to know. There was no theme on that axis,
-- so the classifier force-fitted it to `prayer-life` and the reader got
-- generic prayer material. See 20260907000001 for the gate fix.
--
-- Situational and doctrinal themes carry different risk. A weak situational
-- entry is bland. A weak doctrinal entry is wrong — heretical, or quietly
-- denominational, which reads to the user as someone else's church talking.
-- `entry_pool.reviewed` has existed since 20260823000003 and nothing has ever
-- read it. This migration makes it load-bearing, for these themes only.
-- ------------------------------------------------------------

-- ------------------------------------------------------------
-- 1. Per-theme review requirement
--
-- On the theme, not globally: situational themes have been serving unreviewed
-- for two weeks without incident and gating them retroactively would empty
-- the pool overnight.
-- ------------------------------------------------------------
alter table public.entry_themes
  add column if not exists requires_review boolean not null default false;

comment on column public.entry_themes.requires_review is
  'When true, select_pool_entry() will only serve entries from this theme '
  'once entry_pool.reviewed is set by a human. Set for doctrinal themes, '
  'where a bad entry is wrong rather than merely bland.';

-- ------------------------------------------------------------
-- 2. The cluster
--
-- The description is BOTH the pool builder''s brief AND the classifier''s
-- only view of the theme, so each one has to disambiguate itself from its
-- nearest neighbour as well as describe the content.
--
-- No `trinity` slug on purpose: highest heresy surface, lowest chance a real
-- thread is worded that way, and the three person-themes cover it in
-- practice.
-- ------------------------------------------------------------
insert into public.entry_themes (slug, title, description, requires_review) values
  ('holy-spirit','The Holy Spirit',
   'Wanting to know the Spirit himself — his indwelling, his prompting, his conviction, his comfort, his fruit. Stay inside what the whole church holds in common; never take a side on gifts, tongues or cessationism.',
   true),
  ('who-jesus-is','Who Jesus is',
   'Coming to know Christ himself rather than a circumstance — his character, his words, how he dealt with people. Distinct from threads about a situation they are asking him into.',
   true),
  ('god-as-father','God as Father',
   'God''s fatherhood, and what it means to be adopted — including for someone whose own father made that word hard to hear. Never assume the reader''s father was absent or cruel.',
   true),
  ('what-god-is-like','The character of God',
   'Sitting with one attribute of God — holiness, mercy, justice, sovereignty, patience, faithfulness — and what it changes. Not a systematic-theology lecture; the same bite-size posture as every other theme.',
   true),
  ('scripture-itself','Scripture itself',
   'What the Bible is and how to come to it. Distinct from `scripture-dryness`, which is the experience of reading and feeling nothing; this is the book itself, not the dry season.',
   true),
  ('worship','Worship',
   'Worship as a whole-life posture rather than only singing. Distinct from `gratitude`, which is noticing what is good; this is the response directed at God himself.',
   true)
on conflict (slug) do update
  set title           = excluded.title,
      description     = excluded.description,
      requires_review = excluded.requires_review;

-- ------------------------------------------------------------
-- 3. Honour the gate in select_pool_entry()
--
-- Identical to 20260825000001 except for v_needs_review and the one extra
-- predicate. Until a human sets reviewed, these themes return null here and
-- the thread falls through to per-user live generation from its own
-- description — the correct, invisible-to-the-reader outcome.
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
  v_user_id       uuid;
  v_theme         uuid;
  v_conf          real;
  v_needs_review  boolean;
  v_age           integer;
  v_id            uuid;
begin
  select t.user_id, tt.theme_id, tt.confidence,
         coalesce(e.requires_review, false),
         greatest(0, (current_date - t.created_at::date))
    into v_user_id, v_theme, v_conf, v_needs_review, v_age
  from public.topics t
  left join public.topic_themes tt on tt.topic_id = t.id
  left join public.entry_themes  e on e.id = tt.theme_id
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
    -- doctrinal themes: nothing serves until a human has read it
    and (not v_needs_review or p.reviewed)
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

-- ------------------------------------------------------------
-- Verify / operate
--
--   -- the six new themes, gated
--   select slug, title, requires_review from public.entry_themes
--    where requires_review order by slug;
--
--   -- build progress (target 30 affirming / 10 challenge per theme)
--   select e.slug, p.entry_type, count(*) filter (where p.reviewed) as ok,
--          count(*) as built
--     from public.entry_themes e
--     left join public.entry_pool p on p.theme_id = e.id
--    where e.requires_review
--    group by 1,2 order by 1,2;
--
--   -- REVIEW QUEUE: read these before they can ever be served
--   select p.id, e.slug, p.entry_type, p.verse_ref, p.thought,
--          p.illustration, p.ponder, p.prayer_prompts
--     from public.entry_pool p
--     join public.entry_themes e on e.id = p.theme_id
--    where e.requires_review and not p.reviewed and not p.retired
--    order by e.slug, p.entry_type
--    limit 20;
--
--   -- approve:  update public.entry_pool set reviewed = true where id = '<uuid>';
--   -- reject:   update public.entry_pool set retired  = true where id = '<uuid>';
-- ------------------------------------------------------------
