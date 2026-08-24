-- ============================================================
-- Ponder — the shared entry pool
--
-- ⚠️  SCHEMA CHANGE. Apply via `supabase db push`.
--
-- WHY THIS EXISTS
--
-- Ponder is free and stays free, and the user experience must not change
-- because generation failed. Funding cannot deliver that on its own: an
-- Anthropic outage, a rate limit, an expired card or a bug in this repo all
-- stop generation regardless of how much credit is sitting in the account.
--
-- A library of entries on disk does deliver it. When the live path fails for
-- ANY reason, a matching pool entry is copied into daily_entries and the user
-- sees a normal day.
--
-- WHAT THIS IS NOT
--
-- It does not change the domain model. daily_entries is still written one row
-- per topic per day, and every read path — journal, notes, synthesis,
-- conclusion, export, delete — is untouched. The only difference is where a
-- row's content came from.
--
-- SHARING RULE
--
-- Pool entries are shared across users ONLY where the thread theme matches,
-- and only where the classifier was confident. A thread that doesn't match a
-- theme well keeps per-user generation. Users never compare feeds, but the
-- promise is "written for what you're listening to", and a loose match would
-- break that promise in a way a user CAN feel.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Themes
--
-- Coarse enough that a pool per theme is affordable, fine enough that an
-- entry drawn from it still reads as being about the user's thread. ~40 is
-- the balance point: at 10 the entries feel generic, at 200 the pool never
-- gets deep enough to avoid repeats.
-- ------------------------------------------------------------
create table if not exists public.entry_themes (
  id          uuid primary key default gen_random_uuid(),
  slug        text not null unique,
  title       text not null,
  -- Fed to the pool builder as the brief. This is the only description the
  -- model gets, so it carries the weight a user's own thread description
  -- would in the live path.
  description text not null,
  active      boolean not null default true,
  created_at  timestamptz not null default now()
);

alter table public.entry_themes enable row level security;

-- Readable by the app (the classifier's candidate list, and to show a thread's
-- theme). Nothing here is user data.
drop policy if exists entry_themes_read on public.entry_themes;
create policy entry_themes_read on public.entry_themes
  for select to authenticated using (true);

-- ------------------------------------------------------------
-- 2. Thread -> theme
--
-- confidence is the classifier's own score. Below pool_confidence_floor() the
-- thread is served by per-user generation, and the slug is still recorded so
-- the misses are visible — a cluster of low-confidence threads on the same
-- subject is the signal that a theme is missing.
-- ------------------------------------------------------------
alter table public.topics
  add column if not exists theme_id uuid references public.entry_themes (id),
  add column if not exists theme_confidence real,
  add column if not exists theme_classified_at timestamptz;

create index if not exists topics_theme_idx on public.topics (theme_id);

create or replace function public.pool_confidence_floor()
returns real
language sql
immutable
as $$ select 0.6::real; $$;

-- ------------------------------------------------------------
-- 3. The pool
--
-- Columns mirror daily_entries deliberately, so selection is a copy rather
-- than a transformation. verse_text is resolved and validated at BUILD time,
-- which is the quiet win here: a bad verse reference never reaches a user,
-- and the ~18% validation-retry cost disappears from the hot path.
--
-- day_index places an entry roughly in a thread's life — an entry written for
-- someone three days in should not be handed to someone eight months in.
-- ------------------------------------------------------------
create table if not exists public.entry_pool (
  id           uuid primary key default gen_random_uuid(),
  theme_id     uuid not null references public.entry_themes (id) on delete cascade,
  day_index    integer not null default 0,
  entry_type   entry_type not null,

  verse_ref    text not null,
  book_number  smallint not null references public.bible_books (book_number),
  chapter      smallint not null,
  verse_start  smallint not null,
  verse_end    smallint not null,
  verse_text   text not null,          -- from bible_verses at build time

  thought      text not null,
  illustration text not null,
  ponder       text[] not null,
  prayer_prompts text[] not null,
  cross_refs   jsonb not null default '[]'::jsonb,
  song         jsonb,

  -- Set once a human has read it. Nothing enforces reviewed = true before an
  -- entry can be served; it exists so curation is possible, not mandatory.
  reviewed     boolean not null default false,
  -- Soft delete. Never hard-delete a pool row that entry_pool_seen references.
  retired      boolean not null default false,

  model        text,
  created_at   timestamptz not null default now(),

  check (verse_end >= verse_start),
  check (cardinality(ponder) between 1 and 4),
  check (cardinality(prayer_prompts) between 1 and 4),
  check (day_index >= 0)
);

create index if not exists entry_pool_pick_idx
  on public.entry_pool (theme_id, entry_type, day_index)
  where not retired;

create index if not exists entry_pool_ref_idx
  on public.entry_pool (theme_id, verse_ref) where not retired;

alter table public.entry_pool enable row level security;
-- No client policies: the app never reads the pool directly, it reads the
-- daily_entries row that was copied from it.

