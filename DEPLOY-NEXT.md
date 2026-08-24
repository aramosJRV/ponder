# What actually needs deploying — verified against prod 24 Aug 2026

Written after checking the live `promptings` database (ref `rkslrbcbncecekghwbap`,
branch `main` PRODUCTION) directly. This file supersedes the readiness claims in
`HANDOFF.md`, `LAUNCH.md` and `HANDOVER-FREE-TIER-2026-08-23.md`, all of which
describe work that is written but **not deployed**.

## Live state

`supabase_migrations.schema_migrations` tops out at `20260822000001`.

| Object | In prod? |
|---|---|
| `entry_pool` | NO |
| `spend_ledger` | NO |
| `daily_entries.song` | NO |
| `topics.theme_id` | NO |
| `profiles.content_level` | YES (applied by hand 24 Aug) |
| `generation_failures` | YES (older migration) |

Nightly generation is healthy — 13 entries 23 Aug, 9 on 24 Aug — **because** the
deployed edge functions are still the pre-pool versions and match the pre-pool
schema. `generation_failures`: `batch_parse x6` on 23 Aug, nothing since.

## The trap

The free-tier and pool gates fail CLOSED. Deploying `generate-entry` from source
before the migrations land means nothing generates. Do the whole sequence in one
sitting.

## Sequence

    cd ~/Documents/Claude/Projects/Ponder

    # 1. See what push thinks is outstanding. Expect the three 20260823*
    #    migrations plus 20260824000001_content_level.
    npx supabase migration list

    # 2. Apply them. content_level is idempotent (add column if not exists),
    #    so it re-runs harmlessly and gets recorded properly. Do NOT run
    #    `migration repair` for it.
    npx supabase db push

    # 3. Immediately after — back to back, no gap.
    npx supabase functions deploy generate-entry --no-verify-jwt
    npx supabase functions deploy synthesize --no-verify-jwt

    # 4. Confirm the schema landed.
    #    entry_pool, spend_ledger, daily_entries.song, topics.theme_id
    #    should all now exist.

If step 2 errors with "already exists" on one of the 20260823 migrations, stop
and check `migration list` before repairing anything — something was applied by
hand and you need to know how much of it landed. `create or replace` functions
are idempotent; bare `create trigger` and `add constraint` are not.

## Then verify, don't assume

- One nightly cycle produces entries (`select count(*) from daily_entries where date = current_date`).
- `entry_pool` starts filling — `run_pool_topup()` runs hourly at :35.
- Known gap: the pool builder does not generate songs, so pooled entries have
  `song = null`. That is a visible difference between a pooled and a live entry
  and contradicts the "experience never differs" rule. Close it before the pool
  carries real traffic.

## Unrelated loose end

`src/screens/Paywall.tsx` is orphaned. `git rm` it.
