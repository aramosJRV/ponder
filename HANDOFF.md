# Ponder — session handoff

Paste this at the start of a new session. Repo: `~/Documents/Claude/Projects/Ponder`.
Deeper detail lives in `LAUNCH.md`, `store/SUBSCRIPTION-SETUP.md`,
`store/SCREENSHOTS.md`, `store/listing-metadata.md`, `README.md`.

---

## Where things stand

Ponder is a daily devotional app (Capacitor + React + TS + Tailwind,
Supabase, Claude API server-side only, WEB Bible in Postgres). Steps 1–7 of
the original build were already done. This session added the **subscription**
end to end and shipped the cost work that makes its price viable.

**iOS is complete: Apple → RevenueCat → Supabase, verified at every hop.**
Android and the store submission are not.

---

## Decisions already made — do not re-litigate

| Decision | Value |
|---|---|
| Price | **A$15.99 base → US$9.99**, C$12.99, €9.99 |
| Trial | 7 days (Apple "1 Week" introductory offer) |
| Paywall | **Hard** — no free tier after trial |
| Active threads | **3** |
| Apple Small Business Program | **Declined.** Standard rate: 30% yr 1, 15% after. Budget **US$7.00** first-year proceeds, $8.49 after. Don't raise it again. |
| Base storefront | Australia |
| Account model | Anonymous auth; email backup **required before purchase** |

I argued for US$24.99 (category charges $40–70: Hallow $69.99, Abide $39.99,
Glorify ~$49.99). Antonio chose $9.99. Settled.

### Unit economics (why the code looks the way it does)

365 generations per thread per year. Net revenue **US$7.00** yr 1.

| | per entry | per thread/yr | 3 threads |
|---|---|---|---|
| All Sonnet 4.6 | $0.0165 | $6.02 | $18.07 |
| + Haiku for affirming entries | $0.00825 | $3.01 | $9.03 |
| + Batch API | $0.0041 | $1.51 | **$4.52** |

Both levers were required — routing alone left 3 threads underwater. Both are
built. **Known risk: adverse selection** — engaged users run more threads and
churn less, so the renewing cohort drifts toward the expensive end.

---

## Built this session (all verified: `tsc` clean, `vite build` clean, migrations exercised on real Postgres via PGlite)

**Server**
- `subscriptions` table — written *only* by `rc-webhook` under service role; no insert/update RLS policy, so a client can't grant itself an entitlement.
- `has_active_entitlement()` enforced in 3 places, all **failing closed**: `generate-entry` (402), `synthesize` (402), `run_daily_generation()`.
- `rc-webhook` edge function — constant-time header auth, event-id dedupe, out-of-order guard.
- **Model routing** — challenge entries → Sonnet, affirming (~75%) → Haiku; failed validation escalates the retry to Sonnet.
- **Batch API** — cron generation batched at half price, submitted `batch_lead_hours()` (2h) *before* each user's notification hour; `ponder-batch-collect` drains every 10 min. On-demand generation stays synchronous.
- **Idle auto-pause** — `pause_idle_threads()` pauses active threads after 14 days without an app open. Cost tracks engagement, not entitlement.
- 3-thread cap enforced by Postgres trigger `guard_active_topic_cap` / `max_active_topics()`.

**Client**
- `Paywall.tsx`, `SubscriptionSection`, RevenueCat SDK wiring, `recordAppOpen()` on start + `visibilitychange`.
- `exportJournalMarkdown()` reachable **from the paywall itself**, never entitlement-gated — selling generated content is fair, withholding the user's own writing isn't. Content reporting is also ungated (Play AI policy).

---

## Live configuration

**Apple** (App ID `6796225096`)
- Group **Ponder** (`22288415`); subscription **Ponder Annual**, Apple ID `6798269811`
- Product ID `au.com.ponder.app.pro.annual`, 1 year
- en-AU localisation: "Ponder" / "Daily scripture and reflection across your threads."
- Introductory offer: **Free first week**, 175 territories, Aug 6 2026 → no end date
- Paid Apps Agreement, NAB (AUD) bank, tax forms — all **already Active**

