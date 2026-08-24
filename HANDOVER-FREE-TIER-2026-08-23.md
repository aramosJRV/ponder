# Free tier + spend cap — what changed and what you do next
**23 Aug 2026** · Phases 1–2 of `PLAN-FREE-WITH-SUPPORT-2026-08-23.md`

`npx tsc --noEmit` passes. `npm run build` was **not** run here — the Cowork Linux VM is missing rollup's linux-arm64 binary and installing it would pollute your Mac's `node_modules`. Run the build yourself.

---

## Correction from the plan

The batch `custom_id` bug is **already fixed in source** — `generate-entry/index.ts` builds `` `${topicId}_${date}` `` with a comment documenting the colon failure. Nothing to do in code. What is *unverified* is whether that fix has been **deployed**; the sandbox can't reach supabase.co. Redeploy the function regardless (you're deploying it anyway, below).

---

## What changed

### New migration — `20260823000002_free_tier_and_spend_cap.sql`

| Object | What it does |
|---|---|
| `spend_ledger` | One row per Anthropic call. Tokens read from the response `usage` block, never estimated. RLS on, zero policies — service role only |
| `record_spend(...)` | Service-role writer, so the edge functions need no table grants |
| `spend_cap_usd()` | **33.0** (≈ A$50). A function, not a config row — changing a spend cap should be a reviewed migration, not an UPDATE someone runs at 1am |
| `month_to_date_spend_usd()`, `generation_allowed()` | The breaker |
| `spend_status()` | `{month_to_date_usd, cap_usd, allowed}`. **Operator only** — not granted to `authenticated`. For the SQL editor |
| `is_supporter(uuid)` | Alias for `has_active_entitlement`. Same mechanism, honest name — it no longer decides *whether* you may use Ponder, only *how much* |
| `max_active_topics(uuid)` | **3 free / 6 supporter.** No-arg version kept, returns 3 |
| `idle_pause_days(uuid)` | **7 free / 14 supporter** (was 14 flat). No-arg version kept, returns 7 |
| `due_prep_users()`, `due_users()` | Replace `entitled_prep_users()` / `entitled_due_users()`. Entitlement term dropped, spend gate added |
| `run_daily_generation()` | Refuses to submit at all when the ceiling is blown |
| `synthesis_allowed(uuid, text)` | Supporters unlimited; free tier 1 per thread per 30 days once the thread has 5+ notes; **conclusion syntheses exempt for everyone** |

`entitled_prep_users()` / `entitled_due_users()` are deliberately **left in place** though nothing calls them — dropping them would break a running cron if the migration and the function deploy land out of order.

### `supabase/functions/generate-entry/index.ts`
- Pricing table, `usdCost()`, `recordSpend()`, `generationAllowed()`.
- `callClaude()` takes an optional ledger context and records **before** validating the payload — the tokens were spent either way, and a run of unusable responses is exactly what the ledger should show.
- `fetchBatchResults()` now totals `usage` per model and returns `{byId, usageByModel}`; `collectBatches()` writes one half-price ledger row per model per batch.
- `isEntitled` / `entitledUserSet` **deleted**. Both gates replaced with the spend check, returning **429 `spend_cap`**, not 402 — nothing is for sale, so the client must not show a paywall.

### `supabase/functions/synthesize/index.ts`
- Same pricing/ledger treatment.
- Entitlement gate → `synthesis_allowed()` quota gate, moved to **after** the topic lookup so a user token can't probe someone else's quota (the topic query is what proves ownership).
- Refusals return 429 with a reason code (`spend_cap` / `too_few_notes` / `rate_limited`) plus human copy.

