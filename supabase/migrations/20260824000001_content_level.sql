-- Content level — how much of each entry the reader sees by default.
--
-- 1 = passage + questions to ponder
-- 2 = + the thought
-- 3 = + illustration, prayer prompts, song   (default, the full entry)
--
-- This is a DISPLAY preference only. Generation is untouched: every entry is
-- still written in full and every field is still stored. Levels that drove
-- generation would fragment the shared entry pool by level as well as by
-- theme, multiplying the nightly bill, and would leave a reader's existing
-- back-catalogue inconsistent the moment they changed the setting.

alter table public.profiles
  add column if not exists content_level smallint not null default 3
    check (content_level between 1 and 3);

comment on column public.profiles.content_level is
  'Display-only: default fold state of an entry card. 1=passage+ponder, 2=+thought, 3=full. Never affects generation.';
