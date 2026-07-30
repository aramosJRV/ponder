# Ponder — Store Listing Metadata

iOS bundle ID: `au.com.ponder.app` (registered with Apple 2026-07-28)
Android package: `com.jrvsolutions.ponder` — **deliberately different from iOS**
Pricing: Free (future IAP via RevenueCat)
Developer: JRV Solutions

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

1. **Privacy policy URL** — publicly reachable, non-expiring. Must disclose: email (optional, for backup/restore), user-written notes, anonymous account identifiers, and that content is generated via a third-party AI API. No live URL exists today.
2. **Screenshots** — Apple: 6.9" and 6.5" iPhone. Play: minimum 2 phone screenshots + 1024×500 feature graphic. Requires a running build.
3. ~~**Play AI-generated content policy**~~ — **DONE 2026-07-28.** `ReportButton` on every entry and synthesis, backed by the `content_reports` table (migration `20260728000001_content_reports.sql`). Reporting is not entitlement-gated. Migration still needs applying to the hosted Supabase project.
4. **Apple 1024×1024 icon** — already exists at `ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png`.
5. **Signed build** — `.ipa` for TestFlight, `.aab` for Play.

## Data safety / privacy declarations (both stores)

| Data | Collected | Purpose | Optional |
|---|---|---|---|
| Email address | Yes, if user opts into backup | Account restore | Yes |
| User content (notes, thread titles) | Yes | App functionality | No |
| Anonymous user ID | Yes | App functionality | No |
| Location / contacts / photos / financial | No | — | — |

Data is encrypted in transit. Users can request deletion. No data is sold or shared with third parties for advertising.
