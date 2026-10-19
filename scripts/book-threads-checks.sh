#!/bin/bash
# Every book-threads check, in one go. Exit 0 only if all pass.
#   bash scripts/book-threads-checks.sh
# The database and end-to-end checks need the private local copy running:
#   bash scripts/localdb-setup.sh
#   supabase functions serve --workdir localdb --env-file localdb/.env.functions --no-verify-jwt
# Nothing here writes to the live project.
cd "$(dirname "$0")/.."
export NO_COLOR=1
D="--no-lock --node-modules-dir=none"
fail=0
step() {
  name=$1; shift
  if out=$("$@" 2>&1); then echo "PASS  $name"; else echo "FAIL  $name"; echo "$out" | tail -25 | sed 's/^/      /'; fail=1; fi
}
step "deno check generate-entry"     deno check $D supabase/functions/generate-entry/index.ts
step "deno check synthesize"         deno check $D supabase/functions/synthesize/index.ts
step "content checker, loop, pacing tests" deno test $D --allow-env --allow-read scripts/ supabase/functions/generate-entry/
step "Phase 1 samples still clean"   deno run $D -A scripts/book-day-preview.ts --check-only
step "database + old-build queries"  deno run $D -A scripts/book-threads-db-check.ts
step "end to end on the local copy"  deno run $D -A scripts/book-threads-e2e.ts
step "app type check and build"      npm run build
[ -e deno.lock ] && { echo "FAIL  stray deno.lock in repo root"; fail=1; }
exit $fail
