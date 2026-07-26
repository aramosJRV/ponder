-- ============================================================
-- Promptings — initial schema
-- Tables: profiles, bible_books, bible_verses, topics,
--         daily_entries, notes, syntheses, generation_failures
-- RLS on every user-scoped table. Bible tables are read-only
-- reference data (writes happen via service role only).
-- ============================================================

-- gen_random_uuid() is built into Postgres 13+; no extensions required.

-- ------------------------------------------------------------
-- Enums
-- ------------------------------------------------------------
create type topic_status as enum ('active', 'paused', 'concluded');
create type entry_type as enum ('affirming', 'challenge');
create type synthesis_kind as enum ('on_demand', 'conclusion');

-- ------------------------------------------------------------
-- profiles — one row per auth user
-- ------------------------------------------------------------
create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  timezone text not null default 'UTC',
  notification_hour smallint not null default 4
    check (notification_hour between 0 and 23),
  -- challenge entry probability: 0.00–0.50 (default ~1 in 4)
  challenge_frequency numeric(3,2) not null default 0.25
    check (challenge_frequency between 0 and 0.5),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- auto-create profile on signup
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id) values (new.id)
  on conflict (id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ------------------------------------------------------------
-- bible_books — canonical book list + alias resolution
-- ------------------------------------------------------------
create table public.bible_books (
  book_number smallint primary key check (book_number between 1 and 66),
  name text not null unique,          -- canonical display name, e.g. 'Psalms'
  aliases text[] not null default '{}', -- lowercase aliases, e.g. {'psalm','ps','psa'}
  testament char(2) not null check (testament in ('OT','NT')),
  chapter_count smallint not null
);

-- ------------------------------------------------------------
-- bible_verses — full WEB text, loaded by import script
-- ------------------------------------------------------------
create table public.bible_verses (
  id bigint generated always as identity primary key,
  book_number smallint not null references public.bible_books (book_number),
  book text not null,                 -- canonical name, denormalized for reads
  chapter smallint not null,
  verse smallint not null,
  text text not null,
  unique (book_number, chapter, verse)
);

create index bible_verses_lookup_idx
  on public.bible_verses (book_number, chapter, verse);

-- ------------------------------------------------------------
-- topics
-- ------------------------------------------------------------
create table public.topics (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  title text not null check (char_length(title) between 1 and 120),
  description text not null default '',
  status topic_status not null default 'active',
  focus boolean not null default false,
  created_at timestamptz not null default now(),
  concluded_at timestamptz,
  check (status != 'concluded' or concluded_at is not null)
);

-- at most one focus topic per user (among non-concluded topics)
create unique index topics_one_focus_per_user
  on public.topics (user_id)
  where focus = true and status != 'concluded';

create index topics_user_status_idx on public.topics (user_id, status);

-- concluded topics are read-only: block any update to a concluded
-- topic, except the transition into 'concluded' itself.
create or replace function public.guard_concluded_topic()
returns trigger
language plpgsql
as $$
begin
  if old.status = 'concluded' then
    raise exception 'Concluded topics are read-only';
  end if;
  if new.status = 'concluded' and new.concluded_at is null then
    new.concluded_at := now();
  end if;
  if new.status = 'concluded' then
    new.focus := false;
  end if;
  return new;
end;
$$;

create trigger topics_guard_concluded
  before update on public.topics
  for each row execute function public.guard_concluded_topic();

-- ------------------------------------------------------------
-- daily_entries — one per topic per day, written by edge function
-- ------------------------------------------------------------
create table public.daily_entries (
  id uuid primary key default gen_random_uuid(),
  topic_id uuid not null references public.topics (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  date date not null,
  -- verse reference, resolved against bible_verses at generation time
  verse_ref text not null,            -- display form, e.g. 'Psalm 46:10'
  book_number smallint not null references public.bible_books (book_number),
  chapter smallint not null,
  verse_start smallint not null,
  verse_end smallint not null,
  verse_text text not null,           -- copied from bible_verses, never model output
  thought text not null,
  illustration text not null,
  ponder text[] not null,             -- 2–3 questions
  prayer_prompts text[] not null,     -- 2–3 prayer directions
  entry_type entry_type not null default 'affirming',
  fallback_used boolean not null default false,
  created_at timestamptz not null default now(),
  unique (topic_id, date),
  check (verse_end >= verse_start),
  check (cardinality(ponder) between 1 and 4),
  check (cardinality(prayer_prompts) between 1 and 4)
);

create index daily_entries_topic_date_idx
  on public.daily_entries (topic_id, date desc);
create index daily_entries_user_date_idx
  on public.daily_entries (user_id, date desc);

-- ------------------------------------------------------------
-- notes — attached to an entry, rolled up at topic level
-- ------------------------------------------------------------
create table public.notes (
  id uuid primary key default gen_random_uuid(),
  entry_id uuid not null references public.daily_entries (id) on delete cascade,
  topic_id uuid not null references public.topics (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  body text not null check (char_length(body) > 0),
  created_at timestamptz not null default now()
);

create index notes_topic_created_idx
  on public.notes (topic_id, created_at);
create index notes_entry_idx on public.notes (entry_id);

-- block new/edited notes on concluded topics (closing note is written
-- during the conclusion flow, before status flips to 'concluded')
create or replace function public.guard_notes_on_concluded()
returns trigger
language plpgsql
as $$
begin
  if exists (
    select 1 from public.topics t
    where t.id = new.topic_id and t.status = 'concluded'
  ) then
    raise exception 'Cannot add or edit notes on a concluded topic';
  end if;
  return new;
end;
$$;

create trigger notes_guard_concluded
  before insert or update on public.notes
  for each row execute function public.guard_notes_on_concluded();

-- ------------------------------------------------------------
-- syntheses — "what's emerging" snapshots, written by edge function
-- ------------------------------------------------------------
create table public.syntheses (
  id uuid primary key default gen_random_uuid(),
  topic_id uuid not null references public.topics (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  kind synthesis_kind not null,
  -- { threads: [...], tensions: [...], next_steps: [...] }
  content jsonb not null,
  created_at timestamptz not null default now()
);

create index syntheses_topic_created_idx
  on public.syntheses (topic_id, created_at desc);

-- ------------------------------------------------------------
-- generation_failures — log for validation/fallback events
-- ------------------------------------------------------------
create table public.generation_failures (
  id uuid primary key default gen_random_uuid(),
  topic_id uuid references public.topics (id) on delete set null,
  user_id uuid references auth.users (id) on delete set null,
  date date not null default current_date,
  stage text not null,                -- 'verse_resolution' | 'json_parse' | 'api_error' | ...
  detail jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create index generation_failures_date_idx
  on public.generation_failures (date desc);

-- ============================================================
-- Row Level Security
-- ============================================================
alter table public.profiles            enable row level security;
alter table public.bible_books         enable row level security;
alter table public.bible_verses        enable row level security;
alter table public.topics              enable row level security;
alter table public.daily_entries       enable row level security;
alter table public.notes               enable row level security;
alter table public.syntheses           enable row level security;
alter table public.generation_failures enable row level security;

-- profiles: read/update own (insert handled by signup trigger)
create policy "profiles_select_own" on public.profiles
  for select using (auth.uid() = id);
create policy "profiles_update_own" on public.profiles
  for update using (auth.uid() = id) with check (auth.uid() = id);

-- bible reference data: readable by any signed-in user, no client writes
create policy "bible_books_read" on public.bible_books
  for select to authenticated using (true);
create policy "bible_verses_read" on public.bible_verses
  for select to authenticated using (true);

-- topics: full CRUD on own rows
create policy "topics_select_own" on public.topics
  for select using (auth.uid() = user_id);
create policy "topics_insert_own" on public.topics
  for insert with check (auth.uid() = user_id);
create policy "topics_update_own" on public.topics
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "topics_delete_own" on public.topics
  for delete using (auth.uid() = user_id);

-- daily_entries: read own; writes come from edge functions (service role
-- bypasses RLS) — deliberately no client insert/update/delete policies.
create policy "daily_entries_select_own" on public.daily_entries
  for select using (auth.uid() = user_id);

-- notes: full CRUD on own rows
create policy "notes_select_own" on public.notes
  for select using (auth.uid() = user_id);
create policy "notes_insert_own" on public.notes
  for insert with check (auth.uid() = user_id);
create policy "notes_update_own" on public.notes
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "notes_delete_own" on public.notes
  for delete using (auth.uid() = user_id);

-- syntheses: read own; written by edge functions only
create policy "syntheses_select_own" on public.syntheses
  for select using (auth.uid() = user_id);

-- generation_failures: read own; written by edge functions only
create policy "generation_failures_select_own" on public.generation_failures
  for select using (auth.uid() = user_id);

-- ============================================================
-- Helper: resolve a human verse reference to bible_verses rows.
-- Used by the generation edge function's validation step.
-- ============================================================
create or replace function public.resolve_verse_ref(
  p_book text,
  p_chapter int,
  p_verse_start int,
  p_verse_end int default null
)
returns table (
  book_number smallint,
  book text,
  chapter smallint,
  verse smallint,
  text text
)
language sql
stable
as $$
  select v.book_number, v.book, v.chapter, v.verse, v.text
  from public.bible_verses v
  join public.bible_books b on b.book_number = v.book_number
  where (lower(trim(p_book)) = lower(b.name)
         or lower(trim(p_book)) = any (b.aliases))
    and v.chapter = p_chapter
    and v.verse between p_verse_start and coalesce(p_verse_end, p_verse_start)
  order by v.verse;
$$;
