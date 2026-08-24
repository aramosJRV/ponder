-- Ponder — take the pool off the client's wire
--
-- The pool must be invisible from the reader's side. Not "not mentioned in
-- the UI" — invisible: a user with devtools, or the anon key and curl,
-- should find nothing that says their day was picked from a shared library
-- rather than written for their thread.
--
-- Two things were exposing it, both from 20260823000003_entry_pool.sql.
--
-- 1. entry_themes was readable by every authenticated user. The comment
--    justified it as "the classifier's candidate list, and to show a thread's
--    theme" — neither happened. The classifier runs in generate-entry under
--    the service key, and no screen has ever shown a theme. What the policy
--    actually published was 40 rows of slug + title + the briefs the pool
--    entries are written from: the whole content strategy, one select away.
--
-- 2. topics.theme_id / theme_confidence / theme_classified_at rode along in
--    every `select *` the client made. A confidence score attached to your
--    own thread is the tell — it says something classified you.
--
-- The client fix (explicit TOPIC_COLS in src/lib/api.ts) stops the app asking
-- for those columns. This stops the database answering, for anything holding
-- a user token.
-- ------------------------------------------------------------

-- 1. entry_themes: no client read. RLS stays enabled with zero policies,
--    which denies everything to anon/authenticated. The edge functions use
--    the service key and bypass RLS, so classification is unaffected.
drop policy if exists entry_themes_read on public.entry_themes;

-- 2. Column-level revoke on the theme columns. Belt and braces with
--    TOPIC_COLS: if a future `select *` slips into the client, PostgREST
--    refuses the request instead of quietly widening the response.
--
--    Grants are per-column here, so this must list every column the client is
--    allowed to read. Adding a user-facing column to topics means adding it
--    to this grant AND to TOPIC_COLS.
revoke select on public.topics from authenticated;
grant select (
  id, user_id, title, description, status, focus,
  created_at, concluded_at,
  seed_book_number, seed_chapter, seed_verse_start, seed_verse_end,
  seed_verse_ref, seed_verse_text
) on public.topics to authenticated;

-- Writes are unchanged — RLS still decides which rows, this only narrows
-- which columns can be read back.