-- ------------------------------------------------------------
-- 4. What a thread has already been served
--
-- Keyed by topic so the same pool entry is never handed to the same thread
-- twice. Deliberately survives the daily_entries row being deleted: if a user
-- deletes a day, they should not get the identical entry back tomorrow.
-- ------------------------------------------------------------
create table if not exists public.entry_pool_seen (
  topic_id      uuid not null references public.topics (id) on delete cascade,
  pool_entry_id uuid not null references public.entry_pool (id) on delete cascade,
  used_on       date not null default current_date,
  primary key (topic_id, pool_entry_id)
);

alter table public.entry_pool_seen enable row level security;

-- ------------------------------------------------------------
-- 5. Selection
--
-- Returns one pool entry id, or null when the pool cannot serve this thread —
-- in which case the caller falls back to live generation.
--
-- The exclusions match the live path exactly, because the user cannot tell
-- which path produced their entry and the rules must not change between them:
--   * never a pool entry this thread has already had
--   * never a verse this thread has already used, ever
--   * never a verse the user saw on another thread in the last 60 days
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
  v_user_id uuid;
  v_theme   uuid;
  v_conf    real;
  v_age     integer;
  v_id      uuid;
begin
  select t.user_id, t.theme_id, t.theme_confidence,
         greatest(0, (current_date - t.created_at::date))
    into v_user_id, v_theme, v_conf, v_age
  from public.topics t
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

revoke all on function public.select_pool_entry(uuid, entry_type)
  from public, anon, authenticated;

