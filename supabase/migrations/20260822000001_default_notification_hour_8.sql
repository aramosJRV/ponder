-- The 4am default was inherited from the original cron design (generate while
-- the user sleeps). Generation now runs on its own lead time (see
-- batch_lead_hours), so the notification hour is purely a user-facing reminder
-- time — 4am is a bad one. Default new profiles to 8am local.
alter table public.profiles
  alter column notification_hour set default 8;

-- Move existing profiles still sitting on the old default. Anyone who has
-- deliberately chosen 4am is indistinguishable from someone who never touched
-- it, which is exactly why 4am should never have been the default; the
-- trade-off favours moving them.
update public.profiles
  set notification_hour = 8
  where notification_hour = 4;
