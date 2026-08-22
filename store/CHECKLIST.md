# Ponder store screenshots — start to finish

Six listing shots for both stores, plus one paywall shot for Apple's
subscription record. About 30 minutes.

`SCREENSHOTS.md` is the reference doc — sizes, reasoning, shot rationale.
This file is the thing you actually follow.

---

## Before you start

**Every command is typed in Terminal.** Nothing is typed into Xcode.

Three windows are involved:

| Where | What you do there |
|---|---|
| **Terminal** | Every command. Open it once, stay in it. |
| **Xcode** | Press Run. Once, in step 2. That's the only thing. |
| **Simulator** | Navigate the app to set up each screen. Force-quit and relaunch. |

**The one rule that will save you an hour:** after step 4, never relaunch the
app from Xcode. Relaunch by **tapping the app icon in the Simulator**. Xcode
reinstalls the app, and a reinstall can lose the stored session — which means
a new anonymous account, which means the demo data you just seeded belongs to
somebody else and you're back at the paywall.

Open Terminal and start here. Every command assumes you're in this folder:

```
cd ~/Documents/Claude/Projects/Ponder
```

---

## 1. Pick the right simulator

Open the Simulator app:

```
open -a Simulator
```

Simulator menu → **Device** → **iPhone 16 Pro Max** *or* **iPhone 17 Pro Max**.
Either works — both are 440 × 956 pt @3x = **1320 × 2868**, which is what
Apple requires.

Nothing else is usable. iPhone 16/17 **Pro** is 1206 × 2622; **Plus** is
1290 × 2796. The capture script checks every shot and warns you if the size is
wrong, so you'll find out immediately rather than at upload.

If the device isn't in the menu, create it: Xcode → **Window → Devices and
Simulators** → **Simulators** tab → **+** → pick the device → Create. If it's
not in that dropdown either, the runtime isn't installed: Xcode → **Settings →
Components** → download the latest iOS simulator runtime.

---

## 2. Build and run the app

```
npm run build && npx cap sync ios && npx cap open ios
```

Xcode opens. Check the target device in the toolbar is your Pro Max, then
press **Run** (▶). Wait for the app to launch in the Simulator.

**You will see the paywall.** That's expected — the seed in step 4 gets you
past it. **Do not tap "Start free trial"** — that starts a real sandbox
subscription for no reason.

---

## 3. Capture the paywall

This shot is for Apple's subscription review record, *not* the store listing.
It has to happen now, while the paywall is still showing.

```
bash store/capture.sh paywall
```

Press Enter when prompted. Saved to `store/screenshots/review/paywall.png`.

---

## 4. Seed the demo data

Never screenshot your own threads — they become permanently public.

```
node scripts/seed-screenshots.mjs --latest-anon
```

This writes three demo threads and grants a one-year sandbox entitlement to
the newest anonymous user. **Note the user id it prints** — you may need it in
a moment.

Then force-quit and relaunch — from Terminal, not by gesture:

```
bash store/capture.sh restart
```

That's `simctl terminate` followed by `simctl launch`. It is *not* a
reinstall, which matters: reinstalling wipes the app container, loses the
stored session, and mints a fresh anonymous account — putting you straight
back at the paywall. Same reason you don't relaunch from Xcode here.

