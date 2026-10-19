#!/bin/bash
# usage: mutate.sh <file> <test cmd> <sed expr>...  — each mutation must make the tests fail
export NO_COLOR=1
f=$1; t=$2; shift 2; cp "$f" /tmp/mut.bak; bad=0
for m in "$@"; do
  cp /tmp/mut.bak "$f"; sed -i '' "$m" "$f"
  if cmp -s "$f" /tmp/mut.bak; then echo "NOT APPLIED: $m"; bad=1; continue; fi
  if bash -c "$t" >/dev/null 2>&1; then echo "SURVIVED (tests missed it): $m"; bad=1; else echo "caught: $m"; fi
done
cp /tmp/mut.bak "$f"; bash -c "$t" >/dev/null 2>&1 && echo "restored: tests pass" || { echo "RESTORED FILE FAILS"; bad=1; }
exit $bad