### Client
| File | Change |
|---|---|
| `src/App.tsx` | Paywall branch **gone**. Onboarding → straight into the app |
| `src/lib/entitlements.ts` | `shouldShowPaywall`, `assertEntitled`, `EntitlementError`, `SubscriptionRequiredError` removed. Added `isSupporter()`, `maxActiveThreads()`, `SpendCapError`, `SynthesisQuotaError`, new `GatedFeature` set |
| `src/lib/api.ts` | Gates removed from `generateSynthesis` / `generateEntryNow`. `quotaRefused()` splits `spend_cap` (no money fixes it) from the tier reasons. `MAX_ACTIVE_THREADS` const → `maxActiveThreadsForUser()` |
| `src/lib/billing.ts` | `TIPS_OFFERING_ID`, `loadTipPackages()` (returns `[]` when unconfigured), `purchaseTip()` (no entitlement wait — a consumable grants nothing) |
| `src/screens/Support.tsx` | **New.** Overlay, not a wall. Context-aware headline, supporter card, tip row, restore, Terms/Privacy. **No cost figures anywhere** |
| `src/components/SubscriptionSection.tsx` | "Subscription" → "Supporting Ponder"; opens the Support overlay |
| `src/screens/Topics.tsx` | Reads the tier-aware cap |

⚠️ **`src/screens/Paywall.tsx` is now orphaned.** Nothing imports it and it still typechecks, so it won't break a build — but delete it:

```
git rm src/screens/Paywall.tsx
```

