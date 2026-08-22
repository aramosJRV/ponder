# Store screenshots — capture guide

Six shots, captured once on one Simulator device, composited into both
Apple and Play sets by `store/make-screenshots.py`.

---

## Sizes (verified July 2026 — these changed, don't work from memory)

**Apple.** One iPhone set only. Upload at **1320 × 2868** (6.9", iPhone 16/17
Pro Max) and App Store Connect scales it for every smaller iPhone. The old
requirement to supply separate 6.7" and 6.5" sets is gone. sRGB PNG or JPEG,
no transparency.

**Play.** Portrait phone at **1080 × 1920**. Minimum 2, maximum 8. Hard rule:
the longest side may not exceed twice the shortest. Apple's 1320 × 2868 is
1:2.17, so it **fails** that check — this is why the script builds two
canvases instead of resizing one. 24-bit PNG or JPEG, no alpha, ≤ 8 MB each.

---

## Step 1 — boot the Simulator and launch once

Do this **before** seeding. The app has no sign-in screen: first launch calls
`signInAnonymously()` and that anonymous user *is* the account. Email is only
ever used for backup/restore via OTP. So the demo data has to be written onto
the user the Simulator creates — there's nothing to log in as.

```
xcrun simctl list devices available | grep "Pro Max"
open -a Simulator
```

Pick **iPhone 16 Pro Max** (Device menu) — 440 × 956 pt @3x = exactly
1320 × 2868. Any other device gives the wrong pixel size.

```
npm run build && npx cap sync ios && npx cap open ios
```

Run in Xcode with the Simulator as target. Let the app reach its empty
Today screen, which confirms the anonymous user exists.

---

> ⚠️ Since the subscription landed, first launch shows the **paywall**, not an
> empty Today screen. That is expected and is not a failure — the seed in
> step 2 grants the entitlement that gets you past it. Don't tap *Start free
> trial*; you'd start a real sandbox subscription for no reason.

---

## Step 2 — seed that user

Never screenshot your own threads. They become permanently public.

```
cd ~/Documents/Claude/Projects/Ponder
node scripts/seed-screenshots.mjs --latest-anon
```

As well as the three threads, this grants the user a one-year **sandbox**
entitlement. Without it the hard paywall blocks every screen on this list and
there is nothing to capture. The row is written with
`rc_app_user_id = screenshot-seed:<uuid>` and `environment = SANDBOX`, so it
can't be confused with a real purchase.

Targets the most recently created anonymous user — on a fresh Simulator
that's definitionally the one just minted. It prints the target user id
before writing, and refuses to wipe a user that already has threads unless
you add `--force`.

Seeds three threads: *Learning to be still* (active, focus, 5 entries incl.
one challenge, 3 notes, 1 synthesis), *Whether to say yes to the new role*
(active, 2 entries, 1 note), *Holding money more loosely* (concluded, 2
entries, 2 notes, conclusion synthesis).

Force-quit the app in the Simulator and relaunch to pick up the new rows.

---

## Step 2b — clean the status bar

So the shots don't show a random time and a half-dead battery:

```
xcrun simctl status_bar booted override \
  --time "9:41" --batteryState charged --batteryLevel 100 \
  --cellularBars 4 --wifiBars 3
```

---

## Step 3 — capture

Use `simctl`, not Cmd+S — it writes exact device pixels with no window
chrome or shadow.

**Create the folder first** — as of 2026-08-16 it doesn't exist; there are no
placeholders and no previous output. If you re-run later, clear it so stale
captures don't get composited.

```
mkdir -p store/screenshots/raw
rm -f store/screenshots/raw/*.png store/screenshots/appstore/*.png store/screenshots/play/*.png
```

Then, for each shot, set up the screen and run:

```
xcrun simctl io booted screenshot --type=png store/screenshots/raw/01.png
```

### Shot list

| # | Screen | State to set up | Caption it gets |
|---|--------|-----------------|-----------------|
| 01 | **Today** | Focus thread *Learning to be still*, today's affirming entry. Scroll so the passage card and the opening of the thought are both visible. | One passage. One thought. One question to carry. |
| 02 | **Today** | Switch to yesterday's **challenge** entry so the challenge badge is visible. Scroll to show the badge plus a few lines. | Some mornings it pushes back. |
| 03 | **Threads** | The list, unscrolled — two active, one concluded, showing status chips and last-note previews. | Follow several threads at once. |
| 04 | **Thread detail → Journal** | *Learning to be still*, Journal tab, showing all three notes in sequence. | Every note you've written, in one place. |
| 05 | **Thread detail → Synthesis** | *Learning to be still*, Synthesis tab, the seeded synthesis expanded far enough to show threads + tensions. | See what's emerging over weeks, not days. |
| 06 | **Settings** | Challenge-frequency slider and notification time visible. | You set the pace — and how hard it presses. |

### Plus one that is not a listing screenshot

| # | Screen | Purpose |
|---|--------|---------|
| — | **Paywall** | Apple's **subscription review screenshot**. Required on the subscription record itself. |

Capture it *before* running the seed, while the app still shows the paywall
on launch:

```
xcrun simctl io booted screenshot --type=png store/screenshots/raw/paywall.png
```

Then move it out of `raw/` so the compositor doesn't pick it up:

```
mkdir -p store/screenshots/review
mv store/screenshots/raw/paywall.png store/screenshots/review/
```

It is uploaded in App Store Connect under **Subscriptions → Ponder Annual →
Review Information → Screenshot**, *not* under the app's Previews and
Screenshots. Keep it out of the store listing: a paywall is a poor first
impression and Apple doesn't want one there either.

---

Two things worth deliberately including in the six listing shots, because
they're the honest answer to both stores' AI-disclosure questions and they're
a differentiator:

- The **Sources footnote** at the bottom of an entry (shot 01 or 02 if you
  can fit it). Every seeded entry has validated cross-references.
- The **challenge badge** (shot 02). Nothing else in this category
  advertises that it will argue with you.

---

## Step 4 — composite

Run in the sandbox (Claude can do this) or locally with Pillow installed:

```
python3 store/make-screenshots.py
```

Reads `store/screenshots/raw/*.png` in filename order, matches each to its
caption by position, writes `store/screenshots/appstore/` (1320 × 2868) and
`store/screenshots/play/` (1080 × 1920).

Captions live in `CAPTIONS` at the top of that script. They auto-shrink to
fit the canvas, so rewording is safe. Headlines set in Lora — the sandbox has
no Cormorant Garamond, same substitution as the Play feature graphic. The
script prefers Cormorant automatically if it finds it installed.

---

## Step 5 — upload

- **App Store Connect** → your app → 1.0 Prepare for Submission → Previews
  and Screenshots → iPhone 6.9" → drag all six from `appstore/`.
- **Play Console** → Store listing → Phone screenshots → drag from `play/`.

Before uploading, check every shot for anything real: an email address in
Settings, a notification preview, a thread title that isn't one of the three
seeded ones.
