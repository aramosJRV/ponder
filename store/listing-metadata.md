# Ponder — Store Listing Metadata

iOS bundle ID: `au.com.ponder.app` (registered with Apple 2026-07-28)
Android package: `com.jrvsolutions.ponder` — **deliberately different from iOS**
Pricing: **Free 7-day trial, then A$15.99/year — US$9.99, C$12.99, €9.99**
auto-renewing subscription via RevenueCat (entitlement `pro`). Base storefront
is Australia. Configuration runbook: `SUBSCRIPTION-SETUP.md`.
⚠️ The store records were created as *Free × 175 territories*; both need
updating, and both privacy declarations must now include purchase data.
Developer: JRV Solutions

## Live store records (created 2026-07-30)

| | Apple | Google Play |
|---|---|---|
| Record | Apple ID `6796225096`, SKU `PONDER-DAILY-001` | app id `4975139910368956506` |
| Status | 1.0 Prepare for Submission | Draft |
| Entered | name, subtitle, promo text, description, keywords, copyright, categories (Lifestyle/Reference), price Free × 175 territories | app name, short + full description, icon 512, feature graphic, category Lifestyle, contact email |
| Still blank | screenshots, support URL, App Privacy, age rating, App Review contact, build | screenshots (phone + 7" + 10" tablet), AAB |

### Play Console progress — updated 2026-08-16

App content is **10 of 11 complete**. Everything below was entered and saved in
the live console on 16 Aug 2026:

- **Privacy policy URL** — `https://exquisite-muffin-f2982a.netlify.app/privacy.html`
- **Target audience** — 18 and over only (deliberate: keeps the app out of
  Families policy, which a paid subscription devotional has no business in)
- **Content rating** — IARC questionnaire submitted, ToU accepted, contact
  `antonio.ramos.jr@gmail.com`. Answers: no violence / sexuality / language /
  controlled substance / age-restricted products; **online content = Yes**
  (the daily entries are AI-generated and delivered after install — this is the
  honest answer and it is what drives the ratings below); user content sharing =
  No; digital goods purchase = Yes; no loot boxes.
  Resulting ratings: **ESRB Everyone, PEGI 3, ClassInd 14+**, interactive
  element "In-App Purchases".
- **Data safety** — collected, not shared (all third parties are service
  providers, which is a Play sharing exemption), encrypted in transit,
  account creation via "username and other authentication" (email OTP):

  | Data type | Optional? | Purpose |
  |---|---|---|
  | Email address | Optional | App functionality, Account management |
  | User IDs | Required | App functionality, Account management |
  | Political or religious beliefs | Required | App functionality, Personalization |
  | Other info | Required | App functionality |
  | Purchase history | Required | App functionality |
  | Other user-generated content | Required | App functionality |

  *Political or religious beliefs* is declared deliberately. Thread titles and
  notes are a user's written reflections on their faith, which meets Play's
  definition of sensitive personal information. Under-declaring it is the
  bigger risk.

- **Internal testing** — email list **"Ponder Internal Testers"**
  (`antonio.ramos.jr@gmail.com`) created and attached to the internal track.
  Track is still *Inactive*: it needs an AAB and a rollout, both of which are
  local build steps.

**Blocking the store listing (and only the store listing):** phone, 7-inch
tablet and 10-inch tablet screenshots. All three are marked required and
`store/screenshots/` is empty. Internal testing does **not** need them — Play
serves a temporary listing for up to 48h on a first publish.

**Deploy before submitting for review:** `public/delete-account.html` is
written but not deployed. Play accepted the URL with a 404 warning; the app can
be rejected at review if it is still 404. `netlify deploy --prod` from the repo
root fixes it.

**Keywords trimmed to 95 chars** — the drafted 101-char string exceeded Apple's 100 limit. Dropped `daily`, which was also redundant with the app name. Consider also dropping `discern` (redundant with "Discernment" in the name) to free 8 chars for a higher-volume term such as `meditation`.

Store assets live in `store/assets/` (`play-icon-512.png`, `play-feature-graphic.png`). The feature graphic's wordmark is set in **Lora**, not Cormorant Garamond — regenerate on a machine with the real brand font if exact typography matters.

---

## Apple App Store

**App Name** (30 max)
```
Ponder: Daily Discernment
```
*25 chars*

**Subtitle** (30 max)
```
Bible devotionals & journal
```
*27 chars — carries the search terms the name doesn't*

**Promotional Text** (170 max, editable without review)
```
Bring what you sense God is saying into daily scripture. Several threads at once, honest questions, and a journal that helps you see the pattern over time.
```
*153 chars*