(I can't delete files on your machine; the bridge blocks `rm`.)

---

## Deploy order — this matters

The edge functions call `generation_allowed()` and `record_spend()`. Both fail **closed**, so deploying functions before the migration means nothing generates until the migration lands. Do it in this order, back to back.

**1. Migration**
```
cd ~/Documents/Claude/Projects/Ponder
supabase db push
```
⚠️ Schema change. Review the file first. Never apply it by hand in the dashboard editor.

**2. Edge functions**
```
supabase functions deploy generate-entry
supabase functions deploy synthesize
```

**3. Verify in SQL**
```sql
select public.spend_status();                        -- {"allowed": true, ...}
select public.max_active_topics('<your user uuid>');  -- 3
select public.idle_pause_days('<your user uuid>');    -- 7
select * from public.due_prep_users();
```

**4. Watch the ledger fill**
```sql
select kind, model, count(*), round(sum(usd_cost), 4) as usd
from public.spend_ledger
where occurred_at >= date_trunc('month', now())
group by 1, 2 order by usd desc;
```
This is the first real number you'll have for what Ponder costs. Everything in the plan was modelled; check the model against it after a week and tell me if it's off.

**5. Build and sync**
```
npm run build
npx cap sync
```

Nothing is pushed to git — branch and commit yourself when you've read the diff.

---

## Store and RevenueCat work (not code)

**No App Store or Play price change is needed.** A subscription app is already listed free-with-IAP. Two edits only:

1. **Remove the 7-day trial.** A free trial is meaningless when the app is free, and it will read as deceptive to a reviewer.
   - Play Console → `ponder_annual` → base plan `annual` → deactivate offer `free-trial-7d`
   - App Store Connect → the subscription → remove the introductory offer
2. **Optional rename:** "Ponder Pro" → "Ponder Supporter", display name only, both consoles. Same product IDs, no new SKUs.

**New tips offering** (the Support screen omits the tip row until this exists — no dead buttons):
- Create consumables in both stores: `ponder_tip_small` A$4.99, `ponder_tip_mid` A$9.99, `ponder_tip_large` A$24.99
- RevenueCat → new offering with identifier exactly **`tips`**, one package per consumable
- Attach **no entitlement** — the moment a tip unlocks something it stops being a tip and becomes a price

---

## One thing that just got easier

The paywall was why you couldn't test on a device: `shouldShowPaywall()` hard-blocked every screen and `VITE_BILLING_BYPASS` is DEV-only, so a `cap sync` production bundle locked you out of your own app. That's gone. **You no longer need the RevenueCat promotional-entitlement workaround to see the app on a phone.**

---

## Cost visibility: none, on purpose

**No user-facing surface shows what Ponder costs to run.** Decided 23 Aug after a first pass that did.

- `spend_ledger` — RLS on, zero policies. Service role only.
- `spend_status()` and `month_to_date_spend_usd()` — **not** granted to `authenticated`. Operator only.
- `generation_allowed()` **is** granted to `authenticated`: it returns a bare boolean with no figures in it, and the client needs it to decide whether to offer a generate action.
- User-facing 429 copy says **when content returns, never why it stopped**: *"New entries are paused until the start of next month. Everything you've written is still here."* No dollars, no capacity, no apology about money.

Why: at low volume an honest figure reads as "nobody uses this" rather than "this is expensive", and since anonymous accounts are free to mint, granting to `authenticated` is granting to the public.

## Knowing when to top up — set the ladder in the Anthropic Console

Your ledger is for the app's own decisions. It is **not** the authority on your bill: ledger writes are best-effort by design, the pricing table in the edge functions can drift from real pricing, and anything else on that API key is invisible to it. The Console is the authority.

Console workspaces support both a spend limit and an **email notification at a threshold**. Set three rungs, in this order:

| Rung | Where | Value | What it does |
|---|---|---|---|
| 1 | Console email notification | ~US$25 | Early warning while the app is still fully working |
| 2 | `spend_cap_usd()` in the migration | US$33 | App degrades gracefully — stops generating, stays readable |
| 3 | Console workspace hard spend limit | ~US$50 | Last resort. Should never be reached |

Rung 3 must sit **above** rung 2. If Anthropic hard-stops the key first you get raw API errors instead of the graceful pause the app was built to do.

Setup: Console → Workspaces → create "Ponder" → create an API key inside it (keys cannot move between workspaces, so this is a new key + a `supabase secrets set ANTHROPIC_API_KEY=...`) → Limits tab for the spend limit and the notification. Side benefit: Ponder's spend is isolated from anything else on the account.

---

## Still to do

| # | Item | Why it's not done |
|---|---|---|
| 1 | **Gratitude-moment triggers** — open Support after a synthesis, on thread conclusion, at day 30/100/365, after a long note | Touches `TopicDetail`/`Today`; wanted the gates landed and reviewed first. Support.tsx already takes the `context` prop for it |
| 2 | **Gate song-of-the-day to supporters** | Song generation is deployed for everyone right now. Half-gating it would have been worse than not starting |
| 3 | **A "the breaker tripped" alert** | The Console tells you about money; it can't tell you the app stopped generating. Needs a channel decision — see below |
| 4 | **Phase 3: the hybrid content pool** | The big one. ~90 retained users of runway before it binds |

---

## Note on the breaker-tripped alert

If the Console email at rung 1 lands well below your cap, you should always have days of warning and the breaker should never fire unannounced. That makes an explicit trip alert a nice-to-have rather than a gap.

If you want one anyway, the cheapest build reuses what's already there — `pg_cron` + `net.http_post` + a Vault secret, exactly like `call_edge_function()` — POSTing to a Slack or Discord webhook when `generation_allowed()` returns false. No new service, no email provider. Email instead would mean adding Resend or similar; GoTrue's SMTP can't be called for arbitrary mail.

A scheduled Cowork task is **not** an option: the Cowork Linux VM cannot reach `*.supabase.co` (verified 23 Aug — `api.anthropic.com` resolves and answers, Supabase times out).

---

## Verification I could not run here

- `npm run build` — rollup platform binary, see the top
- Deno typecheck of the two edge functions — no `deno` or `supabase` CLI in the Cowork VM. Both files were reviewed by hand and every removed symbol grep'd to zero, but the first real check is `supabase functions deploy`
- Nothing was executed against the live database

---
---

# Addendum — 23 Aug, later: pool + tripwire

Antonio's direction changed the design: **the app stays free, users never see anything about cost or ceilings, and the user experience must not change because credits ran out.** Funding is handled by Console auto-reload.

## What that changed

**The cap is no longer a budget.** It's a runaway tripwire: **US$150/month and US$15/day**, neither reachable by real usage. Crossing one means a bug in this repo — a retry loop, a resubmitting batch, a prompt that always fails validation and escalates. It now:

- halts **only** the automated nightly job and the pool top-up
- writes a `generation_failures` row with `stage = 'spend_tripwire'` and the figures
- **never** gates a user-facing path

`generation_allowed()` is no longer granted to `authenticated`. The client never asks.

Synthesis is no longer gated on spend either — it's user-triggered, so it's rate-limited by a human pressing a button, and the note floor already bounds it.

**`SpendCapError` is gone**, replaced by `GenerationDelayedError`: *"Today's entry is running late. Everything you've written is still here — try again in a little while."* Every server-side failure now collapses to that one message — an upstream 502, a rate limit, unusable model output. The real reason goes to `generation_failures`, never to the reader.

## The pool — `20260823000003_entry_pool.sql`

This is what actually delivers "the experience never changes". Auto-reload can't cover an Anthropic outage, a rate limit, or a bug; a library on disk can.

| Object | Purpose |
|---|---|
| `entry_themes` | 40 seeded themes. `description` is the brief handed to the builder, so it's written as instructions to a writer |
| `topics.theme_id / theme_confidence / theme_classified_at` | Which theme a thread matched, and how well |
| `entry_pool` | The library. Mirrors `daily_entries` columns so serving is a copy, not a transformation |
| `entry_pool_seen` | What each thread has already been given. Survives a user deleting a day |
| `select_pool_entry()` | Picks one, applying the **same** exclusions as the live path — verse never repeated on a thread, nothing seen cross-thread in 60 days |
| `serve_pool_entry()` | Copies into `daily_entries` and marks it seen, one transaction |
| `pool_depth()` | Unserved entries per theme — the number that decides top-ups |
| `run_pool_topup()` | pg_cron hourly at :35, 10 entries a round, no-op once every theme is at target |

**Sharing rule, as you asked:** entries are shared across users **only** where the thread theme matches *and* the classifier scored ≥ `pool_confidence_floor()` (0.6). Everything below that keeps per-user generation. The classifier prompt actively pushes toward "no match" — a wrong theme produces entries that miss, which a user can feel; an unclassified thread just costs a few cents a month.

## Generation order now

```
ensureTheme()            classify once, lazily, self-healing
  ↓
tryPool()                free, instant, verse already validated
  ↓ miss
live generation          2 attempts, callClaude backs off 3× on 429/5xx
  ↓ fail
tryPool(opposite type)   a challenge entry beats no entry
  ↓ fail
"running late"           retry available, nothing lost
```

The batch path checks the pool **before** anything enters the batch — that's where the money is saved. The nightly bill now scales with the number of **themes**, not users.

`fetchBatchResults` repair also tries the pool before spending Sonnet money to rescue a row.

## Classifier

Runs inside `generate-entry` (`ensureTheme`), not at thread creation — one place instead of two, no client change, and it self-heals threads that predate the pool or whose classification failed. One Haiku call per thread, ever. Ledgered as `kind = 'classify'`.

## Pool builder

`generate-entry` with `mode: "pool_build"`, service key only, tripwire-checked. Synchronous, capped at 10 per invocation so it can't time out mid-run. Targets 120 affirming / 40 challenge per theme. **Verses are resolved and validated at build time**, so a bad reference never reaches a user and the ~18% retry cost is paid once instead of per reader.

Seed the pool faster than the hourly cron by calling it directly:

```
curl -X POST "$FUNCTIONS_URL/generate-entry" \
  -H "Authorization: Bearer $SERVICE_KEY" -H "Content-Type: application/json" \
  -d '{"mode":"pool_build","count":10}'
```

## Your actions, updated

1. **Turn on Console auto-reload** (Billing → threshold + reload amount). Running out is an immediate hard stop on the API — this is the single most important item.
2. Deploy: `supabase db push`, then `supabase functions deploy generate-entry` and `synthesize`.
3. `git rm src/screens/Paywall.tsx`.
4. Seed the pool before real users arrive — run `pool_build` in a loop until `pool_depth()` looks healthy. ~US$40 for a full library at target depth.
5. Remove the 7-day trial in both consoles; create the `tips` consumables when ready.
6. Set a Console **notification** (not a hard limit) somewhere above normal spend, as a second pair of eyes on the tripwire.

## Still open

- Gratitude-moment triggers for the Support overlay
- Gating song-of-the-day to supporters — note the pool builder does **not** generate songs yet, so pooled entries have no song. That is currently the one visible difference between a pooled and a live entry, and it needs closing before the pool carries most traffic.
- A "tripwire fired" alert (pg_cron + `net.http_post` to a webhook)
- Human review pass over the pool (`entry_pool.reviewed`)
