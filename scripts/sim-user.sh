#!/usr/bin/env bash
# Print the user id the app in the booted Simulator is ACTUALLY signed in as.
#
#   bash scripts/sim-user.sh
#
# Why this exists: seed-screenshots.mjs --latest-anon targets the newest
# anonymous user by created_at, which is not necessarily the one whose session
# the app restored. When those diverge you seed one account and the app runs
# as another — the demo data is invisible and the paywall stays up.
#
# Reads the persisted Supabase session out of the app's NSUserDefaults
# (where @capacitor/preferences puts it) and decodes the JWT's `sub` claim.
# Read-only; touches nothing.

set -euo pipefail

BUNDLE_ID="au.com.ponder.app"

die() { printf '\n  ERROR: %s\n\n' "$1" >&2; exit 1; }

command -v xcrun >/dev/null || die "xcrun not found — install Xcode command line tools."

container=$(xcrun simctl get_app_container booted "$BUNDLE_ID" data 2>/dev/null) \
  || die "App not installed on the booted Simulator. Run it once from Xcode."

plist="$container/Library/Preferences/$BUNDLE_ID.plist"
[ -f "$plist" ] || die "No preferences file yet — the app has not completed a launch."

# NOTE: do not pipe plutil into `python3 - <<'PY'`. The heredoc is already
# stdin, so the piped JSON is discarded and json.load sees the script itself.
tmp=$(mktemp -t ponder-prefs)
trap 'rm -f "$tmp"' EXIT
plutil -convert json -o "$tmp" "$plist" || die "Could not read $plist"

python3 - "$tmp" <<'PY'
import base64, json, sys

with open(sys.argv[1]) as fh:
    prefs = json.load(fh)

# @capacitor/preferences namespaces every key with this prefix.
# Supabase's session key is sb-<project-ref>-auth-token.
candidates = {
    k: v for k, v in prefs.items()
    if "auth-token" in k and isinstance(v, str)
}

if not candidates:
    print("\n  No stored session found.")
    print("  The app has no persisted account — the next launch will mint a")
    print("  new anonymous user. Launch it, then re-run this.\n")
    raise SystemExit(1)

for key, raw in candidates.items():
    try:
        session = json.loads(raw)
    except json.JSONDecodeError:
        print(f"\n  {key}: present but not JSON — session may be corrupt.\n")
        continue

    token = session.get("access_token", "")
    parts = token.split(".")
    if len(parts) != 3:
        print(f"\n  {key}: no usable access_token.\n")
        continue

    payload = parts[1]
    payload += "=" * (-len(payload) % 4)          # restore base64url padding
    claims = json.loads(base64.urlsafe_b64decode(payload))

    print()
    print(f"  Signed in as   {claims.get('sub')}")
    print(f"  anonymous      {claims.get('is_anonymous', 'unknown')}")
    print(f"  role           {claims.get('role')}")
    print()
    print("  Seed THIS user (not --latest-anon):")
    print()
    print(f"    SCREENSHOT_USER_ID={claims.get('sub')} \\")
    print("      node scripts/seed-screenshots.mjs --force")
    print()
PY
