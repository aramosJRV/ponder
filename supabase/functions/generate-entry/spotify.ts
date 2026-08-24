// ------------------------------------------------------------------
// Spotify track resolution.
//
// The model proposes a song by title + artist. This module proves the
// track exists and that what came back is actually the song asked for.
// It NEVER throws to the caller — a missing song is a normal outcome,
// and an entry without one is still a valid entry.
//
// Same rule as verse_text and cross_refs: model output never becomes
// a link the reader can tap. Only a Spotify API response does.
// ------------------------------------------------------------------

const CLIENT_ID = Deno.env.get("SPOTIFY_CLIENT_ID") ?? "";
const CLIENT_SECRET = Deno.env.get("SPOTIFY_CLIENT_SECRET") ?? "";
const MARKET = Deno.env.get("SPOTIFY_MARKET") ?? "AU";

/** False until both secrets are set — the whole feature no-ops silently. */
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
// collection run, which is the case that matters (a single invocation
// can finalize dozens of entries).
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
  // Refresh 5 minutes early rather than racing the expiry.
  token = {
    value: j.access_token,
    expiresAt: Date.now() + (j.expires_in - 300) * 1000,
  };
  return token.value;
}

// --- matching -----------------------------------------------------
//
// Spotify search is fuzzy and happily returns *something* for any query.
// Without a match check, a song the model invented comes back as an
// unrelated real track and we ship a confident wrong link — exactly the
// failure the bible_verses table exists to prevent.

const norm = (s: string) =>
  s.toLowerCase()
    .replace(/\(.*?\)|\[.*?\]/g, " ") // (Live), [Radio Edit]
    .replace(
      /\s-\s(live|acoustic|remix|radio edit|single version|remaster(ed)?)\b.*$/i,
      " ",
    )
    .replace(/\bfeat\.?\b.*$/i, " ")
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/** Sorensen-Dice on character bigrams. 1.0 = identical. */
function dice(a: string, b: string): number {
  if (a === b) return a.length ? 1 : 0;
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
  for (const [g, n] of A) {
    total += n;
    hits += Math.min(n, B.get(g) ?? 0);
  }
  for (const [, n] of B) total += n;
  return (2 * hits) / total;
}

const TITLE_MIN = 0.82;
const ARTIST_MIN = 0.75;

// deno-lint-ignore no-explicit-any
function matches(asked: { title: string; artist: string }, t: any): boolean {
  const at = norm(asked.title), aa = norm(asked.artist);
  if (!at || !aa) return false;
  if (dice(at, norm(t.name ?? "")) < TITLE_MIN) return false;
  // Any credited artist may satisfy the check. Collaborations and features
  // are routinely mis-attributed by the model, and getting the song right
  // matters more than getting the billing order right.
  // deno-lint-ignore no-explicit-any
  return (t.artists ?? []).some((x: any) => {
    const na = norm(x?.name ?? "");
    if (!na) return false;
    if (na === aa || na.includes(aa) || aa.includes(na)) return true;
    return dice(aa, na) >= ARTIST_MIN;
  });
}

// --- resolution ---------------------------------------------------

// deno-lint-ignore no-explicit-any
async function search(q: string): Promise<any[]> {
  const url = new URL("https://api.spotify.com/v1/search");
  url.searchParams.set("q", q);
  url.searchParams.set("type", "track");
  url.searchParams.set("limit", "10"); // 10 is the current max (Feb 2026)
  url.searchParams.set("market", MARKET);
  const res = await fetch(url, {
    headers: { authorization: `Bearer ${await accessToken()}` },
  });
  if (res.status === 429) return []; // never retry; the song is optional
  if (!res.ok) throw new Error(`spotify search ${res.status}`);
  const j = await res.json();
  return j.tracks?.items ?? [];
}

/**
 * Resolve a model-proposed song to a real Spotify track.
 *
 * @param asked   what the model suggested
 * @param blocked track ids this thread has already used
 * @returns the song, or null. Never throws.
 */
export async function resolveSong(
  asked: { title: string; artist: string },
  blocked: Set<string>,
): Promise<Song | null> {
  if (!spotifyConfigured()) return null;
  const title = asked?.title?.trim();
  const artist = asked?.artist?.trim();
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
        // Spotify's spelling, never the model's — branding rules require
        // metadata to be displayed exactly as returned.
        name: t.name,
        // deno-lint-ignore no-explicit-any
        artist: (t.artists ?? []).map((a: any) => a.name).join(", "),
        url: t.external_urls?.spotify ??
          `https://open.spotify.com/track/${t.id}`,
        art: t.album?.images?.at(-1)?.url ?? null, // smallest; 64px is plenty
        asked: { title, artist },
      };
    }
    return null;
  } catch {
    return null;
  }
}
