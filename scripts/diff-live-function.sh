#!/bin/bash
# Compare a deployed edge function with the local source, ignoring the
# formatting/type/comment noise the download adds. Read-only.
#   bash scripts/diff-live-function.sh generate-entry [git-ref]
# With a git ref, compares live against that commit instead of the working tree.
set -euo pipefail
fn=$1; ref=${2:-}
root=$(cd "$(dirname "$0")/.." && pwd)
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
(cd "$tmp" && supabase functions download "$fn" --project-ref rkslrbcbncecekghwbap >/dev/null 2>&1)
mkdir -p "$tmp/local"
if [ -n "$ref" ]; then
  git -C "$root" archive "$ref" "supabase/functions/$fn" | tar -x -C "$tmp/local"
else
  cp -R "$root/supabase/functions/$fn" "$tmp/local/"; mkdir -p "$tmp/local/supabase/functions"; mv "$tmp/local/$fn" "$tmp/local/supabase/functions/"
fi
esb="$root/node_modules/.bin/esbuild"
status=0
for f in $(cd "$tmp/supabase/functions/$fn" && ls); do
  norm() { "$esb" --loader=$2 --minify-whitespace --log-level=error < "$1" | tr ";{}" "\n\n\n"; }
  a=$(norm "$tmp/local/supabase/functions/$fn/$f" ts); b=$(norm "$tmp/supabase/functions/$fn/$f" ts)
  if [ "$a" == "$b" ]; then echo "same: $f"; else echo "DIFFERENT: $f"; diff <(echo "$a") <(echo "$b") | head -40; status=1; fi
done
for f in $(cd "$tmp/local/supabase/functions/$fn" && ls); do
  [ -e "$tmp/supabase/functions/$fn/$f" ] || echo "local only (not deployed): $f"
done
exit $status
