# Ponder — Claude Code guide

Devotional app, formerly "Promptings". Owner: Antonio (not a developer — plain
language, short replies, one decision at a time as 2–4 labelled options,
multi-step procedures one step at a time).

## Project facts
- Stack: Capacitor + React + TypeScript + Tailwind (Vite).
- Supabase project ref `rkslrbcbncecekghwbap` (named "promptings" — expected).
- Edge functions: `generate-entry`, `synthesize`, `rc-webhook`, `delete-account`
  (plus `guardrail-preview`: a throwaway old-vs-new guardrail 4 comparison
  tool, source pulled from live v1; delete once that decision is made).
  `generate-entry` and `synthesize` MUST keep `verify_jwt` OFF, or pg_cron/pg_net
  calls break. Auth is checked inside each function.
- Claude API is called only from edge functions, never from the app.
- iOS bundle `au.com.ponder.app`; Android `com.jrvsolutions.ponder`.
  Store name "Ponder: Daily Discernment".
- UI says "Thread"; DB and TS still say `topic`. Deliberate — don't rename.
- Live users on both stores and there is NO forced update: every backend change
  must keep old app builds working.
- Lovable is not used. Never suggest syncing to it.

## Hard rules
1. Never push to `main` or deploy to production without explicit confirmation from Antonio. Flag it and wait.
2. No schema change without a migration file and Antonio's approval. Warn whenever ANY change could affect existing users.
3. Never use column-level GRANT/REVOKE on a client-read table, and never drop a column a shipped client selects (25 Aug outage). Hidden data goes in a service-only side table.
4. Verse text always comes from `bible_verses`, never from model output.
5. Anthropic Batch API `custom_id` must not contain a colon (killed nightly generation 6 Aug).
6. Generated entries must never state or imply how long a reader has been on a thread.
7. Support/"Chip In" is a one-off contribution that unlocks nothing. No tiers.
8. The repo is not evidence of what is deployed. Diff against the live function before any deploy.
9. Every edge function deploy must pass `deno check` first (23 Sep v34 BOOT_ERROR came from skipping this).

## Workflow (runs on Antonio's Mac — no sandbox)
The Supabase CLI is logged in and linked, so it reaches supabase.co directly.

Read-only checks (safe any time):
- `supabase functions list --project-ref rkslrbcbncecekghwbap` — live versions
- `supabase functions download <name> --project-ref rkslrbcbncecekghwbap`
  — run it inside a temp dir (it writes `supabase/functions/<name>/`), then diff
- `supabase migration list --linked` — which migrations prod has recorded
- `supabase db query --linked "select …"` — read-only SQL (no psql installed).
  Only SELECTs unless Antonio has approved a change.
- `supabase secrets list --project-ref …` — names only

Before any edge function deploy (only after Antonio says yes):
1. Download live, diff against local, explain every difference.
2. `deno check --no-lock --node-modules-dir=none supabase/functions/<name>/index.ts`
   — must exit 0 (it prints "Check …" only on a fresh check; a cached pass is
   silent, so judge by the exit code). Both flags are needed: without them
   Deno trips over the app's root `package.json`/`node_modules` (`npm:jose@5`
   not found) and drops a stray `deno.lock` in the repo root.
3. Deploy, then confirm the new version is ACTIVE and watch the logs.

Before any migration: additive only where possible, check shipped clients'
`select` lists (`src/lib/api.ts`), get approval, then `supabase db push`.
Order: backend/migration first, app build second.

## Known traps
- Local `generate-entry/index.ts` can drift from live. On 24 Sep live v35 was
  hotfixed from chat (duplicate `Facet`/`parseFacets`/`ensureFacets`); the
  snapshot branch still had the duplicates.
- Client code selects explicit column lists. A build that selects a column prod
  doesn't have yet (e.g. `profiles.text_scale`) fails the whole query.
- Migrations have been run by hand in the SQL editor before. Check
  `supabase migration list --linked` AND that the objects exist.
- Verse walk (code name "Meditate", never shown to readers): phrases live in
  `daily_entries.meditation` / `entry_pool.meditation`, keyed by translation.
  Picked in `generate-entry/meditation.ts` (Sonnet via `MODEL_MEDITATION`)
  and kept only if verbatim in that translation. The 1,845 pool entries
  built before 26 Sep 2026 have none, by Antonio's choice (no backfill).
  `scripts/meditation-preview.ts` previews picks without writing anything.
- `generate-entry` imports `spotify.ts`; song lookup is dormant until
  `SPOTIFY_CLIENT_ID`/`SPOTIFY_CLIENT_SECRET` secrets are set.
- Old build artefacts clutter the root (`vite.config.ts.timestamp-*`, deploy
  zips, `_to_delete/`, `_presync_backups/`). Ignore them; don't commit more.
