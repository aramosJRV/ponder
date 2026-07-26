# Promptings

Personal daily devotional app. Generates devotional content around topics you
sense God is speaking about, supports multiple topics in parallel, and helps
you discern patterns over time via notes and topic-level synthesis.

**Stack:** Capacitor + React + TypeScript + Tailwind · Supabase (Postgres,
Auth, Edge Functions, pg_cron) · Claude API (server-side only) · WEB Bible
(public domain, loaded into Postgres).

## Status

- [x] **Step 1** — Supabase schema + RLS + WEB Bible import + seed script
- [x] **Step 2** — Generation edge function with validation (deployed as `generate-entry`)
- [x] **Step 3** — Today screen + note capture (Vite + React + Capacitor shell, magic-link auth, offline cache, on-demand generation)
- [ ] Step 4 — Topics CRUD + topic detail + journal rollup
- [ ] Step 5 — pg_cron scheduling + local notifications
- [ ] Step 6 — Synthesis (on-demand + conclusion flow)
- [ ] Step 7 — Settings + challenge-frequency control

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

## Boundaries for later productization

- All AI calls live in edge functions (step 2+); the client never sees the key.
- Entry generation and synthesis are separate functions → natural RevenueCat
  entitlement gates later.
- Notification scheduling will sit behind an interface so Capacitor Local
  Notifications can be swapped for FCM/APNs.
