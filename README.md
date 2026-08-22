# Ponder

Personal daily devotional app. Generates devotional content around **threads** —
things you sense God is speaking about — supports multiple threads in parallel,
and helps you discern patterns over time via notes and thread-level synthesis.

> **Naming:** the user-facing term is **Thread**. The database, TypeScript
> identifiers and filenames still use `topic` / `Topic` / `topics`. This is
> deliberate: the rename is a label change only, so no migration, no FK churn,
> and no RLS policy rewrite. Don't "fix" the mismatch.

**Stack:** Capacitor + React + TypeScript + Tailwind · Supabase (Postgres,
Auth, Edge Functions, pg_cron) · Claude API (server-side only) · WEB Bible
(public domain, loaded into Postgres).

## Status

- [x] **Step 1** — Supabase schema + RLS + WEB Bible import + seed script
- [x] **Step 2** — Generation edge function with validation (deployed as `generate-entry`)
- [x] **Step 3** — Today screen + note capture (Vite + React + Capacitor shell, magic-link auth, offline cache, on-demand generation)
- [x] **Step 4** — Threads CRUD + thread detail + journal rollup (`Topics.tsx`, `TopicDetail.tsx`)
- [x] **Step 5** — pg_cron scheduling + local notifications (`20260713000001_pg_cron_daily_generation.sql`, `src/lib/notifications/`)
- [x] **Step 6** — Synthesis (on-demand + conclusion flow) (`synthesize` edge fn, `SynthesisCard.tsx`, `ConclusionFlow.tsx`)
- [x] **Step 7** — Settings + challenge-frequency control (`Settings.tsx`)

- [x] **Step 8** — Subscriptions: 7-day trial → US$9.99/yr via RevenueCat
  (`subscriptions` table, `rc-webhook` edge fn, `Paywall.tsx`, 3-thread cap)

### Remaining before store submission

- [ ] Work through `store/SUBSCRIPTION-SETUP.md` (ASC + Play + RevenueCat)
- [ ] Apply `content_reports` migrations to the hosted Supabase project
- [ ] Host the privacy policy (`public/privacy.html`) at a public URL
- [ ] Capture store screenshots (Apple 6.9" + 6.5"; Play ≥2 phone)
- [ ] Signed builds — `.ipa` (Xcode) and `.aab` (Android Studio)
- [ ] Create store records and paste metadata from `store/listing-metadata.md`

## Setup (step 1)

Prereqs: Node 20+, a Supabase project, Supabase CLI logged in.

```bash
# 1. install deps
npm install

# 2. link the Supabase project and apply the schema
supabase link --project-ref YOUR_PROJECT_REF
supabase db push

# 3. configure env
cp .env.example .env    # fill in SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SEED_USER_EMAIL

# 4. load the WEB Bible (~31k verses) and seed demo data
npm run setup           # = import:bible + seed
```

`import:bible` is idempotent (skips if already loaded; `--force` reloads).
`seed` creates your auth user, a demo topic ("Learning to be still") and a
first daily entry whose verse text is pulled from the `bible_verses` table via
`resolve_verse_ref()` — the same contract the generation function uses.

## Schema overview

| Table | Purpose | Client access (RLS) |
|---|---|---|
| `profiles` | timezone, notification hour, challenge frequency | read/update own |
| `bible_books` | 66 books + aliases for ref resolution | read only |
| `bible_verses` | full WEB text; single source of verse text | read only |
| `topics` | discernment topics; status, focus flag | full CRUD own |
| `daily_entries` | one generated entry per topic per day | read own (writes: edge fn) |
| `notes` | journal notes attached to entries, rolled up per topic | full CRUD own |
| `syntheses` | "what's emerging" snapshots | read own (writes: edge fn) |
| `generation_failures` | validation/fallback log | read own (writes: edge fn) |

Enforced in Postgres, not just app code:

- one focus topic per user (partial unique index)
- one entry per topic per day (unique constraint)
- concluded topics are read-only (trigger), incl. blocking new notes
- `resolve_verse_ref(book, chapter, start, end)` resolves human references
  ("Psalm 46:10", "1 Cor 13:4") against the WEB table — the generation
  function's validation step and the seed both use it