**Keywords** (100 max, comma-separated, NO spaces after commas, don't repeat name/subtitle words)
```
devotion,quiet,time,prayer,christian,faith,scripture,verse,reflect,discern,journaling,spiritual,daily
```
*101 — trim `daily` if rejected*

**Description** (4000 max)
```
Ponder is a daily devotional built around what you sense God is speaking to you about — not a pre-written plan someone else wrote for a general audience.

You name the thread in your own words. Ponder brings scripture to it, every day.

HOW IT WORKS

Start a thread — "learning to be still," "trusting God with my business," whatever you're carrying. Each morning Ponder prepares a fresh entry for it: a passage from scripture, a short reflection, an illustration to sit with, two or three questions, and directions for prayer.

Hold several threads at once. God rarely works on one thing at a time, and neither does life.

HONEST, NOT JUST AFFIRMING

Roughly one entry in four is a challenge entry — clearly marked. It questions your framing, offers a counterpoint from scripture, or asks something harder than you'd ask yourself.

This is deliberate. A tool that only ever confirms what you already believe isn't helping you discern anything. Challenge entries are pastoral in tone: hard questions, not harsh ones.

You control how often they appear.

A JOURNAL THAT ADDS UP

Attach a note to any entry. Every note for a thread collects into one chronological Thread Journal, so months of scattered thoughts read as a single arc.

When you want to step back, ask "What's emerging?" Ponder reviews the thread, the scriptures it has brought you, and everything you've written, then reflects back what keeps returning, the tensions you haven't resolved, and a few suggestions for prayer or further study.

CONCLUDING WELL

Threads end. When one does, Ponder walks you back through the timeline, offers a looking-back reflection, and invites a closing note. Concluded threads stay fully readable.

WHAT YOU SHOULD KNOW

Scripture is the World English Bible, a public-domain translation. Every verse is served from the actual biblical text — never paraphrased or reconstructed.

Written content is generated to give you material for reflection. It is not a claim about what God is telling you, and it is not direction on your life decisions. Treat it as a starting point for prayer, scripture, and conversation with people who know you.

The posture is broadly orthodox and non-denominational.

A daily notification brings you the verse. Today's entry is readable offline.
```

**Subscription disclosure** — append verbatim to the end of the Description.

Apple's Schedule 2 requires all of the following *in the metadata itself*,
not only inside the purchase sheet. Reviewers check for it and reject
auto-renewing subscriptions that omit any line. Play has no equivalent
requirement, but reusing the same block keeps the two listings identical.

```
Ponder is a subscription. A 7-day free trial is followed by an annual
subscription of US$9.99 per year. Prices vary by region.

Payment is charged to your Apple Account at confirmation of purchase. The
subscription renews automatically at the same price unless auto-renew is
turned off at least 24 hours before the end of the current period. Your
account is charged for renewal within 24 hours of the period ending. You can
manage your subscription and turn off auto-renew in your Account Settings
after purchase. Any unused portion of the free trial is forfeited if you
purchase a subscription during the trial.

Privacy Policy: https://exquisite-muffin-f2982a.netlify.app/privacy.html
Terms of Use: https://www.apple.com/legal/internet-services/itunes/dev/stdeula/
```

> The privacy URL above is live (deployed 2026-08-15) and is already set as
> `VITE_PRIVACY_URL` in `.env`.
>
> **Currency is settled:** base storefront Australia at **A$15.99**, which
> Apple converts to **US$9.99** (verified in ASC 2026-08-15 across all 175
> territories). The block above quotes the US figure because the en-US
> listing is the one reviewers read; "Prices vary by region" covers the rest.
> If you add an en-AU listing, quote A$15.99 there instead.

**Category**
- Primary: Lifestyle
- Secondary: Reference

**Age Rating:** 4+ (no objectionable content)

**Copyright:** © 2026 JRV Solutions

---

## Google Play

**App name** (30 max)
```
Ponder: Daily Discernment
```

**Short description** (80 max)
```
Daily Bible devotionals for what you sense God is saying. Journal the pattern.
```
*77 chars*

**Full description** (4000 max) — reuse the App Store description above. Play permits light keyword repetition; keep it natural.

**Category:** Lifestyle
**Tags:** Faith, Journaling, Personal growth
**Content rating:** IARC questionnaire — expect "Everyone"

---

## Required before either store will accept a submission

1. **Privacy policy URL** — ✅ **LIVE 2026-08-15**: <https://exquisite-muffin-f2982a.netlify.app/privacy.html>. Discloses email (optional, backup/restore), user-written notes, anonymous account identifiers, purchase history via RevenueCat with Apple/Google, and third-party AI generation via Anthropic. Set as `VITE_PRIVACY_URL` in `.env`. Still to do: paste it into Apple App Privacy and Play Data safety.
2. **Screenshots** — Apple: one 1320×2868 set (see `SCREENSHOTS.md`; the old 6.7"/6.5" requirement is gone). Play: minimum 2 phone screenshots at 1080×1920 + 1024×500 feature graphic. Requires a running build. **Plus** a separate paywall capture for the subscription's Review Information.
3. ~~**Play AI-generated content policy**~~ — **DONE 2026-07-28.** `ReportButton` on every entry and synthesis, backed by the `content_reports` table (migration `20260728000001_content_reports.sql`). Reporting is not entitlement-gated. Migration still needs applying to the hosted Supabase project.
4. **Apple 1024×1024 icon** — already exists at `ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png`.
5. **Signed build** — `.ipa` for TestFlight, `.aab` for Play.

## Data safety / privacy declarations (both stores)

| Data | Collected | Purpose | Optional |
|---|---|---|---|
| Email address | Yes, if user opts into backup | Account restore | Yes |
| User content (notes, thread titles) | Yes | App functionality | No |
| Anonymous user ID | Yes | App functionality | No |
| **Purchase history** | **Yes, via RevenueCat** | **App functionality** | **No** |
| Location / contacts / photos / financial | No | — | — |

Purchase history is new as of the subscription and must be added to both
declarations — Apple **App Privacy → Purchases**, Play **Data safety →
Financial info → Purchase history**, both *linked to the user*. Payment card
details are never seen by the app or by RevenueCat; the store handles them.

Data is encrypted in transit. Users can request deletion. No data is sold or shared with third parties for advertising.
