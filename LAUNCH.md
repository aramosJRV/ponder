# Ponder — launch runbook

Everything left to ship 1.0 with the subscription, in dependency order.

**How to read this.** Each step is marked:

- 🧍 **You** — needs your login, bank details, card, Mac, or a Simulator. I can't do it.
- 🤖 **Me** — I can do it; say the word.
- 🧍🤖 **Together** — you log in, I drive.

Don't skip ahead. Several steps look independent and aren't; where that's
true it says so.

---

## Phase 1 — start today, because they involve other people

These three gate everything else and none of them can be rushed once started.
Do all three in one sitting, then move to Phase 2 while they process.

### 1. ✅ Apple: Paid Applications Agreement — ALREADY DONE

Checked 2026-08-06: **Active** since 21 Dec 2025, NAB bank account (AUD)
active, ABN/GST and W-8BEN forms all Active. I had this listed as the
multi-day long pole for the launch; it never applied. The Apple subscription
was created the same day as a result — see §8.

⚠️ **One thing to watch:** both agreements show an effective end of
**18 Aug 2026**. If Apple issues a new version you must accept it, and a
lapsed Paid Apps Agreement pulls paid apps from sale.

### 2. ✅ Google: payments account — ALREADY EXISTS

Checked 2026-08-06. JRV Solutions has a live payments profile — it has to,
the other apps already sell. **I wrongly carried "create a merchant account"
as a blocker from the generic runbook.**

**The real Play blocker is the missing build.** Monetize with Play →
Products → Subscriptions shows *"Your app doesn't have any subscriptions
yet"* with an **Upload a new APK** button — not a Create button. Play will
not let a subscription be created until an APK/AAB with the billing library
is on a track. So for Android the order is:

> build the AAB → upload to internal testing → **then** create the
> subscription, base plan and free-trial offer → then the RevenueCat Android
> app.

One genuine action item though: there's an unread Play notification dated
Aug 6, *"A reminder that action is required with your payments account —
review your payments account to provide missing information."* It's generic
and may be a tax-form or identity refresh. Worth opening **Review account**
before launch so it doesn't surface as a payout hold later.

Separately, Play wants all apps registered for **Android developer
verification by Sep 30, 2026**; the console says JRV Solutions is already
compliant.

### 3. ✅ Host the privacy policy — DONE 2026-08-15

Live at <https://exquisite-muffin-f2982a.netlify.app/privacy.html>. The
existing Netlify site had no published deploy, which is why it 404'd — the
site record itself was fine. `netlify.toml` now publishes `public/` only, so
the site serves the policy and not a half-configured web build of Ponder.
`VITE_PRIVACY_URL` is set in `.env`.

The policy itself needed rewriting first: it dated from 30 July and never
mentioned purchase data, RevenueCat, or Apple/Google payment processing —
exactly what Apple App Privacy and Play Data safety will ask you to declare.

<details>
<summary>Original instructions</summary>

`public/privacy.html` exists in the repo but **has never been live**. The
Netlify site the repo is linked to (`exquisite-muffin-f2982a.netlify.app`)
returns *Site not found*. This currently blocks three separate things: the
Apple submission, the Play submission, and the privacy link on the paywall.

Pick one:

| Option | Effort | Notes |
|---|---|---|
| Re-create the Netlify site | low | The repo already has `.netlify/state.json`; the site was deleted or the team changed. |
| `ponder.jrvsolutions.com.au` on your existing DNS | medium | Nicer URL, needs a DNS record and a cert. |
| GitHub Pages on the repo | low | Free, permanent, but exposes the repo name in the URL. |

Whichever you choose, tell me the final URL and I'll set `VITE_PRIVACY_URL`
and drop it into the store metadata. **I deliberately removed the guessed
domain** from the paywall rather than ship a link I hadn't verified — right
now the paywall renders with no privacy link at all, which App Review will
reject. This has to be closed before you build for submission.

</details>

---

## Phase 2 — while the agreements process

Nothing here depends on Phase 1.

### 4. ✅ Supabase migrations — DONE 2026-08-06

All applied and verified against production: `subscriptions`,
`has_active_entitlement`, `my_entitlement`, the 3-thread cap,
`generation_batches` / `generation_batch_items`, `profiles.last_opened_at`,
`pause_idle_threads`, and the two new cron jobs (`ponder-batch-collect`
every 10 min, `ponder-idle-pause` daily 03:10 UTC).

