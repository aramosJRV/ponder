# Ponder — subscription setup runbook

7-day free trial → **A$15.99/year (US$9.99)**, entitlement `pro`, 3 active
threads.

Every identifier below is referenced by code. Changing one means changing the
other; the cross-references are noted inline.

---

## 0. Prerequisites you have to do yourself

These block everything else and none of them can be automated.

| | Where | Why it blocks |
|---|---|---|
| **Paid Applications Agreement** | App Store Connect → Business → Agreements | Until it's *Active*, the "In-App Purchases" section is read-only. Requires bank details and a completed AU tax form (W-8BEN-E for a Pty Ltd). |
| **Play merchant account** | Play Console → Setup → Payments profile | Subscriptions can't be created without one. Linking is one-way and permanent. |
| **Play: a build on a track** | Play Console → internal testing | Play won't let a subscription be *purchased* (even in test) until an AAB with the billing library is on a track. Create the products first, but expect test purchases to fail until a build is up. |

Realistically the Apple agreement is the long pole — bank verification can take
a few days. Start it before anything else.

---

## 1. App Store Connect — ✅ DONE 2026-08-06

Created and verified. Recorded here so RevenueCat can be pointed at the real
identifiers rather than the planned ones.

| | Value |
|---|---|
| Subscription group | **Ponder** (id `22288415`) |
| Subscription | **Ponder Annual**, Apple ID `6798269811` |
| **Product ID** | `au.com.ponder.app.pro.annual` |
| Duration | 1 year |
| Base price | **A$15.99** (Australia) — set 2026-08-06 |
| Generated | US **$9.99** · CA $12.99 · EU €9.99 |
| US proceeds | **$7.00** year 1 (70%) · $8.49 year 2 (85%) |
| Localisation | en-AU — "Ponder" / "Daily scripture and reflection across your threads." |
| Introductory offer | **Free for the first week**, 175 territories, Aug 6 2026 → no end date |

Two gotchas hit on the way through, noted so a second app doesn't repeat them:

- The subscription **description field caps at 55 characters**, not the ~100
  you'd guess. The originally drafted line was 62 and had to be cut.
- ASC's `<select>` elements ignore synthetic key events, so the duration and
  locale had to be set via the React value setter. Irrelevant if you're
  clicking by hand.

**Still outstanding on the Apple side:**

- **Review screenshot** — a capture of the paywall, uploaded under
  Subscriptions → Ponder Annual → Review Information. See `SCREENSHOTS.md`.
  Apple rejects subscriptions without it.
- The subscription **must be submitted with a new app version**. ASC says so
  explicitly on the group page; submitting it alone leaves it in *Waiting for
  Review* forever.

<details>
<summary>Original instructions, kept for reference</summary>

**Apps → Ponder: Daily Discernment (Apple ID `6796225096`) → Subscriptions**

### 1a. Subscription group

| Field | Value |
|---|---|
| Reference Name | `Ponder` |
| Group display name (localised, en-AU) | `Ponder` |

One group only. Groups are what let a user switch plans later without a
refund, so putting a future monthly plan in this same group keeps that door
open.

### 1b. Subscription

| Field | Value |
|---|---|
| Reference Name | `Ponder Annual` |
| **Product ID** | `au.com.ponder.app.pro.annual` |
| Duration | 1 Year |
| Price | **A$15.99** (base storefront Australia) → US$9.99 |

> ⚠️ **Product IDs are globally unique across the App Store and permanent.**
> A typo here can't be corrected; you'd have to create a second product and
> abandon the first. Copy-paste it.

**Currency — decided, already live.** Base storefront **Australia at A$15.99**,
which Apple converts to **US$9.99 / C$12.99 / €9.99**. Verified in App Store
Connect 2026-08-15: 175 territories priced, introductory offer "Free for the
first week" on all 175. Changing the base now would re-price every territory —
don't.

### 1c. Introductory offer — this is the free trial

**Subscription → Introductory Offers → Create**

| Field | Value |
|---|---|
| Territories | All |
| Start / End date | Start today, **no end date** |
| Type | **Free Trial** |
| Duration | **1 Week** |

Note there is no "7 days" option — Apple's granularity is 3 days / 1 week / 2
weeks / 1 month / 2 months / 3 months / 6 months / 1 year. **1 Week is your
7 days.** Nothing in the app hardcodes the length; the paywall reads it from
RevenueCat, so if you later switch to 2 weeks the copy in `Paywall.tsx` is the
only thing to update.

### 1d. Localisation (en-AU, required before review)

| Field | Value |
|---|---|
| Display Name | `Ponder` |
| Description | `Daily scripture, reflection and synthesis across your threads.` |

### 1e. Review information

Apple rejects subscriptions with no review screenshot. Take a screenshot of the
paywall on a 6.9" simulator once the build runs, upload it here.

**App Review notes** — add this to the app version, not the subscription:

```
Ponder has no sign-in screen. Launching the app creates an anonymous account
automatically, then shows the paywall. To test:
1. Tap "Start free trial".
2. The app asks for an email to back up the journal before purchasing —
   any address works; the confirmation code is emailed instantly.
3. Complete the sandbox purchase to enter the app.
Content is generated nightly; a newly created thread offers immediate
on-demand generation so there is content to review straight away.
```

