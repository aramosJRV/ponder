#!/usr/bin/env bash
# Interactive screenshot capture for the Ponder store listings.
#
#   bash store/capture.sh paywall    # ONE shot, run BEFORE seeding
#   bash store/capture.sh restart    # force-quit + relaunch, no reinstall
#   bash store/capture.sh listing    # SIX iPhone shots, run AFTER seeding
#   bash store/capture.sh ipad       # SIX iPad shots, run AFTER seeding
#
# Handles folders, status-bar cleanup, and dimension checks so the only
# thing you do is set up each screen in the Simulator and press Enter.
#
# IPAD: the iPad Simulator is a separate container, so it has its own
# anonymous account and none of the demo data. Shut the iPhone Simulator down
# first (`booted` is ambiguous with two running), launch the app on the iPad,
# then run scripts/sim-user.sh and seed THAT user before capturing.

set -euo pipefail

cd "$(dirname "$0")/.."
RAW="store/screenshots/raw"
RAW_IPAD="store/screenshots/raw-ipad"
REVIEW="store/screenshots/review"
# iOS bundle id differs from capacitor.config.ts appId on purpose — see the
# comment in that file. This is the one the Simulator knows about.
BUNDLE_ID="au.com.ponder.app"

die() { printf '\n  ERROR: %s\n\n' "$1" >&2; exit 1; }

command -v xcrun >/dev/null || die "xcrun not found — install Xcode command line tools."
xcrun simctl list devices booted | grep -q "Booted" \
  || die "No Simulator is booted. Open Simulator and run the app first."

# More than one booted Simulator makes `booted` ambiguous — simctl picks one
# arbitrarily and you can end up capturing the wrong device without noticing.
booted_count=$(xcrun simctl list devices booted | grep -c "Booted" || true)
if [ "$booted_count" -gt 1 ]; then
  printf '\n  ERROR: %s Simulators are booted:\n\n' "$booted_count" >&2
  xcrun simctl list devices booted | grep "Booted" | sed 's/^/    /' >&2
  printf '\n  "booted" is ambiguous. Shut all but one down:\n' >&2
  printf '    xcrun simctl shutdown "iPhone 17 Pro Max"\n\n' >&2
  exit 1
fi

booted=$(xcrun simctl list devices booted | grep "Booted" | head -1 | sed 's/^ *//')

# Expected capture size, set per mode below.
EXPECT="1320x2868"

check_device() {
  local want=$1 label=$2
  case "$booted" in
    *"$want"*) : ;;
    *) printf '\n  WARNING: booted device is:\n    %s\n' "$booted"
       printf '  This mode expects %s (%s).\n' "$label" "$EXPECT"
       printf '  Press Enter to continue anyway, or Ctrl-C to switch device.\n'
       read -r ;;
  esac
}

# Capture one shot, then verify it is the size the store expects.
shoot() {
  local out=$1
  xcrun simctl io booted screenshot --type=png "$out" >/dev/null 2>&1
  local dims
  dims=$(sips -g pixelWidth -g pixelHeight "$out" 2>/dev/null \
         | awk '/pixel/ {printf "%s", $2 (NR==1 ? "x" : "")}')
  if [ "$dims" = "$EXPECT" ]; then
    printf '    saved %s  (%s)\n' "$out" "$dims"
  else
    printf '    saved %s  -- WARNING: %s, expected %s\n' "$out" "$dims" "$EXPECT"
  fi
}

# The six screens, shared by the iPhone and iPad passes.
shots=(
  "Today|Focus thread 'Learning to be still', today's entry. Scroll so the passage card and the start of the thought are both visible. Include the Sources footnote if it fits."
  "Challenge entry|NOT reachable from Today — that screen only ever shows today's date. Go: Threads > 'Learning to be still' > Entries tab > the 16 Aug entry (Isaiah 30:15, seeded at days_ago 1, carries the CHALLENGE badge) > tap to open. Scroll so the badge and the first lines of the thought show, with nothing clipped under the status bar."
  "Threads|The threads list, not scrolled. Two active, one concluded, status chips and last-note previews showing."
  "Journal|Open 'Learning to be still' > Journal tab. All three notes visible in sequence."
  "Synthesis|Open 'Learning to be still' > Synthesis tab. Expand far enough to show threads AND tensions."
  "Settings|Challenge-frequency slider and notification time both visible."
)

