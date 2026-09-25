-- Text size — the reader's own display scale for every font size in the app.
--
-- Stored as a percentage so the column stays an integer:
--   100 = Default       (the sizes everyone sees today)
--   140 = Comfortable
--   200 = Large         (matches the Android system ceiling)
--
-- DISPLAY ONLY, exactly like content_level. It never reaches a prompt, a batch
-- request or a pool lookup — entries are generated and stored identically
-- whatever this is set to.
--
-- Why the range and not just the three rungs: the native layer reads the OS
-- text size on first run and seeds this to the nearest rung, and the ladder may
-- gain rungs later. A CHECK tied to the exact three values would turn that into
-- a migration. 100–200 is the useful range either way — below 100 the app would
-- be smaller than it has ever shipped, and 200 is where both platforms stop.
--
-- Idempotent on purpose (see content_level): a later `supabase db push` can
-- re-run this harmlessly and record it properly.

alter table public.profiles
  add column if not exists text_scale smallint not null default 100
    check (text_scale between 100 and 200);

comment on column public.profiles.text_scale is
  'Display-only: reader text size as a percent. 100=Default, 140=Comfortable, 200=Large. Drives --font-scale on the client. Never affects generation.';