-- ------------------------------------------------------------
-- 6. Serving
--
-- Copies a pool entry into daily_entries and records it as seen, in one
-- transaction. Returns the new daily_entries id, or null if the day was
-- already filled (a race with the live path — harmless, first writer wins).
-- ------------------------------------------------------------
create or replace function public.serve_pool_entry(
  p_topic_id uuid,
  p_date     date,
  p_pool_id  uuid
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid;
  v_new_id  uuid;
begin
  select user_id into v_user_id from public.topics where id = p_topic_id;
  if v_user_id is null then return null; end if;

  insert into public.daily_entries (
    topic_id, user_id, date, verse_ref, book_number, chapter,
    verse_start, verse_end, verse_text, thought, illustration,
    ponder, prayer_prompts, entry_type, cross_refs, song
  )
  select p_topic_id, v_user_id, p_date, p.verse_ref, p.book_number, p.chapter,
         p.verse_start, p.verse_end, p.verse_text, p.thought, p.illustration,
         p.ponder, p.prayer_prompts, p.entry_type, p.cross_refs, p.song
  from public.entry_pool p
  where p.id = p_pool_id
  on conflict (topic_id, date) do nothing
  returning id into v_new_id;

  if v_new_id is null then
    return null;  -- someone else filled this day first
  end if;

  insert into public.entry_pool_seen (topic_id, pool_entry_id, used_on)
  values (p_topic_id, p_pool_id, p_date)
  on conflict do nothing;

  return v_new_id;
end;
$$;

revoke all on function public.serve_pool_entry(uuid, date, uuid)
  from public, anon, authenticated;

-- ------------------------------------------------------------
-- 7. Pool health
--
-- How many unserved entries remain per theme. This is the number that decides
-- when to top the pool up; a theme approaching zero starts falling back to
-- live generation, which still works but costs money per user.
-- ------------------------------------------------------------
create or replace function public.pool_depth()
returns table (slug text, entry_type entry_type, available bigint)
language sql
stable
security definer
set search_path = public
as $$
  select t.slug, p.entry_type, count(*)
  from public.entry_pool p
  join public.entry_themes t on t.id = p.theme_id
  where not p.retired
  group by t.slug, p.entry_type
  order by t.slug, p.entry_type;
$$;

revoke all on function public.pool_depth() from public, anon, authenticated;

-- ------------------------------------------------------------
-- 8. Seed themes
--
-- Descriptions are the brief handed to the pool builder, so they are written
-- as instructions to a writer, not as labels. Add themes freely; the
-- classifier reads this table, so a new row is immediately selectable.
-- ------------------------------------------------------------
insert into public.entry_themes (slug, title, description) values
 ('waiting','Waiting','Someone in a long wait for something they believe God has promised or invited, with no visible movement yet.'),
 ('calling','Calling and vocation','Discerning what they are for — a career direction, a sense of being called toward or away from something.'),
 ('provision','Provision and money','Trusting God with finances, work, or material need, without prosperity-gospel framing.'),
 ('grief','Grief','Living with loss — a death, an ending, or a future that will not now happen.'),
 ('anxiety','Anxiety and fear','Fear about what may come. Never clinical advice; the posture is companionship, not treatment.'),
 ('forgiving','Forgiving someone','The work of forgiving a person who has hurt them, including how slow and unfinished it can be.'),
 ('being-forgiven','Being forgiven','Receiving forgiveness, and living with guilt or shame that has already been dealt with.'),
 ('marriage','Marriage','A marriage — its ordinary faithfulness, its strain, its repair.'),
 ('singleness','Singleness','Singleness held honestly: neither a problem to be solved nor a state to be romanticised.'),
 ('parenting','Parenting','Raising children, at any age, including adult children and the letting go.'),
 ('doubt','Doubt','Honest doubt about God, faith, or scripture. Never resolved cheaply.'),
 ('identity','Identity','Who they are apart from what they do or what others say about them.'),
 ('anger','Anger','Anger — at a person, a situation, or God. Taken seriously rather than scolded.'),
 ('envy','Envy and comparison','Comparison with others and the discontent it breeds.'),
 ('pride','Pride and humility','Self-regard, status, and the slow work of humility.'),
 ('obedience','Obedience','A specific step they sense they are being asked to take, and the cost of it.'),
 ('decision','A decision','Standing at a fork with real stakes and no obvious answer.'),
 ('healing','Healing','Praying for healing — physical or inward — while it has not yet come.'),
 ('ministry','Ministry and service','Serving others, and the weariness and the joy in it.'),
 ('church-hurt','Church hurt','Wounded by a church or a Christian leader, and what it did to their faith.'),
 ('work-integrity','Integrity at work','Doing right at work when it costs something.'),
 ('rest','Rest and sabbath','Rest as obedience rather than reward. Slowing down, stopping, being unproductive.'),
 ('generosity','Generosity','Giving — of money, time, or attention — and what holds them back.'),
 ('suffering','Suffering','Pain without explanation. Never tidied into a lesson.'),
 ('hope','Hope','Hope held on to in the dark, distinguished from optimism.'),
 ('patience','Patience','Patience with people, with process, and with themselves.'),
 ('gratitude','Gratitude','Noticing and naming what is good, especially when it is not obvious.'),
 ('purpose','Purpose','What their life is for, in seasons where it feels small or unclear.'),
 ('transition','Transition','Moving house, city, job, or life stage. Leaving and arriving.'),
 ('illness-own','Their own illness','Living with their own illness or physical limitation. Companionship, never medical advice.'),
 ('illness-loved','Someone else''s illness','Walking with someone they love who is unwell, and the helplessness in it.'),
 ('estrangement','Estrangement','A relationship that is broken or cut off, possibly permanently.'),
 ('habit','A habit they cannot break','A pattern they keep returning to. Honest about repetition and relapse, never shaming, never treatment advice.'),
 ('prayer-life','Prayer','Their prayer life — dryness, distraction, and the returning.'),
 ('scripture-dryness','Dryness in scripture','Reading the Bible and feeling nothing, and staying with it anyway.'),
 ('evangelism','Sharing faith','Speaking about faith with people who do not share it, and the fear of it.'),
 ('leadership','Leading others','Carrying responsibility for other people.'),
 ('conflict','Conflict','A live disagreement with someone, and how to be in it well.'),
 ('contentment','Contentment','Enough — wanting less, or wanting differently.'),
 ('starting-again','Starting again','After failure, collapse, or a long drift away. Beginning from here.')
on conflict (slug) do update
  set title = excluded.title,
      description = excluded.description;

-- ------------------------------------------------------------
-- Verify
--
--   select count(*) from public.entry_themes;        -- 40
--   select * from public.pool_depth();               -- empty until built
--   select public.select_pool_entry('<topic>', 'affirming');
--   select slug, count(*) from public.topics t
--     join public.entry_themes e on e.id = t.theme_id group by 1;
-- ------------------------------------------------------------

-- ------------------------------------------------------------
-- 9. Keeping the pool full
--
-- The pool only protects the user experience while it has entries left. This
-- job tops it up on a slow drip rather than in one big build: ten entries an
-- hour is ~7,200 a month, far more than the library needs, and it spreads the
-- spend so a mistake is cheap to notice and stop.
--
-- buildPool() picks the shallowest theme itself and returns early once every
-- theme is at target, so this is a no-op most of the time.
--
-- It routes through generate-entry (mode=pool_build), which checks the spend
-- tripwire first. A runaway therefore cannot be funded by this job.
-- ------------------------------------------------------------
create or replace function public.run_pool_topup()
returns void
language plpgsql
security definer
set search_path = public, extensions, vault
as $$
begin
  if not public.generation_allowed() then
    raise warning 'run_pool_topup: tripwire fired, skipping';
    return;
  end if;

  perform public.call_edge_function(
    'generate_entry_url',
    jsonb_build_object('mode', 'pool_build', 'count', 10)
  );
end;
$$;

revoke all on function public.run_pool_topup() from public, anon, authenticated;

do $$
begin
  perform cron.unschedule('ponder-pool-topup');
exception when others then null;
end;
$$;

-- Hourly at :35, deliberately off the batch-collect ten-minute grid so the
-- two are never competing for the same edge function instance.
select cron.schedule(
  'ponder-pool-topup',
  '35 * * * *',
  $$ select public.run_pool_topup(); $$
);

-- ------------------------------------------------------------
-- Verify the top-up
--
--   select * from public.pool_depth();
--   select public.run_pool_topup();     -- force one round now
--   select stage, count(*) from public.generation_failures
--     where stage like 'pool%' group by 1;
-- ------------------------------------------------------------