That last paragraph matters. A reviewer who creates a thread and sees "no
entry yet" will reject for incomplete functionality.

</details>

---

## 2. Google Play Console

**App (`4975139910368956506`) → Monetise → Products → Subscriptions**

### 2a. Subscription

| Field | Value |
|---|---|
| **Product ID** | `ponder_pro_annual` |
| Name | `Ponder` |
| Description | `Daily scripture, reflection and synthesis across your threads.` |

Also permanent and unique-per-app.

### 2b. Base plan

| Field | Value |
|---|---|
| **Base plan ID** | `annual-799` |
| Type | Auto-renewing |
| Billing period | 1 year |
| Renewal type | Auto-renewing |
| Grace period | 7 days (leave Play's default) |
| Account hold | Enabled (default) |
| Price | A$15.99 (base AUD, matching Apple), then "Apply to all" |

Play's base plan IDs allow hyphens but **not** underscores or uppercase.

### 2c. Offer — the free trial

**Base plan → Add offer**

| Field | Value |
|---|---|
| Offer ID | `freetrial-7d` |
| Eligibility | **New customer acquisition** → *Never had a subscription to this app* |
| Phase 1 | **Free trial**, 7 days |

Play *does* take an exact 7 days, so Android and iOS trial lengths match.

Activate the base plan and the offer — created ≠ active, and an inactive base
plan silently returns an empty offering to the SDK.

---

## 3. RevenueCat — ✅ iOS DONE 2026-08-06

Project **Ponder** (`624ea9a8`), platform Capacitor, category Lifestyle.

| | Value |
|---|---|
| iOS app | **Ponder (App Store)** (`appf7545616e3`), bundle `au.com.ponder.app` |
| In-app purchase key | reused existing team key **`3QTZ845SJM`** (shared with GameRefine) |
| App Store Connect API key | reused existing **`KS4F3A8FN2`** — this is what let the product be *imported* rather than typed |
| Credentials | verified by RevenueCat — **"Valid credentials"** |
| Product | `au.com.ponder.app.pro.annual` (imported from Apple, state *Missing Metadata* until the subscription is submitted) |
| Entitlement | **`pro`** → product attached (`entl9775d1e75f`) |
| Offering | **`default`**, package **`$rc_annual`** (`ofrnga97ac601ff`) |
| iOS public SDK key | `appl_ItLdOVfcICiTxoFPvFwfwmxZApx` |

Add to `.env` — this is a *publishable* key, it identifies the app and
authorises nothing:

```
VITE_RC_IOS_KEY=appl_ItLdOVfcICiTxoFPvFwfwmxZApx
```

Two notes worth keeping:

- Both Apple keys already existed on the team from the other apps, so no new
  `.p8` had to be generated or uploaded.
- The **Apple Small Business Program** toggle on the app config was left
  **off**, matching the declined enrolment. If that ever changes, flip it
  here too or RevenueCat's revenue reporting will be wrong.

### Webhook — ✅ live and verified 2026-08-06

**RevenueCat → Integrations → Webhooks** (not Supabase's Integrations page —
the webhook is sent *by* RevenueCat).

| Field | Value |
|---|---|
| Name | Supabase entitlements |
| URL | `https://rkslrbcbncecekghwbap.supabase.co/functions/v1/rc-webhook` |
| Authorization header | the raw `RC_WEBHOOK_SECRET` value |
| Environment | **Both Production and Sandbox** |
| Events filter | All apps / All events, paywall events off |

Confirmed with **Send test event** → `{"ok":true,"note":"test event"}`.

> ⚠️ **No "Bearer" prefix.** The field's placeholder suggests one, but
> `rc-webhook` compares the header byte-for-byte against the secret. A
> prefix produces 401 on every event and RevenueCat retries for hours while
> `subscriptions` stays empty.

Two diagnostics worth remembering:

```bash
# GET in a browser -> {"error":"POST only"}   = deployed, new code
curl -s -X POST .../functions/v1/rc-webhook -d '{}'
#   {"error":"Unauthorized"}    = secret IS set, gate working
#   {"error":"not configured"}  = secret missing, function failing closed
```

### Still to do on RevenueCat

- **Android app** — blocked on the Play merchant account.

<details>
<summary>Original instructions, kept for reference</summary>

**app.revenuecat.com → Project: Ponder**

### 3a. Apps

| Platform | Field | Value |
|---|---|---|
| iOS | Bundle ID | `au.com.ponder.app` |
| iOS | App Store Connect Shared Secret | ASC → App Information → App-Specific Shared Secret |
| iOS | In-App Purchase Key (.p8) | ASC → Users and Access → Integrations → In-App Purchase |
| Android | Package | `com.jrvsolutions.ponder` |
| Android | Service account JSON | Google Cloud → Play Console linked project |

> The iOS bundle ID and Android package **deliberately differ** — see the
> comment in `capacitor.config.ts`. Don't "fix" it here either.

The Android service-account setup is the fiddly one: create the account in
Google Cloud, grant it *View financial data* and *Manage orders and
subscriptions* in Play Console → Users and permissions, then wait — Google
takes up to 36 hours to propagate permissions and RevenueCat will report the
credentials as invalid until it does.

### 3b. Products

| Identifier | App |
|---|---|
| `au.com.ponder.app.pro.annual` | iOS |
| `ponder_pro_annual:annual-799` | Android |

Android products in RevenueCat are `subscriptionId:basePlanId`. Getting this
wrong is the single most common cause of an empty offering on Android.

### 3c. Entitlement

| Field | Value |
|---|---|
| **Identifier** | `pro` |
| Attached products | both of the above |

> `pro` is hardcoded as `ENTITLEMENT_ID` in `src/lib/billing.ts` and as the
> `RC_ENTITLEMENT_ID` default in `supabase/functions/rc-webhook/index.ts`.

### 3d. Offering

| Field | Value |
|---|---|
| Offering identifier | `default` |
| Package identifier | `$rc_annual` |
| Attached products | both |

Mark the offering **current**. `loadOffering()` reads `offerings.current`, so
an offering that exists but isn't current produces a paywall with a disabled
button.

### 3e. Webhook

**Project settings → Integrations → Webhooks**

| Field | Value |
|---|---|
| URL | `https://rkslrbcbncecekghwbap.supabase.co/functions/v1/rc-webhook` |
| Authorization header | the value of `RC_WEBHOOK_SECRET` |
| Event environment | **Send both sandbox and production** |

Generate the secret and set it on both sides:

```bash
openssl rand -base64 48
# paste the same value into RevenueCat's Authorization field and:
supabase secrets set RC_WEBHOOK_SECRET='<that value>'
```

Sandbox events must be enabled or TestFlight purchases never reach the
database, the server gate says "not entitled", and every generate call 402s
while the app itself looks subscribed.

### 3f. API keys → `.env`

RevenueCat → API keys → **App-specific public keys** (not the secret key):

```
VITE_RC_IOS_KEY=appl_...
VITE_RC_ANDROID_KEY=goog_...
```

</details>

---

## 4. Deploy

```bash
cd ~/Documents/Claude/Projects/Ponder

# 1. schema — adds subscriptions, has_active_entitlement, the thread cap,
#    and the entitlement-gated cron body
supabase db push

# 2. secrets
supabase secrets set RC_WEBHOOK_SECRET='<from step 3e>'

# 3. functions — rc-webhook is new; the other two gained the billing gate
supabase functions deploy rc-webhook
supabase functions deploy generate-entry
supabase functions deploy synthesize

# 4. native
npm install
npm run build
npx cap sync
```

**Xcode, once:** target App → Signing & Capabilities → **+ Capability** →
**In-App Purchase**. Without it StoreKit returns no products and the paywall
button stays disabled with no error.

Android needs nothing — the RevenueCat plugin merges `com.android.vending.BILLING`
into the manifest during `cap sync`.

---

## 5. Testing

**iOS (sandbox):** ASC → Users and Access → Sandbox → Testers. Create one with
an email you control that is **not** an existing Apple ID. On the device, sign
out of the App Store first; the sandbox prompt appears during purchase. Sandbox
renews on an accelerated clock — a 1-week trial expires in **3 minutes**, and a
1-year subscription renews hourly, which is exactly what you want for testing
expiry.

**Android:** Play Console → Setup → Licence testing, add your Google account.
Install from the internal testing track, not a local `adb install` — a
sideloaded build gets no billing response.

### What to verify

1. **Purchase** → app enters, `select * from subscriptions` shows a row with
   `period_type = 'TRIAL'` within a second or two.
2. **Server gate** → with no subscription row, calling `generate-entry` with a
   user JWT returns **402**, not 200.
3. **Trial expiry** → wait out the sandbox clock; the app returns to the
   paywall on next launch and the cron stops generating for that user.
4. **Cancel** → turn off auto-renew in store settings. Access must *continue*
   until `expires_at`. If it cuts immediately, the webhook is mishandling
   `CANCELLATION`.
5. **Reinstall + restore** → delete the app, reinstall, tap Restore. The
   subscription comes back. The journal only comes back if the email backup
   was completed — which is why the paywall forces it.
6. **Thread cap** → creating a third active thread must fail with the
   "Thread limit reached" message, from the database, not just a disabled button.

---

## 6. Store listing changes this forces

- `store/listing-metadata.md` still says *"Pricing: Free (future IAP via
  RevenueCat)"* — now wrong on both stores.
- **Apple App Privacy**: add **Purchases** as collected data (RevenueCat
  collects purchase history, linked to identity).
- **Play Data safety**: same — declare *Purchase history*, collected, linked
  to the user, for app functionality.
- Both listings need the price disclosure Apple requires in the description
  itself for auto-renewing subscriptions: title, length, price, and links to
  Terms and Privacy Policy.
- `PRIVACY_URL` in `src/screens/Paywall.tsx` points at
  `https://ponder.jrvsolutions.com.au/privacy.html`, which isn't hosted yet —
  it's still on the pre-submission checklist in the README. Apple will reject
  a subscription app with a dead privacy link.
