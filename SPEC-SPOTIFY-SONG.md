# Spec — Song of the day (Spotify)

Status: **code written 22 Aug 2026**, not yet deployed. Decisions closed §10.

Landed: `supabase/migrations/20260823000001_entry_song.sql`,
`supabase/functions/generate-entry/spotify.ts`, edits to `generate-entry/index.ts`,
`src/lib/types.ts`, `src/components/EntryCard.tsx`. `npx tsc --noEmit` clean.

Outstanding: register the Spotify app, set the secrets (§4), apply the
migration, redeploy the function, replace the placeholder Spotify logo (§6.2).

---

## 1. The rule this feature must not break

`verse_text` comes from `bible_verses`, never from the model. `cross_refs` are
validated against `bible_verses` and silently dropped if they don't resolve.
A Spotify link is the same class of object: **the model must never produce a
URL or a track ID.** It produces a *title + artist*, and the server proves the
track exists before the user sees anything.

Everything below is the `cross_refs` pattern applied to music.

---

## 2. Decision: entry-level, not thread-level

Per-day song, one per entry. Rejected the "playlist per thread" alternative:
the app's rhythm is daily, cost is effectively zero either way (Spotify search
is free, ~40 extra output tokens per entry), and a static playlist can't
respond to the day's passage.

The real cost of entry-level is **repetition** — an LLM asked for "a worship
song about stillness" converges on the same 30 CCM tracks forever. Handled by
a do-not-repeat list in the prompt (§5.3) plus a server-side drop (§5.5).

**Challenge entries get no song.** Decided against the spec's original
recommendation. The argument for the original — that a music-less entry looks
like the thinner entry — cuts the other way too: the absence *is* the signal.
A challenge morning that arrives quieter than the others reinforces the change
of posture rather than diluting it, and it removes the whole problem of asking
a model to pick a song that questions rather than resolves.

Cost of being wrong: low. It's one condition in `finalizeEntry` plus a prompt
line, reversible in a single deploy. Worth revisiting if challenge entries
start feeling punitive rather than searching.

**Worship/Christian music only.** Currently this happens by default — it's
what the model reaches for unprompted. Made explicit in guardrail 9 so it
stays a decision rather than an accident that drifts when the model changes.

---

## 3. Schema

New migration `supabase/migrations/20260823000001_entry_song.sql`:

```sql
-- ============================================================
-- Song of the day.
--
-- Populated by generate-entry ONLY with a track that was found on
-- Spotify AND whose title+artist matched what the model asked for.
-- The model never supplies a URL or track id — only a title and an
-- artist name, which are then looked up. Unmatched suggestions are
-- dropped and logged to generation_failures (stage = 'song_dropped').
--
-- Shape:
--   { "track_id": "1301WleyT98MSxVHPZCA6M",
--     "name": "Be Still My Soul",
--     "artist": "Kari Jobe",
--     "url": "https://open.spotify.com/track/1301WleyT98MSxVHPZCA6M",
--     "art": "https://i.scdn.co/image/...",
--     "asked": { "title": "Be Still My Soul", "artist": "Kari Jobe" } }
--
-- `asked` is kept for drift debugging: it is what the model wanted,
-- versus what Spotify actually returned. Never rendered.
--
-- NULL is a valid and expected value. No song is always better than
-- a broken link.
-- ============================================================

alter table public.daily_entries
  add column if not exists song jsonb;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'daily_entries_song_is_object'
      and conrelid = 'public.daily_entries'::regclass
  ) then
    alter table public.daily_entries
      add constraint daily_entries_song_is_object
      check (song is null or (
        jsonb_typeof(song) = 'object'
        and song ? 'track_id' and song ? 'name'
        and song ? 'artist'   and song ? 'url'
      ));
  end if;
end $$;

-- Repeat-avoidance lookup: "which tracks has this thread already used?"
create index if not exists daily_entries_song_track_idx
  on public.daily_entries ((song ->> 'track_id'))
  where song is not null;

comment on column public.daily_entries.song is
  'Verified Spotify track for this entry, or NULL. Every field came from a '
  'Spotify API response, never from model output. See 20260823000001.';
```

No RLS change — inherits `daily_entries` policies. Existing rows get `NULL`,
which the client already has to handle (same as pre-footnote `cross_refs`).

---

## 4. Secrets

Two new Supabase secrets. **Sandbox can't reach `*.supabase.co`** — set these
in the dashboard (Project Settings → Edge Functions → Secrets):

