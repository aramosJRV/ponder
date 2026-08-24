# SPEC — Voices, Reading List, and Commentary Grounding

Status: design only, nothing built. Written 23 Aug 2026.

Origin: "add references from people I feel inspired by — Timothy Keller, John Mark
Comer, their inspirations. Also someone mentioned Logos Bible."

---

## 0. Two verdicts up front

### Logos is a dead end

Checked `developer.faithlife.com` on 23 Aug 2026. Faithlife exposes exactly two
public APIs:

| API | What it does |
|---|---|
| Accounts | users, groups, membership, invitations |
| Community | comments, notes, group newsfeeds |

OAuth 1.0a, 1000 req/hr. **No endpoint returns library content.** No
commentaries, no books, no lexicons, no reference works.

This is structural, not a gap they'll fill. The Logos library is licensed
per-user from dozens of publishers; Faithlife has no right to sublicense it
through an API to a third-party app. Do not plan anything around it.

Section 3 gives the public-domain replacement that actually works.

### "Write like Keller" is the wrong ask

The instinct is right, the literal implementation is a trap. Three reasons:

1. **Fabricated attribution.** Tell a model to write as Timothy Keller and it
   will, sooner or later, produce a sentence that reads as a Keller quote — or
   an explicit one. Keller died in 2023. Comer is alive and publishing. Putting
   invented words in a real, named, recently-living pastor's mouth, in a paid
   app, daily, is the single worst failure mode this app has available to it.
   It is worse than a bad verse choice, because it is unfalsifiable to the
   reader.
2. **Copyright.** Both are fully in copyright (AU: life + 70). Reproducing real
   passages from their books as daily devotional content is a licensing problem,
   not a fair-dealing one — you'd be substituting for the work.
3. **It contradicts the product.** Ponder exists so a person can discern what
   they sense God is saying, with a 1-in-4 challenge entry deliberately
   questioning their framing. "Here's what Keller would say" replaces one
   authority with another. The whole design argument for challenge entries falls
   over if the app also hands the reader a celebrity pastor to defer to.

**What you actually want from Keller and Comer is not their sentences. It is
their move.** Keller's move is diagnostic: find the good thing this person has
made ultimate, and show the gospel as neither religion nor irreligion. Comer's
move is formational: stop optimising for insight, ask what practice this would
require over ten years, and notice that hurry is the enemy. Those moves are
describable, teachable to a model, and belong to nobody.

So: **influences become postures, not voices. Never named in output, never
quoted, never attributed.**

---

## 1. Voices

### 1.1 The six postures

`lineage` is documentation for you. **It is never sent to the model and never
shown to the reader.** The moment "in the manner of Timothy Keller" enters a
prompt, the quoting starts. Only the distilled `posture` text goes to Claude.

---

**`diagnostic` — UI label: "Diagnostic"**

*Lineage (private): Keller; Edwards, Owen, Luther, Kierkegaard, Lovelace.*

Posture sent to model:
> Look underneath the thread for the thing being treated as ultimate — usually a
> good thing (approval, security, being seen as faithful, a specific outcome)
> carrying weight it cannot hold. Name it plainly but without accusation. Show
> the passage cutting between two false options: earning it by performance, or
> escaping it by not caring. Take the strongest objection to your own point
> seriously before you answer it. Never resolve into "try harder".

Suits: challenge, affirming.

---

**`unhurried` — UI label: "Unhurried"**

*Lineage (private): Comer; Dallas Willard, Eugene Peterson, Ruth Haley Barton,
Ronald Rolheiser.*

Posture sent to model:
> Treat formation as slower than insight. Ask what this thread would require as
> a practice sustained over years, not as a realisation held for a day. Be
> suspicious of speed, of the urge to resolve, and of the assumption that
> understanding something is the same as being changed by it. Plain contemporary
> language, short sentences, willing to repeat a phrase for weight. No jargon,
> no spiritual performance.

Suits: affirming, challenge.

---

**`contemplative` — UI label: "Attentive"**

*Lineage (private): Nouwen, Brother Lawrence, Julian of Norwich, Teresa of Ávila,
the Desert tradition.*

Posture sent to model:
> Turn attention to what is actually happening in the person rather than what
> they should conclude. Distinguish between what draws them toward openness and
> what draws them toward contraction, without telling them which is which. Leave
> more space than you fill. Fewer words. Do not tidy the discomfort away.