(The equivalent by hand, if you'd rather: `xcrun simctl terminate booted
au.com.ponder.app` then `xcrun simctl launch booted au.com.ponder.app`.)

You should land on the Today screen with a thread called *Learning to be
still*.

### If you still see the paywall

```
node scripts/check-entitlement.mjs
```

Read-only. It lists every anonymous user newest-first with its entitlement
status and thread count, and tells you which situation you're in:

- **Newest user has no subscription row** — the seed didn't run or errored.
  Re-run it and read the output.
- **A new user appeared since you seeded** — the app minted a fresh account on
  relaunch. Almost always because the relaunch came from Xcode. Re-seed, then
  relaunch by tapping the icon.
- **Newest user is entitled and no new one appeared** — stale app state.
  Force-quit properly and relaunch.

---

## 5. Capture the six listing shots

```
bash store/capture.sh listing
```

It cleans the status bar (9:41, full battery, full signal), then walks you
through the six screens one at a time. For each shot it prints what to set up,
waits, and captures when you press Enter.

The rhythm: read the prompt in Terminal → click to the Simulator → set the
screen up → click back to Terminal → press Enter. Six times. Nothing is
captured until you press Enter, so there's no rush.

The six screens:

| # | Screen | What to show |
|---|---|---|
| 1 | Today | Focus thread *Learning to be still*, today's entry. Passage card and the start of the thought both visible. Include the Sources footnote if it fits. |
| 2 | Challenge entry | **Not reachable from Today** — that screen is hardcoded to today's date. Go Threads → *Learning to be still* → Entries → the 16 Aug entry (Isaiah 30:15) → tap to open. Badge must be visible. |
| 3 | Threads | The list, unscrolled. Two active, one concluded, status chips and last-note previews. |
| 4 | Thread → Journal | *Learning to be still*, Journal tab, all three notes in sequence. |
| 5 | Thread → Synthesis | *Learning to be still*, Synthesis tab, expanded to show threads **and** tensions. |
| 6 | Settings | Challenge-frequency slider and notification time both visible. |

---

## 6. Check the captures

Open `store/screenshots/raw/` in Finder and look at all six. Anything real in
there means recapture that shot:

- your email address in Settings
- a notification preview
- a thread title that isn't one of the three seeded ones

---

## 7. Composite

```
python3 store/make-screenshots.py
```

Produces two sets, composed separately — Apple's 1320 × 2868 is 1:2.17, and
Play rejects anything whose longest side is more than twice its shortest, so
one cannot be resized from the other:

- `store/screenshots/appstore/` — 1320 × 2868, six files
- `store/screenshots/play/` — 1080 × 1920, six files

Captions live in the `CAPTIONS` list at the top of that script and auto-shrink
to fit, so rewording is safe. Headlines set in Lora.

---

## 8. Upload

**App Store Connect** → Ponder → 1.0 Prepare for Submission → Previews and
Screenshots → iPhone 6.9" → drag all six from `appstore/`. Apple scales these
down for every smaller iPhone; no other size is needed.

**App Store Connect** → Subscriptions → Ponder Annual → Review Information →
Screenshot → upload `review/paywall.png`. Different place from the listing
screenshots, easy to miss, and the submission is rejected without it.

**Play Console** → Store listing → Phone screenshots → drag all six from
`play/`. Minimum 2, maximum 8, ≤ 8 MB each.

Keep the paywall shot out of both listings. It's a poor first impression and
Apple doesn't want one there.

---

## 9. Tablet sets

**One capture pass on the iPad Simulator produces all three tablet sets** —
Apple's iPad set plus Play's 10" and 7". You don't capture anything twice.

Apple's is required: `TARGETED_DEVICE_FAMILY` is `"1,2"`, so the app declares
iPad support and App Store Connect rejects the submission without it. Play's
two are optional but you're doing them anyway, and they cost nothing extra
since they're composited from the same captures.

The iPad Simulator is a **separate container** — its own anonymous account,
none of your demo data. That's the whole difficulty here.

```
# Shut the iPhone Simulator down first — "booted" is ambiguous with two up
xcrun simctl shutdown "iPhone 17 Pro Max"

open -a Simulator
# Device menu > iPad Pro 13-inch (M4)
npx cap open ios          # run once from Xcode onto the iPad
```

Then seed the iPad's own account:

```
bash scripts/sim-user.sh
SCREENSHOT_USER_ID=<the id it prints> node scripts/seed-screenshots.mjs
bash store/capture.sh restart
```

Capture and composite:

```
bash store/capture.sh ipad
python3 store/make-screenshots.py
```

Same six screens, captured at 2064 × 2752 into `screenshots/raw-ipad/`, then
composited into three sets:

| Folder | Size | Where it goes |
|---|---|---|
| `screenshots/ipad/` | 2064 × 2752 | App Store Connect → Previews and Screenshots → **iPad 13"** |
| `screenshots/play-tablet-10/` | 1600 × 2560 | Play Console → Store listing → **10-inch tablet screenshots** |
| `screenshots/play-tablet-7/` | 1200 × 1920 | Play Console → Store listing → **7-inch tablet screenshots** |

The compositor skips all three when `raw-ipad/` is empty, so the iPhone pass
still works on its own.

**Expect this to look worse than the phone set.** Ponder is a single-column
phone layout; on a 13" canvas it renders as a narrow column of text with a
stretched tab bar. If the shots look bad enough to hurt the listing, the
alternative is setting `TARGETED_DEVICE_FAMILY = "1"` — iPhone only, no iPad
set needed, and the app still installs on iPad in compatibility mode.

---

## Troubleshooting

| What you see | Fix |
|---|---|
| `No Simulator is booted` | Open Simulator and run the app from Xcode first. |
| `WARNING: booted device is...` | Wrong device. Simulator → Device → iPhone 16/17 Pro Max. |
| `WARNING: 1206x2622, expected 1320x2868` | Wrong device. Switch and recapture that shot. |
| Seed fails on auth | `SUPABASE_SERVICE_ROLE_KEY` missing from `.env`. Dashboard → Project Settings → API Keys → Secret keys. |
| Seed refuses to write | Target user already has threads. Add `--force`. |
| Paywall after seeding | Run `node scripts/check-entitlement.mjs` — see step 4. |
| No data after seeding | You didn't force-quit and relaunch, or you relaunched from Xcode. |

---

## Known issues, not blocking

**Duplicate anonymous accounts.** Seventeen anonymous users existed as of
17 Aug 2026, fourteen created in a single session. `ensureSession()` in
`src/lib/supabase.ts` had no in-flight guard, so React StrictMode's
double-invoked boot effect could mint two accounts per launch — one of which
silently won the persisted session while the other was orphaned. A guard was
added on 17 Aug 2026 and typechecks clean, but has not been confirmed against
a running simulator yet.

To confirm it: note the user count from `check-entitlement.mjs`, force-quit
and relaunch by tapping the icon twice, run it again. The count should not
move. If it does, the fix is incomplete and `@capacitor/preferences`
persistence needs looking at before launch — this is a data-loss path for real
users, not just a screenshot annoyance.

The junk accounts themselves need a SQL cleanup against `auth.users` before
launch. Three of the older ones hold 1–2 threads and may be real early
testing, so check before deleting.