| Secret | Value |
|---|---|
| `SPOTIFY_CLIENT_ID` | from developer.spotify.com dashboard |
| `SPOTIFY_CLIENT_SECRET` | same |
| `SPOTIFY_MARKET` | `AU` (optional, defaults to `AU` in code) |

Register the app at <https://developer.spotify.com/dashboard> (log in first —
the Create app button only appears once authenticated). Redirect URI is
irrelevant: Client Credentials flow only, no user login, no OAuth screen.

**Feb 2026 developer-access changes — read this before planning around it.**
Spotify [tightened developer access](https://developer.spotify.com/blog/2026-02-06-update-on-developer-access-and-platform-security)
on 6 Feb 2026:

- **The app owner must hold an active Spotify Premium subscription.** If it
  lapses, the app stops working — songs silently stop appearing. This is now a
  standing operational dependency on Antonio's personal Premium account.
- One Client ID per developer; 5 authorised users per app (raised to 25 in
  July 2026). That cap is on *authenticated* users, i.e. OAuth. Client
  Credentials has no user, so server-side search should not be metered against
  it — **verify this in practice before assuming it.**
- `GET /search` is confirmed still available in Development Mode.

**The ceiling, stated plainly:** extended quota mode now requires a registered
*organisation* (not an individual), a launched service, and **250,000 monthly
active users**. Ponder will not qualify. It is permanently a Development Mode
app. For one user, or a small paid user base, that is fine. It means this
feature cannot scale with the product and must never become a headline
feature — if Ponder ever gets traction, the song row is the part that breaks.

**If either secret is absent the feature no-ops silently.** That's deliberate:
it means this can ship to the repo before the Spotify app exists, and the
nightly batch can't break because a secret got rotated.

---

## 5. Edge function changes

All in `supabase/functions/generate-entry/`.

### 5.1 New file: `spotify.ts`

```ts
// ------------------------------------------------------------------
// Spotify track resolution.
//
// The model proposes a song by title + artist. This module proves the
// track exists and that what came back is actually the song asked for.
// It NEVER throws to the caller — a missing song is a normal outcome.
// ------------------------------------------------------------------

const CLIENT_ID = Deno.env.get("SPOTIFY_CLIENT_ID") ?? "";
const CLIENT_SECRET = Deno.env.get("SPOTIFY_CLIENT_SECRET") ?? "";
const MARKET = Deno.env.get("SPOTIFY_MARKET") ?? "AU";

export const spotifyConfigured = () => Boolean(CLIENT_ID && CLIENT_SECRET);

export type Song = {
  track_id: string;
  name: string;
  artist: string;
  url: string;
  art: string | null;
  asked: { title: string; artist: string };
};

// Module-level token cache. Survives across items within one batch
// collection run, which is the case that matters (one invocation can
// finalize dozens of entries).
let token: { value: string; expiresAt: number } | null = null;

async function accessToken(): Promise<string> {
  if (token && Date.now() < token.expiresAt) return token.value;
  const res = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      authorization: `Basic ${btoa(`${CLIENT_ID}:${CLIENT_SECRET}`)}`,
    },
    body: "grant_type=client_credentials",
  });
  if (!res.ok) throw new Error(`spotify token ${res.status}`);
  const j = await res.json();
  // Refresh 5 min early rather than racing the expiry.
  token = { value: j.access_token, expiresAt: Date.now() + (j.expires_in - 300) * 1000 };
  return token.value;
}

// --- matching -----------------------------------------------------
//
// Spotify search is fuzzy and happily returns *something* for any query.
// Without a match check, "a song about stillness" that doesn't exist comes
// back as an unrelated track and we'd ship a confident wrong link — the
// exact failure the verse table exists to prevent.

const norm = (s: string) =>
  s.toLowerCase()
    .replace(/\(.*?\)|\[.*?\]/g, " ")                       // (Live), [Radio Edit]
    .replace(/\s-\s(live|acoustic|remix|radio edit|single version|remaster(ed)?)\b.*$/i, " ")
    .replace(/\bfeat\.?\b.*$/i, " ")
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/** Sørensen–Dice on character bigrams. 1.0 = identical. */
function dice(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const grams = (s: string) => {
    const m = new Map<string, number>();
    for (let i = 0; i < s.length - 1; i++) {
      const g = s.slice(i, i + 2);
      m.set(g, (m.get(g) ?? 0) + 1);
    }
    return m;
  };
  const A = grams(a), B = grams(b);
  let hits = 0, total = 0;
  for (const [g, n] of A) { total += n; hits += Math.min(n, B.get(g) ?? 0); }
  for (const [, n] of B) total += n;
  return (2 * hits) / total;
}

const TITLE_MIN = 0.82;
const ARTIST_MIN = 0.75;

function matches(asked: { title: string; artist: string }, t: any): boolean {
  const at = norm(asked.title), aa = norm(asked.artist);
  if (dice(at, norm(t.name)) < TITLE_MIN) return false;
  // Any credited artist may satisfy the check — collabs and features are
  // routinely mis-attributed by the model, and getting the song right
  // matters more than getting the billing order right.
  return (t.artists ?? []).some((x: any) => {
    const na = norm(x.name ?? "");
    if (!na) return false;
    if (na === aa || na.includes(aa) || aa.includes(na)) return true;
    return dice(aa, na) >= ARTIST_MIN;
  });
}

// --- resolution ---------------------------------------------------

async function search(q: string): Promise<any[]> {
  const url = new URL("https://api.spotify.com/v1/search");
  url.searchParams.set("q", q);
  url.searchParams.set("type", "track");
  url.searchParams.set("limit", "10");   // 10 is the current max (Feb 2026)
  url.searchParams.set("market", MARKET);
  const res = await fetch(url, {
    headers: { authorization: `Bearer ${await accessToken()}` },
  });
  if (res.status === 429) return [];     // never retry; the song is optional
  if (!res.ok) throw new Error(`spotify search ${res.status}`);
  const j = await res.json();
  return j.tracks?.items ?? [];
}

/**
 * @param blocked track ids already used by this thread
 * @returns the song, or null. Never throws.
 */
export async function resolveSong(
  asked: { title: string; artist: string },
  blocked: Set<string>,
): Promise<Song | null> {
  if (!spotifyConfigured()) return null;
  const title = asked.title?.trim(), artist = asked.artist?.trim();
  if (!title || !artist) return null;

  try {
    // Field-filtered query first — much higher precision. Fall back to a
    // loose query, because the filtered form misses on punctuation and on
    // artists credited differently than the model remembers.
    let items = await search(`track:"${title}" artist:"${artist}"`);
    if (!items.length) items = await search(`${title} ${artist}`);

    for (const t of items) {
      if (!t?.id || blocked.has(t.id)) continue;
      if (!matches({ title, artist }, t)) continue;
      return {
        track_id: t.id,
        name: t.name,                                  // Spotify's spelling, not the model's
        artist: (t.artists ?? []).map((a: any) => a.name).join(", "),
        url: t.external_urls?.spotify ?? `https://open.spotify.com/track/${t.id}`,
        art: t.album?.images?.at(-1)?.url ?? null,     // smallest image; 64px is plenty
        asked: { title, artist },
      };
    }
    return null;
  } catch {
    return null;
  }
}
```

### 5.2 Tool schema — `DEVOTIONAL_TOOL`

Add alongside `cross_refs`, **optional**, not in `required`:

```ts
song: {
  type: "object",
  additionalProperties: false,
  required: ["title", "artist"],
  description:
    "OPTIONAL. One song that genuinely fits today's passage and posture. Omit if nothing real comes to mind — an omitted song costs nothing, a made-up one costs the reader's trust.",
  properties: {
    title:  { type: "string", description: "Exact song title as released" },
    artist: { type: "string", description: "Primary recording artist" },
  },
},
```

### 5.3 System prompt — guardrail 9

```
9. song is OPTIONAL and applies to AFFIRMING entries only — never include a
   song on a challenge entry. It is looked up on Spotify before the reader
   sees it, and a song that cannot be found, or whose artist you have
   misremembered, is silently discarded, so accuracy beats ambition. Name a
   song you are confident actually exists under that exact title by that
   exact artist. Hymns and older worship songs need a specific recording
   artist, not "Traditional". Stay within Christian worship, hymnody and
   contemporary Christian music — this is a devotional journal, not a general
   playlist. Do not default to whatever is most popular: the same handful of
   songs across every entry is a failure.