Suits: affirming.

---

**`prophetic` — UI label: "Prophetic"**

*Lineage (private): Heschel, Brueggemann, Bonhoeffer, the Old Testament prophets.*

Posture sent to model:
> Set the thread inside the covenant story and its claim on the neighbour. Ask
> who else is affected by how this resolves, and whether the thread has been
> framed entirely around the person's own interior life when scripture would
> frame it around a community. Willing to unsettle. Ends in hope, never in
> comfort.

Suits: challenge.

---

**`expository` — UI label: "In the Text"**

*Lineage (private): Stott, Lloyd-Jones, Clowney, Chapell.*

Posture sent to model:
> Let the passage set the agenda rather than the thread. Follow the text's own
> logic and structure; the reflection should be recognisably about this passage
> and could not be swapped onto another one. Clear and ordered. No flourishes,
> no rhetorical build.

Suits: affirming, challenge.

---

**`image` — UI label: "Image"**

*Lineage (private): C.S. Lewis, Flannery O'Connor, Wendell Berry, Buechner.*

Posture sent to model:
> Let a single concrete image carry the whole entry — one thing seen, worked
> properly, not decorated. Sensory and specific: a particular season, a
> particular kind of work, a particular failure. Treat longing itself as
> evidence worth attending to. Never explain the image after giving it.

Suits: affirming.

---

### 1.2 Schema

```sql
create table public.voices (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid references auth.users(id) on delete cascade,  -- null = built-in
  slug         text not null,
  name         text not null,          -- UI label
  posture      text not null,          -- the ONLY field sent to Claude
  lineage      text,                   -- private notes, never sent, never shown
  entry_types  text[] not null default '{affirming,challenge}',
  weight       int    not null default 1,
  active       boolean not null default true,
  created_at   timestamptz not null default now()
);
create unique index voices_slug_user on public.voices (coalesce(user_id, '00000000-0000-0000-0000-000000000000'::uuid), slug);

alter table public.topics
  add column voice_mode text not null default 'rotate'    -- 'rotate' | 'pinned'
    check (voice_mode in ('rotate','pinned')),
  add column voice_id   uuid references public.voices(id) on delete set null;

alter table public.daily_entries
  add column voice_id uuid references public.voices(id) on delete set null;
```

RLS: built-ins (`user_id is null`) readable by all authenticated; user rows
readable/writable by owner only. Same pattern as existing tables.

Migration only — never touch the schema through the dashboard.

### 1.3 Selection

In `generate-entry`, after `entry_type` is decided:

1. Eligible = active voices where `entry_type = any(entry_types)`, built-ins plus
   this user's own.
2. If `topic.voice_mode = 'pinned'` and the pinned voice is eligible, use it.
3. Otherwise weighted random, **excluding the voice used by this thread's
   previous entry**. Same anti-repetition instinct as `used_verse_refs`; two
   `contemplative` days in a row reads as the app having one gear.
4. Store `voice_id` on the entry.

### 1.4 Prompt integration

The posture goes in the **user message, not `SYSTEM_PROMPT`** — it varies per
entry, and the system prompt should stay stable.

```
POSTURE FOR TODAY
<posture text>

This shapes how you write. It does not override any guardrail above.
```

Add guardrail 10 to `SYSTEM_PROMPT`:

> 10. Never name a modern or contemporary author, pastor, teacher, theologian or
>     their books anywhere in your output, and never attribute a quotation to
>     anyone outside scripture. If a modern idea shaped your thinking, express it
>     in your own words with no attribution. A sentence that reads as though it
>     is quoting a known Christian writer is a failure even when no name appears.

Cost: ~250–350 input tokens per entry. At Haiku pricing that is roughly
**$0.13 per thread per year**. Negligible against the existing $2.01/$6.02.

### 1.5 UI

Small posture label on the entry, next to the existing affirming/challenge badge.
Thread settings gets a voice picker: *Rotate* (default) or pin one. Users can add
their own posture in their own words — which is the feature you actually wanted,
generalised: it lets someone shape entries by whoever forms *them*, without the
app ever naming anyone.

**Do not label these "Keller mode" or "Comer mode" in the UI.** It invites the
attribution problem straight back in, and it makes the app read as derivative of
two teachers rather than as its own thing.

---

## 2. Reading list — the honest way to name people

