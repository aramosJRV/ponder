-- ============================================================
-- Ponder — Bucket 1: public-domain author quotes. Schema only.
--
-- The model NEVER writes quote text. It returns a quote id; generate-entry
-- resolves it here and copies the verbatim text onto the entry — the same
-- contract as verse_text (from bible_verses) and song (from a Spotify
-- response). An id that does not resolve means NO QUOTE and the entry ships
-- without one. Breaking that contract produces fabricated quotes attributed
-- to real people, which is the failure this whole design exists to prevent.
--
-- Nothing here is client-readable. The reader sees a quote only as a
-- denormalised blob on daily_entries.quote, added in a later migration with
-- the same shape as daily_entries.song. That keeps these tables off the wire
-- and means NO GRANT ON ANY EXISTING TABLE CHANGES — see 20260824000002 and
-- the 25 Aug 2026 outage it caused.
--
-- Ids are text slugs, not uuids, because the model has to echo one back in a
-- tool call. A garbled uuid fails silently (no quote, no error), so the
-- symptom would be "quotes are rarer than 1 in 5" with nothing in the logs.
-- Slugs are also derived from a hash of the text, so re-running the seed is
-- idempotent and used-quote history survives a reseed.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Authors and works
-- ------------------------------------------------------------
create table if not exists public.voices (
  id          text primary key,          -- slug, e.g. 'watson-divinity'
  name        text not null,             -- 'Thomas Watson'
  died        smallint not null,
  work_title  text not null,             -- 'A Body of Divinity'
  work_year   smallint not null,         -- may post-date death (Watson, 1692)
  pd_basis    text not null,             -- why this is public domain in AU
  active      boolean not null default true,
  created_at  timestamptz not null default now(),

  -- Australian public domain is life + 70. Anyone who died in 1955 or later
  -- is still in copyright here — Tozer (d.1963) and C.S. Lewis (d.1963) both
  -- fail this. Bucket 1 quotes are reproduced verbatim AND attributed, so
  -- this is a hard floor, not a guideline.
  constraint voices_public_domain_au check (died < 1955),
  constraint voices_work_year_sane   check (work_year between 1000 and 1955)
);

alter table public.voices enable row level security;
-- RLS on with zero policies denies anon/authenticated outright. The revoke is
-- belt and braces against Supabase's default grants on new public tables.
-- Edge functions use the service key and bypass both.
revoke all on public.voices from anon, authenticated;

-- ------------------------------------------------------------
-- 2. Quotes
-- ------------------------------------------------------------
create table if not exists public.voice_quotes (
  id         text primary key,           -- 'watson-divinity-3f9a1c2b'
  voice_id   text not null references public.voices (id) on delete cascade,
  -- VERBATIM from the source edition. Never edited, never model output.
  text       text not null,
  citation   text,                       -- chapter/section; not captured yet
  -- Set once a human has read it. The seed sets this true for the 213 Antonio
  -- reviewed on 16 Sep 2026; anything added later starts untrusted.
  reviewed   boolean not null default false,
  -- Soft delete, same convention as entry_pool.retired.
  retired    boolean not null default false,
  created_at timestamptz not null default now(),

  -- Observed range across the 213 approved candidates is 65-199 chars. Loose
  -- enough for a second harvest, tight enough that a truncated fragment or a
  -- whole pasted paragraph fails at insert rather than on the entry card.
  constraint voice_quotes_text_len check (char_length(text) between 40 and 400)
);

alter table public.voice_quotes enable row level security;
revoke all on public.voice_quotes from anon, authenticated;

-- Candidate lookup: live quotes for a given author/work.
create index if not exists voice_quotes_selectable_idx
  on public.voice_quotes (voice_id)
  where reviewed and not retired;

-- ------------------------------------------------------------
-- 3. Quote -> theme
--
-- A join table rather than a text[] of slugs on voice_quotes. Theme match is
-- the entire selection path, and an unvalidated tag array means one typo in
-- the 213-row tagging pass yields a quote that is silently never selectable,
-- with nothing raised anywhere. The FK rejects it at write time instead.
-- ------------------------------------------------------------
create table if not exists public.voice_quote_themes (
  quote_id text not null references public.voice_quotes (id) on delete cascade,
  theme_id uuid not null references public.entry_themes (id) on delete cascade,
  primary key (quote_id, theme_id)
);

alter table public.voice_quote_themes enable row level security;
revoke all on public.voice_quote_themes from anon, authenticated;

-- "Which quotes are candidates for this theme?" — the generate-entry query.
create index if not exists voice_quote_themes_theme_idx
  on public.voice_quote_themes (theme_id);

-- ------------------------------------------------------------
comment on table public.voices is
  'Public-domain authors/works quotable in daily entries. AU life+70 enforced by check constraint. Service-only: RLS on, zero policies.';
comment on table public.voice_quotes is
  'Verbatim public-domain quotes. The model emits an id only; the server resolves the text. Service-only — the reader sees these via daily_entries.quote. See 20260916000002.';
comment on table public.voice_quote_themes is
  'Theme tagging for quote selection. FK to entry_themes so a mistyped theme is rejected rather than silently unselectable.';
