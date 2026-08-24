-- ============================================================
-- Song of the day.
--
-- Populated by generate-entry ONLY with a track that was found on
-- Spotify AND whose title+artist matched what the model asked for.
-- The model never supplies a URL or track id — only a title and an
-- artist name, which are then looked up. Unmatched suggestions are
-- dropped and logged to generation_failures (stage = 'song_dropped').
--
-- Shape:
--   { "track_id": "1301WleyT98MSxVHPZCA6M",
--     "name": "Be Still My Soul",
--     "artist": "Kari Jobe",
--     "url": "https://open.spotify.com/track/1301WleyT98MSxVHPZCA6M",
--     "art": "https://i.scdn.co/image/...",
--     "asked": { "title": "Be Still My Soul", "artist": "Kari Jobe" } }
--
-- `asked` is kept for drift debugging: what the model wanted, versus
-- what Spotify actually returned. Never rendered.
--
-- NULL is a valid and expected value — always on challenge entries
-- (they arrive deliberately quieter), and whenever a suggestion did
-- not resolve. No song is always better than a broken link.
-- ============================================================

alter table public.daily_entries
  add column if not exists song jsonb;

-- idempotent: `add constraint` has no IF NOT EXISTS form
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'daily_entries_song_is_object'
      and conrelid = 'public.daily_entries'::regclass
  ) then
    alter table public.daily_entries
      add constraint daily_entries_song_is_object
      check (song is null or (
        jsonb_typeof(song) = 'object'
        and song ? 'track_id' and song ? 'name'
        and song ? 'artist'   and song ? 'url'
      ));
  end if;
end $$;

-- Repeat-avoidance lookup: "which tracks has this thread already used?"
create index if not exists daily_entries_song_track_idx
  on public.daily_entries ((song ->> 'track_id'))
  where song is not null;

comment on column public.daily_entries.song is
  'Verified Spotify track for this entry, or NULL. Every field came from a Spotify API response, never from model output. NULL on all challenge entries by design. See 20260823000001.';
