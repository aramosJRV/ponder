# Ponder: free + donate — analysis and plan
**23 Aug 2026**

---

## Verdict first

**Free + donate does not work for Ponder, and the reason is structural, not a matter of execution.**

Donation models work when the marginal cost of one more user is ~zero — static content, a website, open-source software. Ponder's marginal cost per user is roughly **US$6–7/year, recurring, forever**, and under the current architecture it accrues whether or not the user ever opens the app.

That single fact kills the model. The arithmetic is below.

---

## 1. The economics

### Current position (per active 3-thread user, per year)

| | |
|---|---|
| Gross subscription | US$9.99 |
| Apple/Play cut (30% yr 1) | −$3.00 |
| **Net revenue** | **$7.00** |
| Claude API — quoted (1 call/entry, 3 threads × 365) | −$4.52 |
| Realistic, incl. ~18% verse-validation retries escalating to Sonnet, plus synthesis | **−$6 to −$7** |
| **Margin** | **≈ $0 – $1/yr** |

Read that again. **The subscription is already at break-even.** The 3-thread cap and Haiku/Sonnet routing were built as cost controls precisely because of this. There is no fat here to give away.

### Under free + donate

Cost stays at ~$6.50/user/yr. Apple/Play still take 30% of a tip (see §2). So:

**Break-even required gross donation = $6.50 ÷ 0.70 = $9.29 per user, per year.**

That is *more* than the $9.99 subscription nets you. The donation model needs **higher average revenue per user than the paid model it replaces**, while making payment optional.

Now apply real conversion rates. Consumer app tip jars convert at roughly **0.1–1%** of users. At a generous 1%:

> Each donor would need to give **≈ US$930 per year** for the model to break even.

At 0.3% conversion — a more honest number — it's **~$3,100 per donor per year**.

### What that means at scale
Every 1,000 free daily users costs **~$6,500/yr** in API spend. Realistic tip revenue from 1,000 users: **$20–60/yr**. Success becomes a liability that scales linearly. The better the app does, the faster it bleeds.

---

## 2. The platform rules make "donate" worse than you think

You cannot put a Ko-fi / Stripe / Buy-Me-a-Coffee link in the app.

**Apple:**
- 3.2.1(vi): non-IAP fundraising is for **approved nonprofits only**. A Pty Ltd is not one.
- 3.2.1(vii): person-to-person gifts can bypass IAP, but *"a gift that is connected to or associated at any point in time with receiving digital content or services must use in-app purchase."* Ponder is digital content. This exemption does not apply.
- 3.1.1: *"Apps may use in-app purchase currencies to enable customers to 'tip' the developer."* — i.e. tips are IAP.
- 3.1.1(a): external purchase links are permitted **only in the US storefront**. Everywhere else — including Australia — buttons or links to outside payment are prohibited.

**Google Play:** billing system is mandatory for in-app digital purchases. The donation exemption is for **"tax exempt donations"** only. Yours aren't.

**Consequence:** a "donate button" in Ponder is a **StoreKit/Play consumable IAP with a 30% platform cut**, not a clean 97%-to-you Stripe payment. You lose the main perceived upside of switching.

**Also:** money paid to your Pty Ltd is *not* a donation. It's assessable income, GST applies if registered, and it isn't deductible for the giver. Call it "Support Ponder" or "Tip", never "Donate" — the word is legally wrong and invites a Consumer Law problem.

---

## 3. You're solving the wrong problem

As of 20 Aug: **10 RevenueCat customers, 0 trialing, 0 paid.** The Apple product was in `MISSING_METADATA` at the 15 Aug audit and internal testing is gated by the AAB.

**Nobody has ever seen the paywall.** You have zero evidence that price is what's stopping conversion, because you have zero conversion data of any kind. What you have is a distribution problem — nobody knows the app exists — and you're proposing to fix it by changing a variable you've never tested.

Going paid → free is also effectively one-way. Reversing it later means grandfathering every existing user and taking a public beating for it.

---

## 4. What I'd actually do — freemium ceiling, not a wall

Keep the price. Change the paywall from a **wall** (blocks the whole app) to a **ceiling** (limits what the free tier does). This gets you the free-distribution benefit you're actually after, keeps a revenue mechanism, and caps the cost of a free user.

| | Free | Pro — US$9.99/yr |
|---|---|---|
| Threads | **1** | 3 |
| Daily entry, notes, journal | ✅ | ✅ |
| Local notification | ✅ | ✅ |
| Synthesis ("What's emerging?") | ❌ | ✅ |
| Song of the day | ❌ | ✅ |
| Thread conclusion + looking-back | ❌ | ✅ |
| Export | ❌ | ✅ |

**Free-user cost:** 1 thread ≈ **$1.50–2.20/yr**. With inactivity gating (§5) ≈ **$0.40/yr**. That is affordable customer acquisition — you're buying an install for 40c and getting a conversion surface.