**Supabase** (`rkslrbcbncecekghwbap`)
- All migrations applied and verified. `RC_WEBHOOK_SECRET` set.
- `rc-webhook`, `generate-entry`, `synthesize` deployed.
- Cron: `promptings-daily-generation` (hourly), `ponder-batch-collect` (*/10), `ponder-idle-pause` (03:10 UTC)

**RevenueCat** (project `624ea9a8`)
- iOS app `appf7545616e3` → `au.com.ponder.app`, **credentials valid**
- Reused existing team keys: IAP `3QTZ845SJM`, ASC API `KS4F3A8FN2` (no new .p8 needed)
- Entitlement **`pro`** (`entl9775d1e75f`) ← product attached
- Offering **`default`** (`ofrnga97ac601ff`) → package **`$rc_annual`**
- iOS public SDK key `appl_ItLdOVfcICiTxoFPvFwfwmxZApx`
- Webhook live, **Send test event passed**

---

## What's left, in dependency order

1. ~~**Host the privacy policy.**~~ ✅ **DONE 2026-08-15.** Live at <https://exquisite-muffin-f2982a.netlify.app/privacy.html>, `VITE_PRIVACY_URL` set in `.env`, `netlify.toml` publishes `public/` only. The policy was also rewritten to disclose purchase history and RevenueCat — it predated the subscription entirely. **It was not the long pole.** See `AUDIT-2026-08-15.md` for what actually is.
2. **Build.** `npm install` (RevenueCat plugin is new) → set `.env` → `npm run build && npx cap sync`. Then **Xcode → Signing & Capabilities → + In-App Purchase** (without it StoreKit returns no products, silently).
3. **Screenshots.** Six listing shots + a **paywall capture** for Apple's subscription Review Information. Capture the paywall *before* running the seed. See `store/SCREENSHOTS.md`.
4. **Android:** build AAB → upload to internal testing → *then* create the Play subscription → then the RevenueCat Android app.
5. **Test six cases** (`SUBSCRIPTION-SETUP.md` §5). Most important: **cancelling must not cut access until `expires_at`**.
6. **Listing updates** — copy already written in `store/listing-metadata.md`: subscription disclosure block (Apple rejects without it), purchase-history added to App Privacy and Data safety, privacy URL.
7. Signed builds; submit the subscription **with an app version**, never alone.

---

## Gotchas found the hard way

- RevenueCat webhook Authorization field: **raw secret, no "Bearer" prefix** — `rc-webhook` compares byte-for-byte. A prefix means 401 on every event.
- The webhook lives in **RevenueCat's** Integrations, not Supabase's.
- ASC subscription **description caps at 55 characters**.
- **ASC sessions expire fast.** Always reload and re-verify a save actually stuck — one price change silently didn't.
- ASC `<select>` elements ignore synthetic key events; had to set values via the React value setter.
- Play: the Subscriptions page shows **"Upload a new APK"** — subscriptions can't be created before a build is on a track.
- `supabase functions deploy` works fine without Docker.
- Diagnostics: browser GET on the webhook → `{"error":"POST only"}` = deployed. `curl -X POST ... -d '{}'` → `{"error":"Unauthorized"}` = secret set; `{"error":"not configured"}` = missing.

## Standing assumptions I got wrong — don't repeat

- Apple's Paid Applications Agreement was **already active**; I wrongly called it a multi-day blocker.
- A Play **merchant account already exists** (the other apps sell). The real Android blocker is the missing build.
- Both `content_reports` migrations were **already applied**; the README checklist was stale.
- I quoted 15% Apple commission all session. It's **30% in year one** — caught only by reading the Proceeds column in ASC.

Pattern: verify against the console before asserting a blocker.

## Open items worth a look

- Play notice (Aug 6): *"action is required with your payments account."* Generic; clear it before launch so it doesn't become a payout hold.
- Android developer verification deadline **Sep 30, 2026** (console says already compliant).
- Haiku now writes ~75% of what users read. Worth a side-by-side before launch — `ANTHROPIC_MODEL` pins both paths to one model for A/B.
- No upsell headroom at $9.99. A **$19.99 unlimited-threads tier** was sketched as the clean way out; `max_active_topics()` and the entitlement check are each a single point of change.