Verse-repetition tracking (never within a topic, 60 days across topics) is
derived from `daily_entries` at generation time — no separate table.

## Subscription

7-day free trial, then **US$9.99/year** (base A$15.99). Entitlement id `pro`.
Hard paywall —
the app shows `Paywall.tsx` instead of its content once the trial ends.

Full store/RevenueCat configuration: **`store/SUBSCRIPTION-SETUP.md`**.

### Why three threads, and what pays for them

Price **US$9.99/yr** (base A$15.99). Apple's own proceeds figures, read off
the price confirmation screen rather than assumed:

| | Price | Year 1 proceeds | Year 2 proceeds |
|---|---|---|---|
| United States | $9.99 | **$7.00** (70%) | **$8.49** (85%) |
| Australia | A$15.99 | — | — |
| Canada | C$12.99 | $9.09 | $11.04 |

> **Year 1 is 70%, not 85%.** Standard rate: 30% for the first 12 months of a
> subscription, 15% after. The Small Business Program (15% from month one)
> was considered and declined 2026-08-06 — see LAUNCH.md. Budget against
> **$7.00**, not $8.49, for a subscriber's first year.

Each active thread is one generation per day, 365 a year, so the model choice
*is* the unit economics:

| | Per entry | Per thread/yr | 3 threads |
|---|---|---|---|
| All Sonnet 4.6 | $0.0165 | $6.02 | $18.07 |
| Haiku for affirming entries | $0.00825 | $3.01 | $9.03 |
| + Batch API on the cron | $0.0041 | $1.51 | **$4.52** |

Against **$7.00** of year-one proceeds, routing alone leaves three threads
underwater ($9.03). With batching it is $4.52 — a 35% margin in year one,
47% thereafter. Both levers are needed, and both are now in place.

**Model routing.** `generate-entry` sends challenge entries to Sonnet and
affirming entries to Haiku. Challenge entries question the user's framing of
something they believe God is saying — the hardest thing the app does and the
easiest to do badly — so they keep the better model. A failed validation
escalates the retry to Sonnet regardless.

**Batching.** Cron generation goes through the Message Batches API at half
price; on-demand generation stays synchronous because someone is waiting and
the volume is tiny. Submission runs `batch_lead_hours()` (2h) *before* each
user's notification hour, because batches are only guaranteed within 24h and
an entry that lands after its own notification is worse than a slightly early
one.

**Idle auto-pause.** Cost is driven by threads being *active*, not by anyone
reading them. `pause_idle_threads()` pauses active threads for users who
haven't opened the app in `idle_pause_days()` (14). Pausing is reversible and
destroys nothing. This is the difference between paying for three threads and
paying for three *used* threads, and in a category with steep week-four
drop-off it is probably the largest single saving of the three.

The cap itself is a Postgres trigger (`guard_active_topic_cap`), not a client
rule. If price or models change, change `max_active_topics()` with them.

### Known risk

**Adverse selection.** Engaged users run more threads *and* churn less, so
the renewing cohort skews expensive over time. The blended cost today is well
under the 3-thread worst case; watch whether that stays true at renewal.

### Where the gate actually is

The client (`src/lib/entitlements.ts`) decides what to *render*. It is not a
security boundary. Enforcement is server-side in three places, all reading
`has_active_entitlement()`:

| | What it protects |
|---|---|
| `generate-entry` | on-demand generation (402) and the cron batch (filtered) |
| `synthesize` | the most expensive single call in the app (402) |
| `run_daily_generation()` | the nightly job only fires for due **and** entitled users |

All three fail **closed**: an entitlement lookup that errors means no
generation.

`public.subscriptions` is written only by the `rc-webhook` edge function under
the service role. There is no insert/update RLS policy, so a client cannot
grant itself an entitlement even with a valid JWT.

### Deliberately not gated

`exportJournalMarkdown()` and the content-report flow. Selling access to
generated content is fair; withholding a user's own writing, or their route to
flag harmful output, is not.

## Boundaries for later productization

- All AI calls live in edge functions (step 2+); the client never sees the key.
- Entry generation and synthesis are separate functions → RevenueCat
  entitlement gates (now live, see above).
- Notification scheduling will sit behind an interface so Capacitor Local
  Notifications can be swapped for FCM/APNs.
