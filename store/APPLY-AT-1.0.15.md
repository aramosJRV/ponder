# Apply these in App Store Connect when the 1.0.15 version record is created

Decided 12 Sep 2026 (Antonio chose to defer rather than create the version record
early). Rationale and full working: `store/ASO-AUDIT-2026-09-12.md`.

**Why it has to wait:** on a released version every ASC metadata field is disabled.
App Information states it plainly — *"To make changes to the app name, category, or
privacy policy, create a new app version."* 1.0.14 is Ready for Distribution, so
keywords, subtitle and category are all locked until 1.0.15 exists in Prepare for
Submission.

## 1. Keywords (App Store → the 1.0.15 version page)

Replace the current 95-char field:

```
devotion,quiet,time,prayer,christian,faith,scripture,verse,reflect,discern,journaling,spiritual
```

with this 100/100 field:

```
quiet,time,prayer,christian,faith,scripture,verse,reflect,spiritual,god,hearing,notes,study,guidance
```

Dropped as dead weight — Apple already indexes the name and subtitle and recombines
them with the keyword field, so these earned nothing:
`devotion` (dup of subtitle "devotionals"), `journaling` (dup "journal"),
`discern` (dup of "Discernment" in the name).

Added: `god`, `hearing`, `guidance`, `notes`, `study` — these recombine into
*hearing god*, *god guidance*, *spiritual guidance*, *bible study notes*.

Do NOT add: `plan` (YouVersion owns "bible reading plan" and Ponder isn't one),
`meditation` (wrong audience), any competitor brand name (Apple rejects trademarked
terms and it holds up review), `app` or `free`.

## 2. Category (App Information)

Primary: **Lifestyle → Reference**
Secondary: **Reference → Lifestyle**

YouVersion, the category leader, sits in Reference. Lifestyle is a generic bucket
Ponder will never chart in. Reversible, costs nothing.

## 3. Subtitle — leave as is

`Bible devotionals & journal` stays. A denser alternative was considered
(`Bible devotions prayer journal`, 30/30) but it reads like keywords to a human,
and the subtitle is a conversion surface as well as an indexed one.

## 4. Description — one factual fix

The Apple description still says scripture is the World English Bible only.
BSB and KJV shipped 1 Sep 2026. The Play copy is already corrected; mirror it.

---

## Not blocked by any of this

The in-app review prompt is still the highest-ROI item and needs no version record
to develop — only to ship. Fire it after the user saves their first note, not on
launch. The App Store page still has too few ratings to display an overview, and
that, not keywords, is what caps search ranking.