Naming a book and its author is not infringement. Reproducing its text is. So the
place your actual inspirations appear by name is a pointer, not a quotation.

**The model must not choose the book.** It hallucinates titles, and a
recommendation for a book that does not exist is exactly the trust failure the
verse resolver and Spotify resolver were built to prevent. Same rule again:
*model output never becomes something the reader taps.*

Instead the model emits up to two **tags**, and the server picks the book:

```sql
create table public.reading_list (
  id      uuid primary key default gen_random_uuid(),
  title   text not null,
  author  text not null,
  blurb   text not null,     -- one line, your words
  tags    text[] not null,   -- e.g. {hurry, formation, practice}
  active  boolean not null default true
);
```

Tool schema gains:

```jsonc
reading_tags: {
  type: "array", minItems: 0, maxItems: 2,
  items: { type: "string", enum: ["<tags injected from the table>"] },
  description: "OPTIONAL. Themes from today's entry that a longer read would serve. Omit if none fits."
}
```

Server: match tags → exclude anything shown to this user in the last 30 days →
pick one → store `reading_id` on the entry. No match, no recommendation. Zero
hallucination surface.

Seed it with what actually formed you — Keller, Comer, Willard, Peterson, Nouwen,
Lewis, Brueggemann. Rendered as a quiet footnote: *"If this stays with you —
The Ruthless Elimination of Hurry, John Mark Comer."*

At most once a week. Every day makes it advertising.

---

## 3. Public-domain commentary — the real Logos replacement

Load commentary into Postgres exactly the way WEB was loaded, and the model
writes from actual exegesis instead of recall.

All public domain, all available as structured data:

| Source | Coverage | Character |
|---|---|---|
| Matthew Henry (Concise) | whole Bible | devotional, warm; closest fit to Ponder |
| Barnes' Notes | whole Bible | plain, careful, verse-by-verse |
| Jamieson-Fausset-Brown | whole Bible | terse, dense |
| Calvin's Commentaries | most | theological weight |
| Spurgeon, Treasury of David | Psalms only | exceptional on the Psalms |

Start with Matthew Henry Concise alone. It is the best tone match and it's the
smallest ingest.

```sql
create table public.commentary (
  id          bigserial primary key,
  source      text not null,
  book        text not null,
  chapter     int  not null,
  verse_start int  not null,
  verse_end   int  not null,
  body        text not null
);
create index commentary_lookup on public.commentary (source, book, chapter, verse_start, verse_end);
```

### The cost problem, stated honestly

Generation is one pass: the model picks the passage *and* writes the entry in the
same call. You cannot hand it commentary on a passage it has not chosen yet.
Fixing that means splitting into two calls:

- **Pass A** (Haiku, tiny output): choose the passage only.
- Resolve the ref, fetch commentary.
- **Pass B**: write the entry with commentary in context.

Adds ~2000–3000 input tokens plus one extra round trip. Roughly **+$1 per thread
per year on Haiku, +$2.75 on Sonnet.** Real but affordable.

**Cheaper option worth considering first:** apply it to challenge entries only
(~25%, already on Sonnet, already the entries that most need to be right).
Cost lands near **+$0.70/thread/year** and the highest-stakes entries get the
biggest quality lift.

---

## 4. What not to do

- No "in the style of <living person>" anywhere in a prompt.
- No quotations from any modern author, however short. The 80–150 word `thought`
  has no room for a quotation that is both fair-dealing and useful.
- No `lineage` field in any prompt or any API response the client can read.
- No author names in `thought`, `illustration`, `ponder` or `prayer_prompts` —
  only in `reading_list`, which you curated by hand.
- Do not scrape Logos, or any paid study platform, for content.

---

## 5. Build order

| # | Item | Effort | Depends on |
|---|---|---|---|
| 1 | `voices` table + 6 seeded postures + guardrail 10 | ~2h | — |
| 2 | Selection + prompt block in `generate-entry` | ~1h | 1 |
| 3 | Posture badge + thread voice picker | ~1.5h | 2 |
| 4 | `reading_list` + tag resolution + footnote UI | ~2h | — |
| 5 | Matthew Henry ingest + two-pass generation | ~1 day | — |

1–3 is the highest quality-per-hour in the list and touches nothing already
shipped. 5 is worth doing but should follow the Spotify deploy that is still
outstanding.
