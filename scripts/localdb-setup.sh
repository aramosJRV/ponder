#!/bin/bash
# Build (or rebuild) the PRIVATE local copy of Ponder's database in Docker.
# Reads the live project only (pg_dump of the structure + the shared Bible /
# reference tables). No user data is copied: profiles, threads, entries,
# notes, syntheses, reports, spend and subscriptions are all excluded.
#   bash scripts/localdb-setup.sh
set -euo pipefail
cd "$(dirname "$0")/.."
DB=supabase_db_ponder-local
USER_TABLES="admin_config admin_snapshot admin_users content_reports daily_entries entry_pool entry_pool_seen
  generation_batch_items generation_batches generation_failures notes profiles spend_ledger subscriptions
  syntheses topic_themes topics"

supabase stop --workdir localdb --no-backup >/dev/null 2>&1 || true
if [ ! -f localdb/prod-schema.sql ] || [ "${REFRESH:-}" = 1 ]; then
  supabase db dump --linked -f localdb/prod-schema.sql
  X=$(printf 'public.%s,' $USER_TABLES)
  supabase db dump --linked --data-only --use-copy -s public -x "${X%,}" -f localdb/prod-reference-data.sql
fi
supabase start --workdir localdb
docker exec -i $DB psql -U postgres -q -X -v ON_ERROR_STOP=1 < localdb/prod-schema.sql
docker exec -i $DB psql -U postgres -q -X -v ON_ERROR_STOP=1 < localdb/prod-reference-data.sql
docker exec $DB psql -U postgres -tAc "select count(*) || ' verses' from public.bible_verses"