run_shot_series() {
  local outdir=$1
  local i=1
  for entry in "${shots[@]}"; do
    local screen=${entry%%|*}
    local setup=${entry#*|}
    printf '\n  ------------------------------------------------------------\n'
    printf '  SHOT %d of 6  --  %s\n\n' "$i" "$screen"
    printf '  %s\n\n' "$setup"
    printf '  Press Enter to capture.'
    read -r
    shoot "$(printf '%s/%02d.png' "$outdir" "$i")"
    i=$((i + 1))
  done
}

case "${1:-}" in

  paywall)
    mkdir -p "$REVIEW"
    cat <<'EOF'

  PAYWALL SHOT  (for Apple's subscription review record, NOT the listing)

  In the Simulator: launch the app fresh. The paywall is the first screen.
  Do NOT tap "Start free trial" — that starts a real sandbox subscription.

  Press Enter when the paywall is on screen.
EOF
    read -r
    shoot "$REVIEW/paywall.png"
    cat <<'EOF'

  Done. Next:

    node scripts/seed-screenshots.mjs --latest-anon
    (then force-quit and relaunch the app in the Simulator)
    bash store/capture.sh listing

EOF
    ;;

  restart)
    # Equivalent to force-quitting and tapping the icon. Deliberately NOT a
    # reinstall: reinstalling wipes the app container, which loses the stored
    # session and mints a fresh anonymous account — the exact thing that puts
    # the paywall back after seeding. Never relaunch from Xcode after step 4.
    printf '\n  Terminating %s...\n' "$BUNDLE_ID"
    xcrun simctl terminate booted "$BUNDLE_ID" 2>/dev/null || true
    sleep 1
    printf '  Launching...\n'
    xcrun simctl launch booted "$BUNDLE_ID" >/dev/null \
      || die "Launch failed — is the app installed on this Simulator? Run it once from Xcode."
    printf '\n  Done. Give it a couple of seconds to reach the Today screen.\n\n'
    ;;

  listing)
    EXPECT="1320x2868"
    check_device "Pro Max" "iPhone 16/17 Pro Max"
    mkdir -p "$RAW"
    rm -f "$RAW"/*.png

    printf '\n  Cleaning the status bar (9:41, full battery)...\n'
    xcrun simctl status_bar booted override \
      --time "9:41" --batteryState charged --batteryLevel 100 \
      --cellularBars 4 --wifiBars 3

    printf '\n  SIX iPHONE SHOTS. Set up each screen, then press Enter.\n'
    printf '  Nothing is captured until you press Enter, so take your time.\n'
    run_shot_series "$RAW"

    printf '\n  ------------------------------------------------------------\n'
    printf '  All six captured in %s\n\n' "$RAW"
    printf '  Before compositing, check each one for anything real:\n'
    printf '    - your email address in Settings\n'
    printf '    - a notification preview\n'
    printf '    - a thread title that is not one of the three seeded ones\n\n'
    printf '  Then run: python3 store/make-screenshots.py\n\n'
    ;;

  ipad)
    # 13" iPad Pro (M4) is 1032x1376 pt @2x = 2064x2752, the 2026 canonical
    # size. The older 12.9" at 2048x2732 is still accepted by App Store
    # Connect, so a warning here is not necessarily fatal — check the number.
    EXPECT="2064x2752"
    check_device "iPad Pro" "iPad Pro 13-inch (M4)"
    mkdir -p "$RAW_IPAD"
    rm -f "$RAW_IPAD"/*.png

    printf '\n  Cleaning the status bar (9:41, full battery)...\n'
    xcrun simctl status_bar booted override \
      --time "9:41" --batteryState charged --batteryLevel 100 \
      --wifiBars 3

    cat <<'EOF'

  SIX iPAD SHOTS.

  This Simulator has its OWN anonymous account and none of the demo data.
  If you have not already done so:

    bash scripts/sim-user.sh          # prints the iPad's user id
    SCREENSHOT_USER_ID=<that id> node scripts/seed-screenshots.mjs
    bash store/capture.sh restart

  Same six screens as the iPhone pass.
EOF
    run_shot_series "$RAW_IPAD"

    printf '\n  ------------------------------------------------------------\n'
    printf '  All six captured in %s\n\n' "$RAW_IPAD"
    printf '  Then run: python3 store/make-screenshots.py\n\n'
    ;;

  *)
    die "Usage: bash store/capture.sh [paywall|restart|listing|ipad]"
    ;;
esac