**Why it works:** synthesis and conclusion are the features that only become valuable *after* the user has 30+ days of notes invested. That's the correct thing to charge for — the user hits the wall at the exact moment they're most committed. A daily verse is a commodity (YouVersion gives it away free); pattern-recognition across your own journal is not.

The 7-day trial then becomes redundant — drop it, or keep it as a "try Pro" trial from inside the free tier.

---

## 5. Non-negotiable prerequisite (whichever model you pick)

**Kill push generation.** Right now `pg_cron` generates nightly for every active thread, regardless of engagement. Free-tier churn is 80–95% in 30 days. You would be paying to generate devotionals for dead accounts, every night, indefinitely.

Fix, in order:

1. **Gate the cron on activity.** Add `last_opened_at` to the user/profile table; the nightly job only generates for threads whose owner opened the app in the last **3 days**. Migration on top of `20260803000002_cron_entitlement_gate.sql` — the gate hook already exists.
2. **Lazy fallback.** If a user returns after a gap, generate on app open. Slower first paint, one-time cost, and only for users who came back. Needs a loading state in the entry screen.
3. **Accept the notification trade-off.** Local notifications carry the day's verse, which requires pre-generation. So: users active in the last 3 days keep same-day notifications; lapsed users get a generic "Your thread is waiting" nudge and content generates on open.
4. **Fix the 18% verse-validation retry.** Every retry escalates a Haiku call to Sonnet — pure waste, and it's the single largest gap between your quoted $4.52 and actual cost. Worth a session on its own before any pricing change.

Expected effect: **70–85% cut in per-user API cost**. This is worth doing even if you keep the current pricing exactly as it is.

---

## 6. If you still want a tip jar (do it *on top of* freemium, not instead)

Tips and freemium aren't mutually exclusive. Add it as upside, not as the business model.

**Implementation**
- RevenueCat second offering `tips` with **consumable** products: `ponder_tip_small` $2.99, `ponder_tip_mid` $6.99, `ponder_tip_large` $14.99. Consumable, so a user can give more than once.
- Both stores — you already have the RC plumbing (offering `default`, entitlement `pro`, valid Play + App Store credentials). Adding a second offering is a dashboard change plus a `loadOffering("tips")` call.
- Grant a cosmetic "Supporter" marker in-app. No functional entitlement — the moment a tip buys features, it isn't a tip, it's a price.

**Placement is the whole game.** A button in Settings converts at ~0.05%. Gratitude moments convert 5–20× better:
- After a synthesis is generated and read
- On concluding a thread (the looking-back screen)
- At a 30 / 100 / 365-day streak
- After the user writes a note longer than ~200 words

**Set expectations:** budget for 0.3–1% conversion, ~$6 average, 30% platform cut. On 1,000 users that's **$12–40/year**. That is beer money, not a business. Build it because some users genuinely want to say thank you, not because it funds anything.

---

## 7. Sequence

| # | Step | Why first |
|---|---|---|
| 1 | Ship. Get the Apple product out of `MISSING_METADATA`, get a working internal test track. | You cannot make a pricing decision with zero funnel data. |
| 2 | Fix the 18% Sonnet retry. | Biggest single cost lever, zero pricing risk. |
| 3 | Add `last_opened_at` + gate the nightly cron. | Prerequisite for any free tier existing at all. |
| 4 | Run the current $9.99 model for 60–90 days with real installs. | Now you have conversion data instead of a hunch. |
| 5 | *Then* decide: freemium ceiling (recommended), or hold. | Informed, and reversible in the right direction. |
| 6 | Tip jar, at gratitude moments. | Cheap, additive, no downside. |

---

## Code touchpoints (for when you do it)

| File | Change |
|---|---|
| `src/App.tsx:157` | Remove full-app paywall gate; render normal app |
| `src/lib/entitlements.ts` | `shouldShowPaywall()` → per-feature `isEntitled(feature)`; add `"synthesis"`, `"song"`, `"export"`, `"multi_thread"` |
| `src/screens/Paywall.tsx` | Becomes an upsell sheet, not a full-screen wall |
| `max_active_topics()` (DB fn) | Return 1 or 3 based on `has_active_entitlement(user_id)` |
| `20260803000002_cron_entitlement_gate.sql` | Rewrite: gate on activity + tier, not on entitlement alone |
| `supabase/functions/synthesize` | 402 for free tier (server is the real enforcer) |
| RevenueCat dashboard | New `tips` offering, consumables, both stores |

**Never modify the Supabase schema directly — migrations only.**

---

## The one-line summary

Free + donate needs **higher** average revenue per user than the $9.99 subscription it replaces, because the cost per user doesn't change and Apple still takes 30% of the tip. The problem isn't the price — it's that nobody has installed the app yet, and that the nightly cron bills you for users who never come back.