Both `content_reports` migrations turned out to have been applied already —
the old checklist was stale.

**Still yours (needs the CLI on your Mac):**

```bash
supabase secrets set RC_WEBHOOK_SECRET="$(openssl rand -base64 48)"   # keep the value
supabase functions deploy rc-webhook generate-entry synthesize
```

⚠️ **Deploy before the first subscription exists.** `run_daily_generation()`
now posts `mode: "batch_submit"`, but the deployed function is still the old
build that ignores it. Harmless today because no `subscriptions` rows exist
so the job exits immediately — but the first entitled user would otherwise
hit a function that generates synchronously for everyone.

<details>
<summary>Original migration instructions</summary>

### 4. 🧍🤖 Apply the Supabase migrations

**Do this before you build the app again.** The paywall calls
`my_entitlement()`, which doesn't exist in the hosted project yet. With the
fail-closed behaviour I wrote, a build against the current schema shows every
user a paywall whose button does nothing.

Unapplied migrations:

| File | What it adds |
|---|---|
| `20260728000001_content_reports.sql` | content reporting (Play AI policy) |
| `20260728000002_content_reports_conflict_target.sql` | upsert conflict target |
| `20260803000001_subscriptions.sql` | subscriptions, `has_active_entitlement`, thread cap |
| `20260803000002_cron_entitlement_gate.sql` | entitlement-gated nightly job |
| `20260806000001_batch_generation.sql` | 3-thread cap, batch tables, idle auto-pause, batched cron |

The last one also **replaces the two cron jobs**: `run_daily_generation()`
now submits a batch two hours ahead of each user's notification hour, and a
new `ponder-batch-collect` job drains finished batches every 10 minutes.
A third job, `ponder-idle-pause`, runs daily at 03:10 UTC.

From your Mac (the Supabase CLI works there without Docker):

```bash
cd ~/Documents/Claude/Projects/Ponder
supabase db push
```

If you'd rather do it through the dashboard SQL editor, log into Supabase in
Chrome and I'll paste them in one at a time and confirm each.

**Verify after:**

```sql
select public.has_active_entitlement('00000000-0000-0000-0000-000000000000');  -- false
select proname from pg_proc where proname in
  ('has_active_entitlement','my_entitlement','entitled_due_users','max_active_topics');
```

</details>

### 5. 🧍 Set the new Supabase secret

```bash
openssl rand -base64 48          # keep this, you need it again in step 8
supabase secrets set RC_WEBHOOK_SECRET='<that value>'
```

### 6. 🧍 Deploy the edge functions

```bash
supabase functions deploy rc-webhook        # new
supabase functions deploy generate-entry    # gained the billing gate
supabase functions deploy synthesize        # gained the billing gate
```

### 7. 🧍 Capture the screenshots

Follow `store/SCREENSHOTS.md` — it's been updated for the paywall. Two
changes worth knowing before you start:

- **First launch now shows the paywall**, not an empty Today screen. That's
  expected. Capture it once as the Apple subscription review screenshot, then
  run the seed, which grants a sandbox entitlement to get you past it.
- **Don't tap "Start free trial"** during capture — you'd open a real sandbox
  subscription for nothing.

You need: a Mac, Xcode, an iPhone 16 Pro Max Simulator (440×956pt @3x =
exactly 1320×2868). Six listing shots plus the one paywall shot.

Then 🤖 I run the compositor and produce both store sets:

```bash
python3 store/make-screenshots.py
```

---

## Phase 3 — once both agreements are Active

### 8. Products and RevenueCat

**Apple — ✅ mostly done 2026-08-06.** Group `Ponder`, product
`au.com.ponder.app.pro.annual` (Apple ID `6798269811`), en-AU localisation,
and a **1-week free trial** live in all 175 territories with no end date.
Full record in `store/SUBSCRIPTION-SETUP.md` §1.

Price set 2026-08-06: base **A$15.99**, which Apple converts to exactly
**US$9.99** (C$12.99, €9.99). Verified after reload.

### Commission rate — decided, do not re-raise

Ponder runs on Apple's **standard rate: 30% for the first 12 months** of a
subscription, 15% after. US$9.99 therefore yields **$7.00 in year one** and
$8.49 thereafter.

Antonio considered and **declined** the App Store Small Business Program
(2026-08-06), preferring to keep the same arrangement as GameRefine Tennis,
GameRefine Golf and EV Charge & Save. It was worth +$1.49/subscriber in year
one; the decision is made, and the economics work without it — three threads
cost $4.52/yr against $7.00, a 35% margin in year one.