```

Three layers enforce the challenge-entry rule, cheapest first:

1. **Guardrail 9** above — the model shouldn't offer one.
2. **`buildUserPrompt`** already branches on `entryType`; on `challenge`, add
   an explicit `Do not include a song today.` line. Belt and braces, and it
   costs nothing because the function already has the value.
3. **`finalizeEntry`** — the hard guarantee (§5.5). Even if the model ignores
   both, no song is stored.

Deliberately *not* done: making the tool schema conditional on `entryType`.
That would mean threading the entry type through `callClaude()` and
`batchParams()`, and those signatures are shared by both generation paths.
Not worth the blast radius to save a handful of schema tokens.

### 5.4 `buildUserPrompt` — repeat avoidance

`buildContext` already assembles do-not-use verse lists. Add the song
equivalent: query the thread's last 30 non-null `song ->> 'name'` +
`'artist'` and append a block to the prompt:

```
SONGS ALREADY USED IN THIS THREAD (do not repeat):
- Be Still My Soul — Kari Jobe
- ...
```

This is the *real* fix for repetition. §5.5 is just the backstop.

### 5.5 `parsePayload` + `finalizeEntry`

`parsePayload` — shape only, mirroring `parseCrossRefs`:

```ts
function parseSong(x: unknown): { title: string; artist: string } | null {
  if (!x || typeof x !== "object") return null;
  const o = x as Record<string, unknown>;
  const title = String(o.title ?? "").trim();
  const artist = String(o.artist ?? "").trim();
  if (!title || !artist || title.length > 200 || artist.length > 200) return null;
  return { title, artist };
}
```

...added to the returned payload as `song`.

`finalizeEntry` — one block, immediately after the `crossRefs` block, wrapped
the same way so it can never fail an entry. **Both the synchronous and batch
paths go through `finalizeEntry`, so this is the single insertion point.**

```ts
// Song of the day — resolved against Spotify, never allowed to fail the entry.
// Affirming entries only: a challenge entry is meant to arrive quieter.
let song: Song | null = null;
try {
  if (p.song && entryType !== "challenge" && spotifyConfigured()) {
    const { data: used } = await db.from("daily_entries")
      .select("song")
      .eq("topic_id", topicId)
      .not("song", "is", null)
      .order("date", { ascending: false })
      .limit(200);
    const blocked = new Set<string>(
      (used ?? []).map((r: any) => r.song?.track_id).filter(Boolean),
    );
    song = await resolveSong(p.song, blocked);
    if (!song) {
      await db.from("generation_failures").insert({
        topic_id: topicId, user_id: userId, date, stage: "song_dropped",
        detail: { asked: p.song, model: modelUsed },
      });
    }
  }
} catch { /* a song is decoration; an entry without one is still an entry */ }
```

...then `song,` into the `daily_entries` insert, and
`song: song?.track_id ?? null` into the returned outcome for batch bookkeeping.

---

## 6. Client changes

### 6.1 `src/lib/types.ts`

```ts
export interface Song {
  track_id: string;
  name: string;
  artist: string;
  url: string;
  art?: string | null;
}
```

and on `DailyEntry`:

```ts
/** Verified Spotify track, or null. Absent on entries generated before this shipped. */
song?: Song | null;
```

`api.ts` selects `*` on `daily_entries` everywhere, so **no query changes.**

### 6.2 `EntryCard.tsx`

New section between Prayer and `<Footnotes>` — placement confirmed. It reads
as the closing gesture of the entry rather than competing with the verse for
attention, and `entry.song` is null on ~1 in 4 entries, so a slot up near the
hero would leave a visible hole on challenge days.

```tsx
{entry.song && <SongRow song={entry.song} />}
```

```tsx
function SongRow({ song }: { song: Song }) {
  return (
    <section className="mt-8">
      <h2 className="mb-3 text-xs font-bold uppercase tracking-[0.18em] text-muted">
        Something to listen to
      </h2>
      <a
        href={song.url}
        target="_blank"
        rel="noreferrer"
        className="flex items-center gap-3 rounded-xl border border-hairline bg-surface px-3 py-3"
      >
        {song.art && (
          <img
            src={song.art}
            alt=""
            className="h-12 w-12 shrink-0 rounded"  /* 4px radius — Spotify guideline */
          />
        )}
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[15px] font-medium">{song.name}</span>
          <span className="block truncate text-[13px] text-muted">{song.artist}</span>
        </span>
        <SpotifyLogo className="h-5 shrink-0" />
      </a>
    </section>
  );
}
```

`SpotifyLogo` = inline SVG, full logo (icon + wordmark), `#1DB954`, min 70px
wide. **Not** the icon alone — see §7.

