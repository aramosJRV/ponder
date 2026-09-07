-- ------------------------------------------------------------
-- Tighten the pool confidence gate: 0.6 -> 0.75
--
-- WHY (7 Sep 2026):
-- The thread "Holy Spirit In Me" was classified into `prayer-life` at
-- confidence EXACTLY 0.6 and was served 2 of 2 entries from the pool. Both
-- read as generic prayer/identity material and never touched the Holy Spirit
-- at all — the reader noticed immediately. This is the failure predicted in
-- the pool design notes: a specifically-worded thread pooled against a brief
-- that does not cover it.
--
-- The classifier is instructed to return an empty slug on a poor fit. It
-- didn't; it hedged with a round middling number. Language models emit
-- confidence in one-decimal steps almost exclusively, so 0.6 and 0.7 are the
-- two hedge values and 0.8+ is where genuine matches land.
--
-- 0.75 with the existing strict `<` therefore rejects both hedges and admits
-- only 0.8/0.9-class matches, without introducing a boundary-equality
-- subtlety (a floor of 0.7 would let a hedged 0.7 through in exactly the way
-- 0.6 got through here).
--
-- SELF-HEALING, NO SPEND: threads already sitting between 0.6 and 0.75 keep
-- their topic_themes row, so ensureTheme() will not reclassify or re-charge
-- for them. They simply stop qualifying for the pool and fall through to
-- per-user live generation from their own description — which is the correct
-- outcome and the one the reader expected.
--
-- COST: shifts some threads from pooled to live generation. At current
-- volume this is cents per month against a US$150 tripwire, and the tripwire
-- never gates a user-facing path.
-- ------------------------------------------------------------

create or replace function public.pool_confidence_floor()
returns real
language sql
immutable
as $$ select 0.75::real; $$;

comment on function public.pool_confidence_floor() is
  'Minimum classifier confidence for a thread to be served from the shared '
  'entry pool. Raised 0.6 -> 0.75 on 2026-09-07 after a thread admitted at '
  'exactly 0.6 received pool entries that missed its subject entirely. '
  'select_pool_entry() rejects strictly below this value.';

-- ------------------------------------------------------------
-- Verify
--
--   -- the new floor
--   select public.pool_confidence_floor();
--
--   -- threads that were pool-eligible under 0.6 and no longer are;
--   -- expect "Holy Spirit In Me" among them
--   select t.title, e.slug, tt.confidence
--     from public.topic_themes tt
--     join public.topics t       on t.id = tt.topic_id
--     left join public.entry_themes e on e.id = tt.theme_id
--    where tt.confidence >= 0.6 and tt.confidence < 0.75
--    order by tt.confidence;
--
--   -- distribution, to see how much of the pool's reach this costs
--   select width_bucket(confidence, 0, 1, 10) * 0.1 as bucket, count(*)
--     from public.topic_themes where theme_id is not null
--    group by 1 order by 1;
-- ------------------------------------------------------------