**RevenueCat iOS — ✅ done 2026-08-06.** Project `Ponder` (`624ea9a8`), iOS
app bound to `au.com.ponder.app`, product imported from Apple, entitlement
`pro`, offering `default` with package `$rc_annual`, credentials verified.
Both Apple keys were reused from the existing team setup, so no new `.p8`.
Public SDK key is in `.env.example`. Full record in `SUBSCRIPTION-SETUP.md` §3.

**RevenueCat webhook — ✅ live and verified 2026-08-06.** Send test event
returned `{"ok":true,"note":"test event"}`. Secrets set and all three edge
functions deployed.

**The whole iOS path is now complete: Apple → RevenueCat → Supabase.**
Nothing else is needed on iOS except a build to exercise it.

**Play + RevenueCat Android — 🧍🤖 still to do**, blocked on the **Android
build**, not the merchant account. Upload an AAB to internal testing first;
the subscription can't be created until then.

The Android service account is the slow part — Google takes up to **36
hours** to propagate the permissions, and RevenueCat reports the credentials
as invalid until it does. Set that up first, then do everything else while it
propagates.

### 9. 🧍 Add the In-App Purchase capability in Xcode

Target **App → Signing & Capabilities → + Capability → In-App Purchase**.

Without it StoreKit returns no products and the paywall button stays
disabled with no error message. Easy to miss, hard to diagnose.

### 10. 🧍 Test the six cases

Listed in full in `store/SUBSCRIPTION-SETUP.md` §5. The short version:

1. Purchase works and writes a `subscriptions` row within seconds
2. `generate-entry` returns **402** with no subscription, not 200
3. Trial expiry returns you to the paywall (sandbox does 1 week in 3 minutes)
4. **Cancel does not cut access immediately** — it must run to `expires_at`
5. Reinstall + restore recovers the subscription; the journal only comes back
   if the email backup was done
6. A third active thread is refused by the database, not just a greyed button

Case 4 is the one most likely to be wrong and the one most likely to generate
a refund request if it is.

### 11. 🧍🤖 Update the store listings

Both records were created as **Free × 175 territories** and need changing.
I've already written the copy — it's in `store/listing-metadata.md`:

- The **subscription disclosure block** appended to both descriptions. Apple
  rejects auto-renewing subscriptions whose metadata omits any of those lines.
- **Purchase history** added to Apple App Privacy and Play Data safety, linked
  to the user.
- The privacy policy URL from step 3.

### 12. 🧍 Signed builds and submit

- iOS: Xcode → Archive → distribute to App Store Connect → TestFlight first
- Android: Android Studio → Generate Signed Bundle → `.aab` → internal testing
  track before production

Play won't allow a subscription purchase — even a test one — until an AAB
with the billing library is on a track. So the Android build has to happen
before Android testing, not after.

Submit the app version **and** the subscription together. A subscription
submitted alone sits in *Waiting for Review* indefinitely.

---

## What I've already done

Code complete and verified — `tsc` clean, `vite build` clean, all three edge
functions parse, migration applied to a real Postgres with entitlement and
thread-cap behaviour asserted.

Since the last round I also fixed three things that would have bitten you in
Phase 2:

- **The screenshot seed couldn't run.** It inserted the concluded thread with
  `status: 'concluded'` and then attached notes to it, which
  `guard_notes_on_concluded` rejects. It now creates the thread active, fills
  it, then concludes it — which is also what happens in the real app.
- **The seed would have hit the new thread cap.** Three threads seeded in
  declaration order means three active at once. Concluded threads are now
  seeded first so the slot is released before the two active ones are created.
- **Nothing was screenshottable at all.** The hard paywall blocks every screen
  on the shot list. The seed now grants a one-year sandbox entitlement.

---

## Critical path

```
Apple agreement ──── ✅ already active
Apple subscription ─ ✅ created, trial live
Play merchant account ──────────────┐
Privacy hosting ────────────────────┼─→ RevenueCat → test → submit
Batch API work ─────────────────────┘
        │
        └─→ migrations → deploy → build → screenshots
```

With Apple already done, the remaining blockers are the **Play merchant
account** (external, start it now) and **privacy hosting** (yours to choose,
five minutes once you have). The Batch API work is mine and can run in
parallel.