**Link handling:** a plain `<a target="_blank">` is correct here. Capacitor 6
routes external `http(s)` navigations out to the system browser, which then
honours the `open.spotify.com` universal link and hands off to the Spotify app
if installed. Do **not** use `@capacitor/browser` — `SFSafariViewController`
does not reliably honour universal links, so the user gets the web player
inside an in-app sheet instead of their actual Spotify app. Verify on a real
device before shipping; this is the one behaviour that can only be tested
natively.

### 6.3 Footnote

Add to `Footnotes`, and renumber (the list is already manually numbered —
worth refactoring to a built array while you're in there):

> Song metadata and artwork from Spotify. Ponder is not affiliated with
> Spotify AB.

---

## 7. Compliance — read before building the UI

Spotify's [Design & Branding Guidelines](https://developer.spotify.com/documentation/design)
are mandatory, not advisory, and are what a review would check:

- **Full logo (icon + wordmark)**, minimum 70px wide. Icon-only is allowed
  only where space is "extremely limited". Never rotated, stretched, recoloured.
- **Link text must be one of** "PLAY ON SPOTIFY", "OPEN SPOTIFY", "LISTEN ON
  SPOTIFY", "GET SPOTIFY FREE". If the card uses a text label rather than the
  bare logo, it must use one of those exact phrases.
- **Metadata verbatim** — title, artist and artwork exactly as returned. This
  is why §5.1 stores `t.name` rather than the model's title.
- **Artwork:** 4px radius at this size. Never overlay text on it.
- Any use of Spotify metadata **must link back to Spotify**.

Terms risk, flagged plainly: Ponder is a paid subscription app. The
[Developer Terms](https://developer.spotify.com/terms) don't prohibit charging
for your app, but they do prohibit selling Spotify Content or data, and
extended-quota approval is discretionary. A single-user personal app never
leaves default quota and this is a non-issue; **at scale, the quota extension
application is a real gate that can be refused.** Don't build the marketing
around this feature.

---

## 8. What can actually go wrong

| Failure | Result | Mitigation |
|---|---|---|
| Model invents a song | No match → `song = NULL` | §5.1 match check; logged as `song_dropped` |
| Model names a real song, wrong artist | Artist fuzzy-match may still pass | Bounded by `ARTIST_MIN`; worst case a cover version, not a wrong song |
| Spotify 429 during batch collect | Songs missing for that night's entries | Search returns `[]`, entry still created |
| Secrets missing/rotated | Feature silently off | `spotifyConfigured()` gate |
| Owner's Spotify Premium lapses | Whole app's API access dies | Nothing to mitigate — Dev Mode requires it. Songs stop; entries keep generating |
| Dev-mode rate limit at scale | Songs missing across many users' entries | No path to extended quota (250k MAU gate). Accept, or drop the feature if the user base grows |
| Same 30 CCM songs forever | Feature becomes noise | §5.4 prompt block list — **this is the one that needs watching.** Narrowed to worship music by decision, so the pool is smaller and the risk is higher, not lower |
| Track pulled from Spotify later | Dead link on an old entry | Accepted. Not worth a re-validation job for a personal app. |
| `preview_url` | Null on apps registered after Nov 2024 | **Don't build on it.** Docs still list the field; it's dead for new apps. Link only — which also keeps you clear of playback-related terms. |

Extra cost: **zero** on the Spotify side (search is free, no per-call charge),
~40 output tokens per entry on the Anthropic side. Negligible against the
$4.52/yr batch figure.

---

## 9. Verification steps (in order)

1. Register Spotify app, set the two secrets in the dashboard.
2. Apply the migration via SQL Editor (Monaco `setValue` trick — see project
   memory), record it in `supabase_migrations.schema_migrations`.
3. Redeploy `generate-entry` via dashboard Code editor. **Re-check `verify_jwt`
   is OFF after deploy** — the editor defaults it ON and that breaks the
   pg_net/cron call.
4. Trigger on-demand generation ("Generate today's entry"). Confirm
   `select song from daily_entries order by created_at desc limit 5;` is
   populated and the URL opens the right track.
5. Check `select * from generation_failures where stage = 'song_dropped'` —
   a high drop rate means `TITLE_MIN` is too tight or the prompt is too vague.
6. Wait one nightly cycle, confirm the batch path also populates `song`.
   `select * from net._http_response order by created desc` first if it looks
   dead.
7. On-device: tap the card on iOS and Android, confirm it leaves the WebView
   and hands off to the Spotify app.

---

## 10. Decisions — closed 22 Aug 2026

| # | Decision | Outcome |
|---|---|---|
| 1 | Challenge entries | **No song.** Absence is the signal. Enforced at three layers (§5.3) |
| 2 | Placement | **After Prayer**, before the footnote (§6.2) |
| 3 | Apple Music | **No.** Spotify only. Apple's API needs an ES256-signed JWT and platform detection — revisit only if someone asks |
| 4 | Music scope | **Christian worship / hymnody / CCM only.** Now explicit in guardrail 9 rather than left to model default |

Nothing outstanding. Next step is implementation (§9), which needs the
Spotify app registered and the two secrets set (§4) before anything else can
be tested.
