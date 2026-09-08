// generate-entry — creates DailyEntry rows for active topics.
//
// POST { topic_id?: string, force_date?: "YYYY-MM-DD" }
//   - topic_id present: generate for that topic only (on-demand path).
//   - topic_id absent: generate for ALL active topics missing today's entry (cron path).
//
// Auth (verify_jwt is OFF; we check explicitly):
//   - service key (legacy JWT or sb_secret_*) in Authorization → full access (cron/admin)
//   - user JWT in Authorization → only their own topics
//
// Verse text is NEVER taken from the model: the model returns a reference,
// we resolve it against bible_verses via resolve_verse_ref(); on failure we
// retry once with the error, then fall back to a curated list.
//
// The model may also cite up to 3 supporting passages (cross_refs) for the
// entry's footnote. Those go through the same resolve step but with no retry
// and no fallback: unresolvable citations are dropped and logged, and the
// entry is written without them. A missing citation is a cosmetic loss; a
// fabricated one is not.
//
// Affirming entries may also carry one song. The model proposes a title and
// artist only — never a URL or track id — and spotify.ts must find a real
// track whose name and artist actually match before anything is stored. Same
// rule as scripture: model output never becomes something the reader taps.
// Challenge entries never get a song, by design.

import { createClient, SupabaseClient } from "npm:@supabase/supabase-js@2";
import * as jose from "npm:jose@5";
import { resolveSong, type Song, spotifyConfigured } from "./spotify.ts";

// ---------------------------------------------------------------- config

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY =
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? Deno.env.get("SB_SECRET_KEY")!;
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? "";

// ------------------------------------------------------------ model routing
//
// Entry generation is the app's only recurring cost and it runs 365x per
// thread per year, so the model choice IS the unit economics.
//
//   Sonnet 4.6  $3 / $15 per Mtok  ≈ $0.0165 per entry  ≈ $6.02 / thread / year
//   Haiku 4.5   $1 /  $5 per Mtok  ≈ $0.0055 per entry  ≈ $2.01 / thread / year
//
// Challenge entries are the ones that have to be genuinely good — they
// question the user's framing of something they believe God is saying, which
// is the hardest thing this app does and the easiest to do badly. Those stay
// on Sonnet. Affirming entries (~75%) go to Haiku.
//
// If a Haiku attempt fails validation, the retry escalates to Sonnet rather
// than asking Haiku again: a model that just produced an unusable verse
// reference is not the model to ask for a correction.
const MODEL_CHALLENGE =
  Deno.env.get("ANTHROPIC_MODEL_CHALLENGE") ?? "claude-sonnet-4-6";
const MODEL_AFFIRMING =
  Deno.env.get("ANTHROPIC_MODEL_AFFIRMING") ?? "claude-haiku-4-5-20251001";

/** Set ANTHROPIC_MODEL to pin both paths to one model (e.g. to A/B quality). */
const MODEL_OVERRIDE = Deno.env.get("ANTHROPIC_MODEL");

function modelFor(entryType: string, attempt: number): string {
  if (MODEL_OVERRIDE) return MODEL_OVERRIDE;
  if (attempt > 1) return MODEL_CHALLENGE; // escalate on retry
  return entryType === "challenge" ? MODEL_CHALLENGE : MODEL_AFFIRMING;
}

// ---------------------------------------------------------------- spend
//
// Ponder is free, so the model bill is no longer bounded by what users pay.
// It is bounded here instead: every Anthropic call records what it actually
// cost, read from the response's `usage` block and never estimated, and
// public.generation_allowed() refuses to start new work once the month's
// ceiling is reached. See migration 20260823000002.
//
// USD per million tokens.
const PRICING: Record<string, { in: number; out: number }> = {
  "claude-sonnet-4-6": { in: 3, out: 15 },
  "claude-haiku-4-5-20251001": { in: 1, out: 5 },
};

// An unknown model is priced as the expensive one. Guessing low here would
// let a model swap quietly blow through the ceiling.
const FALLBACK_PRICE = { in: 3, out: 15 };

interface Usage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

/** Cache reads bill at 10% of input, cache writes at 125%. Batch is half. */
function usdCost(model: string, u: Usage, batch = false): number {
  const p = PRICING[model] ?? FALLBACK_PRICE;
  const cost =
    ((u.input_tokens ?? 0) * p.in +
      (u.cache_read_input_tokens ?? 0) * p.in * 0.1 +
      (u.cache_creation_input_tokens ?? 0) * p.in * 1.25 +
      (u.output_tokens ?? 0) * p.out) /
    1_000_000;
  return batch ? cost / 2 : cost;
}

/**
 * Write one ledger row. Best-effort by design: a failed ledger write must
 * never fail the generation that already happened and already cost money.
 * A missing row understates spend, which the reconciliation query catches;
 * a thrown error would lose the user their entry.
 */
async function recordSpend(
  db: SupabaseClient,
  kind: string,
  model: string,
  usage: Usage,
  opts: { batch?: boolean; userId?: string | null; detail?: Record<string, unknown> } = {},
): Promise<void> {
  try {
    await db.rpc("record_spend", {
      p_kind: kind,
      p_model: model,
      p_input_tokens: usage.input_tokens ?? 0,
      p_output_tokens: usage.output_tokens ?? 0,
      p_cache_read_tokens: usage.cache_read_input_tokens ?? 0,
      p_cache_write_tokens: usage.cache_creation_input_tokens ?? 0,
      p_usd_cost: usdCost(model, usage, opts.batch ?? false),
      p_user_id: opts.userId ?? null,
      p_detail: opts.detail ?? {},
    });
  } catch (e) {
    console.error(`record_spend failed (${kind}/${model}): ${e}`);
  }
}

/**
 * The runaway tripwire. CRON AND BATCH PATHS ONLY — never the user path.
 *
 * These thresholds are not a budget; they sit far above real usage, so a
 * false return means something in this file is misbehaving. Fails CLOSED on
 * RPC error: if we cannot tell what we have spent, we do not start a batch.
 * The pool covers the user-facing consequence either way.
 */
async function generationAllowed(db: SupabaseClient): Promise<boolean> {
  const { data, error } = await db.rpc("generation_allowed");
  if (error) {
    console.error(`generation_allowed check failed: ${error.message}`);
    return false;
  }
  return data === true;
}

// ----------------------------------------------------------------- pool
//
// The shared entry library (migration 20260823000003). Ponder is free and the
// user experience must not change because generation failed — and generation
// can fail for reasons no amount of credit fixes: an Anthropic outage, a rate
// limit, a bug in this file. The pool is what covers those.
//
// It is tried FIRST, not last, when a thread has a confident theme: a pooled
// entry costs nothing, was verse-validated at build time, and is
// indistinguishable to the reader from a freshly written one.

/** Cached for the lifetime of this function instance — themes change rarely. */
let THEME_CACHE: Array<{ id: string; slug: string; title: string; description: string }> | null = null;

async function loadThemes(db: SupabaseClient) {
  if (THEME_CACHE) return THEME_CACHE;
  const { data, error } = await db.from("entry_themes")
    .select("id, slug, title, description").eq("active", true).order("slug");
  if (error) { console.warn(`loadThemes: ${error.message}`); return []; }
  THEME_CACHE = data ?? [];
  return THEME_CACHE;
}

const CLASSIFY_TOOL = {
  name: "record_theme",
  description: "Record which theme best matches this thread.",
  input_schema: {
    type: "object",
    properties: {
      slug: { type: "string", description: "The slug of the best-matching theme, or the empty string if none fits well." },
      confidence: { type: "number", description: "0 to 1. How well the chosen theme actually covers this thread." },
    },
    required: ["slug", "confidence"],
  },
} as const;

/**
 * Give a thread a theme, once, so the pool can serve it.
 *
 * Runs lazily here rather than at thread creation on purpose: it is one place
 * instead of two, it needs no client change, and it self-heals — threads that
 * existed before the pool, or whose classification failed, get picked up on
 * their next generation.
 *
 * Being honest about a poor match matters more than assigning something. A
 * thread classified into a theme it doesn't really belong to gets pooled
 * entries that miss, which the user CAN feel; a thread left unclassified just
 * costs a few cents a month in per-user generation. The prompt is written to
 * push toward the empty string, and select_pool_entry() ignores anything
 * under pool_confidence_floor().
 */
// deno-lint-ignore no-explicit-any
async function ensureTheme(db: SupabaseClient, topic: any): Promise<void> {
  // The classification lives in topic_themes, not on the thread row — see
  // migration 20260825000001. A row with a null theme_id still counts as
  // "already tried": the classifier honestly matched nothing, and paying for
  // that same answer every night is the thing this guard exists to stop.
  const { data: existing, error: readErr } = await db
    .from("topic_themes")
    .select("classified_at")
    .eq("topic_id", topic.id)
    .maybeSingle();
  if (readErr) { console.warn(`ensureTheme read: ${readErr.message}`); return; }
  if (existing) return;   // already tried, don't pay twice

  const themes = await loadThemes(db);
  if (!themes.length) return;

  const list = themes.map((t) => `- ${t.slug}: ${t.title} — ${t.description}`).join("\n");
  const thread = `Title: ${topic.title}\nDescription: ${topic.description ?? "(none)"}`;

  let slug = "";
  let confidence = 0;
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: anthropicHeaders(),
      body: JSON.stringify({
        model: MODEL_AFFIRMING,   // cheapest model; this is a matching task
        max_tokens: 256,
        system:
          "You match a personal spiritual-discernment thread to one theme from a fixed list. " +
          "Answer with the slug of the theme whose description genuinely covers what this person is " +
          "sitting with. If no theme is a real match, return an empty slug — that is a correct and " +
          "expected answer, and far better than forcing a loose fit. Confidence should reflect how " +
          "well the theme covers the WHOLE thread, not just a keyword in it.",
        tools: [CLASSIFY_TOOL],
        tool_choice: { type: "tool", name: "record_theme" },
        messages: [{ role: "user", content: `Themes:\n${list}\n\nThread:\n${thread}` }],
      }),
    });
    if (!res.ok) throw new Error(`Anthropic API ${res.status}`);
    const data = await res.json();
    await recordSpend(db, "classify", MODEL_AFFIRMING, (data.usage ?? {}) as Usage, {
      userId: topic.user_id, detail: { topic_id: topic.id },
    });
    const block = (data.content ?? []).find((b: { type: string }) => b.type === "tool_use");
    slug = String(block?.input?.slug ?? "").trim();
    confidence = Number(block?.input?.confidence ?? 0);
  } catch (e) {
    console.warn(`ensureTheme failed for ${topic.id}: ${e}`);
    return;   // leave unclassified; it will retry next time
  }

  const match = themes.find((t) => t.slug === slug);
  // upsert, not insert: two generations racing the same unclassified thread
  // would otherwise leave the loser logging a duplicate-key warning for a
  // result that is already correct.
  const { error } = await db.from("topic_themes").upsert({
    topic_id: topic.id,
    theme_id: match?.id ?? null,
    confidence: match ? confidence : 0,
    classified_at: new Date().toISOString(),
  }, { onConflict: "topic_id" });
  if (error) { console.warn(`ensureTheme upsert: ${error.message}`); return; }

  // No in-memory write-back: nothing downstream reads the classification off
  // the thread object. tryPool() goes through select_pool_entry(), which
  // reads topic_themes itself.
}

/**
 * Serve today from the pool if it can. Returns true when a daily_entries row
 * now exists because of the pool.
 *
 * Best-effort throughout: any error here falls through to live generation
 * rather than failing the day.
 */
async function tryPool(
  db: SupabaseClient,
  topicId: string,
  date: string,
  entryType: string,
): Promise<boolean> {
  try {
    const { data: poolId, error } = await db.rpc("select_pool_entry", {
      p_topic_id: topicId,
      p_entry_type: entryType,
    });
    if (error) { console.warn(`select_pool_entry: ${error.message}`); return false; }
    if (!poolId) return false;   // no theme, low confidence, or pool exhausted

    const { data: newId, error: serveErr } = await db.rpc("serve_pool_entry", {
      p_topic_id: topicId,
      p_date: date,
      p_pool_id: poolId,
    });
    if (serveErr) { console.warn(`serve_pool_entry: ${serveErr.message}`); return false; }
    // null means the day was already filled by someone else — also a success
    // from the caller's point of view: the user has an entry.
    return newId !== null;
  } catch (e) {
    console.warn(`tryPool failed for ${topicId}: ${e}`);
    return false;
  }
}

// The topic's seed passage may be chosen again as a daily entry. Set this to a
// positive number of days to suppress it for a topic's opening stretch (avoids
// the "it just gave me back the verse I typed in" moment in week one).
// 0 = never suppressed.
const SEED_VERSE_COOLDOWN_DAYS = 0;

// No theme columns: the classification moved to the service-only
// topic_themes table in 20260825000001. ensureTheme() reads it there, and
// tryPool() goes through select_pool_entry(), which joins it server-side.
const TOPIC_COLS =
  "id, user_id, title, description, created_at, seed_verse_ref, seed_verse_text";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });

// ------------------------------------------------------- fallback verses
// Curated per-theme fallbacks (refs only — text still comes from the DB).

const FALLBACKS: Record<string, Array<[string, number, number, number]>> = {
  stillness: [["Psalms", 62, 1, 2], ["Isaiah", 30, 15, 15], ["Exodus", 14, 14, 14]],
  trust: [["Proverbs", 3, 5, 6], ["Psalms", 56, 3, 4], ["Isaiah", 26, 3, 4]],
  guidance: [["Psalms", 32, 8, 8], ["Isaiah", 30, 21, 21], ["James", 1, 5, 5]],
  comfort: [["Psalms", 34, 18, 18], ["Matthew", 11, 28, 30], ["2 Corinthians", 1, 3, 4]],
  hope: [["Romans", 15, 13, 13], ["Lamentations", 3, 22, 23], ["Jeremiah", 29, 11, 11]],
  obedience: [["John", 14, 15, 15], ["Micah", 6, 8, 8], ["Joshua", 1, 8, 9]],
  gratitude: [["1 Thessalonians", 5, 16, 18], ["Psalms", 100, 4, 5], ["Colossians", 3, 15, 17]],
  default: [["Psalms", 46, 10, 10], ["Psalms", 119, 105, 105], ["Philippians", 4, 6, 7]],
};

function fallbackTheme(topicText: string): string {
  const t = topicText.toLowerCase();
  for (const theme of Object.keys(FALLBACKS)) {
    if (theme !== "default" && t.includes(theme)) return theme;
  }
  if (/\b(rest|slow|quiet|still)\b/.test(t)) return "stillness";
  if (/\b(decide|decision|direction|call|calling)\b/.test(t)) return "guidance";
  if (/\b(grief|loss|pain|anxious|anxiety|fear)\b/.test(t)) return "comfort";
  if (/\b(thank|grateful)\b/.test(t)) return "gratitude";
  return "default";
}

// ------------------------------------------------------------ system prompt

const SYSTEM_PROMPT = `You write daily devotional entries for a personal discernment journal. The user tracks "threads" — things they sense God may be speaking to them about — and your entries are material for their reflection and discernment, never verdicts.

If you refer to what the user is tracking, call it a "thread", never a "topic".

Non-negotiable guardrails:
1. NEVER claim God is telling the user something, and never make predictive or directive claims about their life decisions ("God is saying...", "this means you should quit/stay/move" are all forbidden). Frame everything as invitation to reflect: "consider", "notice", "sit with".
2. Scripture must be handled in context. Do not proof-text: never use a verse fragment against the meaning of its surrounding passage. Choose passages whose actual context genuinely relates to the thread.
3. Illustrations must be either clearly framed as hypothetical/analogy ("imagine...", "a farmer who...") or verifiably true and commonly known. NEVER invent quotes, statistics, or historical anecdotes presented as fact. No invented named people.
4. Broadly orthodox, non-denominational Christian posture. Avoid partisan politics and denominationally contentious claims (e.g. modes of baptism, predestination debates) unless the thread explicitly invites them.
5. Challenge entries question the user's framing honestly but pastorally — hard questions, not harsh ones. Never mock, never shame.
6. Use the World English Bible naming: "Psalms" (not "Psalm") as the book name in references.
7. cross_refs is a citation list shown to the reader as a footnote, not a decoration. Include a passage there ONLY if it genuinely informed what you wrote — a passage that gave the main text its context, or one whose idea you actually used. An empty list is the correct answer most of the time. Never list a passage you have not thought about, never list one merely because it shares a keyword, and never list the main passage again. Every reference is checked against the World English Bible before the reader sees it, and anything that does not exist is silently discarded — so a half-remembered reference costs you the citation.
8. The passage text is shown to the reader verbatim (World English Bible) directly above your writing. Do NOT reproduce the passage as a full quotation in your thought or illustration — you will misremember the exact wording and contradict the text on screen (e.g. writing "the LORD" where the WEB reads "Yahweh", or adding words like "both"). Refer to the passage instead: describe what it says, and quote at most a short distinctive phrase of a few words. Never present a reconstructed full-verse quotation.
9. song is OPTIONAL and applies to AFFIRMING entries only — never include a song on a challenge entry. It is looked up on Spotify before the reader sees it, and a song that cannot be found, or whose artist you have misremembered, is silently discarded, so accuracy beats ambition. Name a song you are confident actually exists under that exact title by that exact artist. Hymns and older worship songs need a specific recording artist, not "Traditional". Stay within Christian worship, hymnody and contemporary Christian music — this is a devotional journal, not a general playlist. Do not default to whatever is most popular: the same handful of songs across every entry is a failure.
10. NEVER state or imply how long the person has been on this thread, or how long anything in their life has been going on. No counts ("day 40", "after three months", "a year of this"), no vague duration framing ("a while now", "lately", "all this time", "in these early days", "as the weeks have worn on", "you have been carrying this since..."), and no anniversary or season-of-the-journey language. This applies to every field you write — thought, illustration, ponder and prayer_prompts. Any dates you are shown below are for ordering only; they are not a timeline you may describe, and they do not tell you when the thread began or how long the person has sat with it. You do not know the reader's elapsed time, and guessing it is wrong far more often than it is right — it reads as a stranger pretending to know them. Write to today: this passage, this thread, what is in front of them now.

You will be told whether to write an "affirming" or a "challenge" entry:
- affirming: sits inside the user's sense of the thread and deepens it.
- challenge: gently questions their framing, offers a scriptural counterpoint, or asks what they might be avoiding. It should still end in hope.

Verse selection: choose ONE passage (1-3 consecutive verses) from the provided do-not-use lists' complement — i.e. any passage NOT in those lists. Prefer variety across the whole canon over famous verses.

If the thread includes an ORIGIN PASSAGE, treat it as background only: it tells you where the person started, not where they must stay. Do not orbit it. Most entries should make no mention of it at all, and today's passage should come from elsewhere in scripture unless there is a real reason to return. On a challenge entry, the origin passage is fair game to examine: ask whether it is being read in its own context, or whether the person has attached a meaning to it that the surrounding passage does not carry. Do this pastorally — you are not correcting them, you are helping them look again.`;

// ------------------------------------------------------------ claude tool

const DEVOTIONAL_TOOL = {
  name: "record_devotional",
  description: "Record the completed devotional entry in structured form.",
  input_schema: {
    type: "object",
    additionalProperties: false,
    required: ["verse", "thought", "illustration", "ponder", "prayer_prompts"],
    properties: {
      verse: {
        type: "object",
        additionalProperties: false,
        required: ["book", "chapter", "verse_start", "verse_end"],
        properties: {
          book: { type: "string", description: "WEB book name, e.g. 'Psalms', '1 Corinthians'" },
          chapter: { type: "integer", minimum: 1 },
          verse_start: { type: "integer", minimum: 1 },
          verse_end: { type: "integer", minimum: 1, description: ">= verse_start, span of 1-3 verses" },
        },
      },
      thought: { type: "string", description: "80-150 word reflection on the passage and thread" },
      illustration: { type: "string", description: "100-180 word story/analogy/image, clearly illustrative" },
      ponder: {
        type: "array", minItems: 2, maxItems: 3,
        items: { type: "string" },
        description: "2-3 questions to sit with",
      },
      prayer_prompts: {
        type: "array", minItems: 2, maxItems: 3,
        items: { type: "string" },
        description: "2-3 short prayer directions",
      },
      cross_refs: {
        type: "array", minItems: 0, maxItems: 3,
        description:
          "OPTIONAL. Other passages you actually leaned on while writing — the ones that shaped the thought or gave the main passage its context. Omit or leave empty if there were none; do not pad this list.",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["book", "chapter", "verse_start", "verse_end"],
          properties: {
            book: { type: "string", description: "WEB book name, e.g. 'Psalms', '1 Corinthians'" },
            chapter: { type: "integer", minimum: 1 },
            verse_start: { type: "integer", minimum: 1 },
            verse_end: { type: "integer", minimum: 1, description: ">= verse_start, span of 1-3 verses" },
          },
        },
      },
      song: {
        type: "object",
        additionalProperties: false,
        required: ["title", "artist"],
        description:
          "OPTIONAL, affirming entries only. One worship song, hymn or CCM track that genuinely fits today's passage and posture. Omit entirely on challenge entries, and omit whenever nothing real comes to mind — an omitted song costs nothing, an invented one costs the reader's trust.",
        properties: {
          title: { type: "string", description: "Exact song title as released" },
          artist: { type: "string", description: "Primary recording artist of a real recording" },
        },
      },
    },
  },
};

// ---------------------------------------------------------------- helpers

type VerseRow = {
  book_number: number; book: string; chapter: number; verse: number; text: string;
};

async function resolveVerse(
  db: SupabaseClient, book: string, chapter: number, start: number, end: number,
): Promise<VerseRow[] | null> {
  const { data, error } = await db.rpc("resolve_verse_ref", {
    p_book: book, p_chapter: chapter, p_verse_start: start, p_verse_end: end,
  });
  if (error) throw new Error(`resolve_verse_ref failed: ${error.message}`);
  if (!data?.length) return null;
  // require the full span to exist (e.g. verse_end beyond chapter end -> partial)
  if (data.length !== end - start + 1) return null;
  return data as VerseRow[];
}

function localDate(tz: string): string {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(new Date());
  } catch {
    return new Intl.DateTimeFormat("en-CA", { timeZone: "UTC" }).format(new Date());
  }
}

function displayRef(book: string, chapter: number, start: number, end: number) {
  const b = book === "Psalms" ? "Psalm" : book; // display convention
  return start === end ? `${b} ${chapter}:${start}` : `${b} ${chapter}:${start}-${end}`;
}

/** 429 and 5xx are transient. 400/401/403 are our bug and retrying wastes money. */
function isTransient(status: number): boolean {
  return status === 429 || status === 408 || status >= 500;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * One Anthropic call, with backoff on transient failures.
 *
 * Three attempts at 1s / 4s. Ponder's users are not sitting watching a
 * spinner for most of these — the nightly path has hours of slack — and an
 * outage or a rate limit is exactly the case where the pool is the safety
 * net rather than the retry. Retrying harder than this just moves a failure
 * later; the fallback chain is what actually protects the user.
 */
async function callClaude(
  messages: unknown[],
  model: string,
  ledger?: { db: SupabaseClient; kind: string; userId?: string | null; detail?: Record<string, unknown> },
): Promise<Record<string, unknown>> {
  let lastErr = "";
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return await callClaudeOnce(messages, model, ledger);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      lastErr = msg;
      const status = Number(/Anthropic API (\d{3})/.exec(msg)?.[1] ?? 0);
      // A non-transient status, or the last attempt: give up now.
      if (attempt === 3 || (status && !isTransient(status))) throw e;
      console.warn(`callClaude attempt ${attempt} failed (${msg}) — retrying`);
      await sleep(attempt === 1 ? 1000 : 4000);
    }
  }
  throw new Error(lastErr || "callClaude exhausted retries");
}

async function callClaudeOnce(
  messages: unknown[],
  model: string,
  ledger?: { db: SupabaseClient; kind: string; userId?: string | null; detail?: Record<string, unknown> },
): Promise<Record<string, unknown>> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      max_tokens: 2048,
      // The system prompt is identical for every entry, so it is cached.
      // Cache reads are 90% cheaper, and the nightly cron generates for many
      // threads in quick succession — well inside the 5-minute cache window.
      //
      // Caveat worth knowing: caching has a minimum cacheable prefix (1024
      // tokens for Sonnet, 2048 for Haiku). This system prompt clears the
      // Sonnet threshold but not the Haiku one, so today the saving lands on
      // challenge entries only and the marker is simply ignored on Haiku
      // calls. It costs nothing to leave in place and starts paying off if
      // the prompt grows.
      system: [
        {
          type: "text",
          text: SYSTEM_PROMPT,
          cache_control: { type: "ephemeral" },
        },
      ],
      tools: [DEVOTIONAL_TOOL],
      tool_choice: { type: "tool", name: "record_devotional" },
      messages,
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Anthropic API ${res.status}: ${body.slice(0, 500)}`);
  }
  const data = await res.json();
  // Record before validating the payload: the tokens were spent either way,
  // and a run of unusable responses is exactly what the ledger should show.
  if (ledger) {
    await recordSpend(ledger.db, ledger.kind, model, (data.usage ?? {}) as Usage, {
      userId: ledger.userId,
      detail: ledger.detail,
    });
  }
  const toolUse = (data.content ?? []).find((b: { type: string }) => b.type === "tool_use");
  if (!toolUse?.input) throw new Error("No tool_use block in model response");
  return toolUse.input as Record<string, unknown>;
}

// Minimum lengths, in CHARACTERS not words. The tool schema asks for an
// 80-150 word thought and a 100-180 word illustration, which is roughly
// 450-900 and 550-1100 characters — so these floors only catch a model that
// returned something drastically short, not one that ran a little under.
const MIN_THOUGHT_CHARS = 100;
const MIN_ILLUSTRATION_CHARS = 100;

// defensive extraction of the model payload
function parsePayload(raw: Record<string, unknown>) {
  const v = raw.verse as Record<string, unknown> | undefined;
  const book = String(v?.book ?? "").trim();
  const chapter = Number(v?.chapter);
  const verse_start = Number(v?.verse_start);
  let verse_end = Number(v?.verse_end);
  if (!Number.isInteger(verse_end) || verse_end < verse_start) verse_end = verse_start;
  if (verse_end - verse_start > 2) verse_end = verse_start + 2;

  const strArr = (x: unknown, min: number, max: number): string[] | null => {
    // A bare string where an array was asked for is the same trade as the
    // 1-item array below: the schema says array, the model occasionally sends
    // one question as a string (observed 8 Sep 2026, alongside a stray "item"
    // key), and throwing the entry away costs a paid generation and somebody's
    // day to gain nothing. One good question is a fine day.
    if (typeof x === "string") x = [x];
    if (!Array.isArray(x)) return null;
    const arr = x.map((s) => String(s).trim()).filter(Boolean).slice(0, max);
    return arr.length >= min ? arr : null;
  };

  const thought = String(raw.thought ?? "").trim();
  const illustration = String(raw.illustration ?? "").trim();
  // Tolerance, not target. The tool schema still asks for minItems: 2, and
  // almost every response obliges — but when a model returns one question
  // instead of two, throwing the whole entry away is the wrong trade. It
  // costs another paid generation, and a reflection with one good question
  // is a fine day; no entry at all is not.
  //
  // Measured 2026-08-23 against production: successful entries run 626-755
  // chars of thought and 464-682 of illustration, with 2-3 ponder items. The
  // ~40% that failed had normal output-token counts (506-638 against a 2048
  // cap), so they were NOT truncated and NOT empty — the most likely cause
  // left is an array arriving with a single item. This absorbs that.
  const ponder = strArr(raw.ponder, 1, 3);
  const prayer_prompts = strArr(raw.prayer_prompts, 1, 3);

  if (!book || !Number.isInteger(chapter) || !Number.isInteger(verse_start)) {
    throw new Error(
      `Malformed verse reference in model output (book=${JSON.stringify(book)} ` +
      `chapter=${v?.chapter} verse_start=${v?.verse_start})`,
    );
  }
  // Name the field and the measurement. This check previously threw one
  // identical message for four different causes, which made a sustained ~40%
  // failure rate impossible to diagnose from generation_failures alone.
  const contentProblems: string[] = [];
  if (thought.length < MIN_THOUGHT_CHARS) {
    contentProblems.push(`thought ${thought.length} chars (min ${MIN_THOUGHT_CHARS})`);
  }
  if (illustration.length < MIN_ILLUSTRATION_CHARS) {
    contentProblems.push(`illustration ${illustration.length} chars (min ${MIN_ILLUSTRATION_CHARS})`);
  }
  if (!ponder) {
    contentProblems.push(
      `ponder ${Array.isArray(raw.ponder) ? `${(raw.ponder as unknown[]).length} items` : typeof raw.ponder}`,
    );
  }
  if (!prayer_prompts) {
    contentProblems.push(
      `prayer_prompts ${Array.isArray(raw.prayer_prompts) ? `${(raw.prayer_prompts as unknown[]).length} items` : typeof raw.prayer_prompts}`,
    );
  }
  if (contentProblems.length) {
    // Carry the shape of what actually arrived. Without this the next
    // occurrence is as undiagnosable as the last one was.
    const shape = Object.keys(raw)
      .map((k) => `${k}:${Array.isArray(raw[k]) ? `[${(raw[k] as unknown[]).length}]` : typeof raw[k]}`)
      .join(",");
    throw new Error(
      `Malformed content fields in model output: ${contentProblems.join("; ")} | shape ${shape}`,
    );
  }
  const cross_refs = parseCrossRefs(raw.cross_refs);
  const song = parseSong(raw.song);
  return { book, chapter, verse_start, verse_end, thought, illustration, ponder, prayer_prompts, cross_refs, song };
}

/**
 * The verse-anchored opening question — written in a SECOND pass, after the
 * passage has been resolved out of bible_verses.
 *
 * Why a second call rather than another field on the main tool: in the main
 * call the model CHOOSES a reference and the server looks the text up
 * afterwards, so the passage is never in front of it. Asking it there for a
 * verbatim phrase means asking it to quote scripture from memory, and
 * measured on 8 Sep 2026 that failed 3 times out of 3 — "knows what you
 * need" for the WEB's "knows that you need", "the laborer\u2019s appetite" for
 * "the appetite of the laboring man". Worse than a dropped highlight: the
 * misquote sat inside the question body, which is precisely what guardrail 8
 * exists to prevent. Here the real text is supplied, so quoting is copying.
 *
 * Cost is bounded and does not scale with readers: entries are built into the
 * shared pool, so this is roughly one short call per pool entry, not one per
 * user per day.
 *
 * Every failure path returns null and the entry ships without an anchored
 * question — the client falls back to ponder[0]. An opening question is worth
 * a small call; it is not worth losing the day's entry over.
 */
const VERSE_QUESTION_TOOL = {
  name: "record_verse_question",
  description: "Record the opening question, anchored in a phrase of the passage.",
  input_schema: {
    type: "object",
    additionalProperties: false,
    required: ["phrase", "question"],
    properties: {
      phrase: {
        type: "string",
        description:
          "Two to five words COPIED CHARACTER FOR CHARACTER from the passage text given to you. Not a paraphrase, not modernised, no ellipsis.",
      },
      question: {
        type: "string",
        description:
          "One question that turns on those exact words. It must be meaningless if the phrase were removed.",
      },
    },
  },
};

const VERSE_QUESTION_SYSTEM =
  "You write the opening question of a daily devotional entry. The reader is tracking a thread — " +
  "something they sense God may be speaking to them about — and this question is the first thing " +
  "they are asked to sit with.\n\n" +
  "You are given the passage text. Choose a short phrase from it — two to five words — and copy it " +
  "CHARACTER FOR CHARACTER, exactly as it appears above, including its spelling and punctuation. Do " +
  "not modernise it, do not paraphrase it, do not tidy it. Then write one question that turns on " +
  "those specific words.\n\n" +
  "Good shapes: what stands out in this phrase today; what one word in it means to them now as " +
  "opposed to the last time they met it; which part of it they are least sure they understand; " +
  "which part they would rather skip past. A question that would work equally well against any " +
  "passage is the wrong question.\n\n" +
  "Never tell the reader what God is saying to them, and never make a directive claim about their " +
  "life. Invite: consider, notice, sit with. Never state or imply how long they have been on this " +
  "thread. Quote nothing beyond the phrase itself.";

async function writeVerseQuestion(
  db: SupabaseClient,
  verseRef: string,
  verseText: string,
  entryType: string,
  model: string,
  ledgerDetail: Record<string, unknown>,
): Promise<{ question: string; phrase?: string } | null> {
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: anthropicHeaders(),
      body: JSON.stringify({
        model,
        max_tokens: 400,
        system: VERSE_QUESTION_SYSTEM,
        tools: [VERSE_QUESTION_TOOL],
        tool_choice: { type: "tool", name: "record_verse_question" },
        messages: [{
          role: "user",
          content:
            `PASSAGE (${verseRef}, World English Bible):\n"${verseText}"\n\n` +
            `POSTURE: ${entryType}\n\n` +
            "Choose your phrase from the passage above and write the question.",
        }],
      }),
    });
    if (!res.ok) throw new Error(`Anthropic API ${res.status}`);
    const data = await res.json();
    await recordSpend(db, "verse_question", model, (data.usage ?? {}) as Usage, {
      detail: ledgerDetail,
    });
    const toolUse = (data.content ?? []).find((b: { type: string }) => b.type === "tool_use");
    const out = toolUse?.input as Record<string, unknown> | undefined;
    const question = String(out?.question ?? "").trim();
    if (!question) return null;
    return anchorVerseQuestion(
      { question, phrase: String(out?.phrase ?? "").trim() },
      verseText,
    );
  } catch (e) {
    console.warn(`writeVerseQuestion: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

/**
 * Bind the question to scripture, or drop the binding.
 *
 * Even with the text in front of it a model can still straighten an
 * apostrophe, so a normalised second pass follows the exact match. When the
 * exact match lands, the phrase is stored AS SCRIPTURE SPELLS IT — sliced out
 * of verseText, not as the model retyped it — because the client highlights
 * by a plain indexOf against whichever translation is on screen.
 *
 * A phrase that fails both passes leaves the QUESTION standing: it loses the
 * pull-quote and the highlight, which is cosmetic, not wrong.
 */
function anchorVerseQuestion(
  vq: { question: string; phrase: string },
  verseText: string,
): { question: string; phrase?: string } {
  const norm = (t: string) =>
    t.toLowerCase()
      .replace(/[\u2018\u2019\u02bc]/g, "'")
      .replace(/[\u201c\u201d]/g, '"')
      .replace(/[\u2013\u2014]/g, "-")
      .replace(/\s+/g, " ")
      .trim();
  const phrase = vq.phrase.replace(/^["'\u201c\u2018]+|["'\u201d\u2019.,;:]+$/g, "").trim();
  if (!phrase) return { question: vq.question };

  const at = verseText.toLowerCase().indexOf(phrase.toLowerCase());
  if (at >= 0) {
    return { question: vq.question, phrase: verseText.slice(at, at + phrase.length) };
  }
  if (norm(verseText).includes(norm(phrase))) {
    return { question: vq.question, phrase };
  }
  return { question: vq.question };
}

// Shape-only pass, same posture as parseCrossRefs. A bad song must never
// fail the entry — it is dropped later if Spotify can't confirm it.
function parseSong(x: unknown): { title: string; artist: string } | null {
  if (!x || typeof x !== "object" || Array.isArray(x)) return null;
  const o = x as Record<string, unknown>;
  const title = String(o.title ?? "").trim();
  const artist = String(o.artist ?? "").trim();
  if (!title || !artist) return null;
  if (title.length > 200 || artist.length > 200) return null;
  return { title, artist };
}

type CrossRefInput = { book: string; chapter: number; verse_start: number; verse_end: number };

// Shape-only pass. A bad cross-ref must never fail the entry — it is
// dropped later if it doesn't resolve, so this only discards garbage.
function parseCrossRefs(x: unknown): CrossRefInput[] {
  if (!Array.isArray(x)) return [];
  const out: CrossRefInput[] = [];
  for (const item of x.slice(0, 3)) {
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    const book = String(r.book ?? "").trim();
    const chapter = Number(r.chapter);
    const verse_start = Number(r.verse_start);
    let verse_end = Number(r.verse_end);
    if (!book || !Number.isInteger(chapter) || !Number.isInteger(verse_start)) continue;
    if (chapter < 1 || verse_start < 1) continue;
    if (!Number.isInteger(verse_end) || verse_end < verse_start) verse_end = verse_start;
    if (verse_end - verse_start > 2) verse_end = verse_start + 2;
    out.push({ book, chapter, verse_start, verse_end });
  }
  return out;
}

type CrossRef = CrossRefInput & { ref: string };

// Resolve each cited reference against the WEB table. Anything that
// doesn't resolve — or duplicates the entry's own passage — is dropped
// silently and logged. No retry: a bad citation isn't worth a second
// model call, and the entry is still complete without it.
async function validateCrossRefs(
  db: SupabaseClient,
  candidates: CrossRefInput[],
  mainRef: string,
  ctx: { topicId: string; userId: string; date: string; model: string },
): Promise<CrossRef[]> {
  const kept: CrossRef[] = [];
  const dropped: Array<{ ref: string; reason: string }> = [];
  const seen = new Set<string>([mainRef]);

  for (const c of candidates) {
    const ref = displayRef(c.book, c.chapter, c.verse_start, c.verse_end);
    if (seen.has(ref)) {
      dropped.push({ ref, reason: ref === mainRef ? "duplicates main passage" : "duplicate" });
      continue;
    }
    seen.add(ref);
    try {
      const rows = await resolveVerse(db, c.book, c.chapter, c.verse_start, c.verse_end);
      if (!rows) {
        dropped.push({ ref, reason: "does not resolve in the World English Bible" });
        continue;
      }
      kept.push({ ...c, ref });
    } catch (e) {
      dropped.push({ ref, reason: e instanceof Error ? e.message : String(e) });
    }
  }

  if (dropped.length) {
    await db.from("generation_failures").insert({
      topic_id: ctx.topicId, user_id: ctx.userId, date: ctx.date,
      stage: "cross_ref_dropped",
      detail: { dropped, kept: kept.map((k) => k.ref), model: ctx.model },
    });
  }
  return kept;
}

// --------------------------------------------------------- prompt builder

// deno-lint-ignore no-explicit-any
function buildUserPrompt(topic: any, recent: any[], usedRefs: string[], notes: any[], entryType: string, blockedRecent: string[], usedSongs: string[]) {
  const recentBlock = recent.length
    ? recent.map((e) =>
        `- ${e.date} [${e.entry_type}] ${e.verse_ref}: ${String(e.thought).slice(0, 160)}...`,
      ).join("\n")
    : "(none yet — this is the first entry)";
  const notesBlock = notes.length
    ? notes.map((n) => `- ${n.created_at.slice(0, 10)}: ${String(n.body).slice(0, 300)}`).join("\n")
    : "(no notes yet)";

  const originBlock = topic.seed_verse_ref
    ? `ORIGIN PASSAGE (what prompted this thread — background, not today's text):
${topic.seed_verse_ref} — "${String(topic.seed_verse_text ?? "").slice(0, 600)}"
Do not build today's entry around this passage. Use it only to understand where the person started.`
    : "ORIGIN PASSAGE: (none given)";

  // The prompt-side repeat guard. The server-side track-id block in
  // finalizeEntry is only a backstop — this is what actually keeps the
  // songs varied, and it matters more now that the brief is worship-only.
  const songBlock = entryType === "challenge"
    ? `SONG: do not include a song today. Challenge entries carry no song.`
    : `SONGS ALREADY USED IN THIS THREAD (do not repeat any of these):
${usedSongs.length ? usedSongs.map((t) => `- ${t}`).join("\n") : "(none yet)"}`;

  return `THREAD: ${topic.title}
USER'S OWN WORDS ABOUT IT: ${topic.description || "(none provided)"}

${originBlock}

ENTRY TYPE FOR TODAY: ${entryType}

LAST ENTRIES (for continuity — do not repeat their angle or verses. The dates order these lines and nothing more: they do not tell you when this thread began or how long it has run, and must never be turned into a statement about elapsed time):
${recentBlock}

DO NOT USE any of these verse references (already used in this thread):
${usedRefs.length ? usedRefs.join("; ") : "(none)"}

ALSO AVOID these references (used recently across the user's other threads):
${blockedRecent.length ? blockedRecent.join("; ") : "(none)"}

${songBlock}

RECENT USER NOTES (their own reflections — weave awareness of these in gently, without quoting them back verbatim. Dates order these lines only; do not date, count or measure anything back to them):
${notesBlock}

Write today's ${entryType} entry now, for today alone — say nothing about how long they have been on this thread (see guardrail 10). Choose the passage first, ensuring its full context genuinely supports your use of it, then write the entry around it. Call record_devotional exactly once.`;
}

// ------------------------------------------------------------- generation
//
// Generation is split into three reusable pieces so the synchronous
// on-demand path and the asynchronous batch path cannot drift apart:
//
//   buildContext()   gather history, pick the entry type, build the prompt
//   finalizeEntry()  validate the model's verse reference and insert the row
//   generateForTopic() = buildContext + call Claude + finalizeEntry
//
// The batch path calls buildContext() at submit time and finalizeEntry() at
// collect time, hours apart and in a different invocation. Everything that
// must survive that gap is written to generation_batch_items.

interface EntryContext {
  topicId: string;
  userId: string;
  date: string;
  entryType: string;
  /** Initial messages array — the batch path sends this verbatim. */
  messages: unknown[];
  /** Verse references the model must not choose. */
  blocked: string[];
}

/** Gather everything needed to ask for one entry. Null when it already exists. */
// deno-lint-ignore no-explicit-any
async function buildContext(
  db: SupabaseClient,
  topic: any,
  forceDate?: string,
): Promise<EntryContext | null> {
  const topicId = topic.id as string;
  const userId = topic.user_id as string;

  const { data: profile } = await db.from("profiles")
    .select("timezone, challenge_frequency").eq("id", userId).single();
  const tz = profile?.timezone ?? "UTC";
  const date = forceDate ?? localDate(tz);

  // already generated?
  const { data: existing } = await db.from("daily_entries")
    .select("id").eq("topic_id", topicId).eq("date", date).maybeSingle();
  if (existing) return null;

  // context: last 7 entries, all used refs (topic), notes (5), recent cross-topic refs (60d)
  const { data: recent } = await db.from("daily_entries")
    .select("date, verse_ref, thought, entry_type")
    .eq("topic_id", topicId).order("date", { ascending: false }).limit(7);

  const { data: allTopicEntries } = await db.from("daily_entries")
    .select("verse_ref").eq("topic_id", topicId);
  const usedRefs = (allTopicEntries ?? []).map((e) => e.verse_ref as string);

  const cutoff = new Date(Date.now() - 60 * 86400_000).toISOString().slice(0, 10);
  const { data: crossTopic } = await db.from("daily_entries")
    .select("verse_ref").eq("user_id", userId).neq("topic_id", topicId).gte("date", cutoff);
  const blockedRecent = [...new Set((crossTopic ?? []).map((e) => e.verse_ref as string))];

  // Songs this thread has already used, for the prompt-side do-not-repeat
  // list. Newest first, capped — the model does not need the full history.
  const { data: songRows } = await db.from("daily_entries")
    .select("song").eq("topic_id", topicId).not("song", "is", null)
    .order("date", { ascending: false }).limit(40);
  const usedSongs = (songRows ?? [])
    // deno-lint-ignore no-explicit-any
    .map((r: any) => r.song?.name && r.song?.artist ? `${r.song.name} — ${r.song.artist}` : null)
    .filter(Boolean) as string[];

  const { data: notes } = await db.from("notes")
    .select("body, created_at").eq("topic_id", topicId)
    .order("created_at", { ascending: false }).limit(5);

  // entry type: weighted random, never two challenges in a row
  const challengeFreq = Number(profile?.challenge_frequency ?? 0.25);
  const lastType = recent?.[0]?.entry_type;
  const entryType =
    lastType !== "challenge" && Math.random() < challengeFreq ? "challenge" : "affirming";

  // the seed passage is allowed to resurface as a daily entry; optionally
  // suppress it for the topic's opening stretch (see SEED_VERSE_COOLDOWN_DAYS)
  const seedRef = topic.seed_verse_ref as string | null;
  const topicAgeDays = topic.created_at
    ? Math.floor((Date.now() - new Date(topic.created_at).getTime()) / 86400_000)
    : Number.MAX_SAFE_INTEGER;
  const seedBlocked =
    Boolean(seedRef) && topicAgeDays < SEED_VERSE_COOLDOWN_DAYS;
  const blockedForPrompt = seedBlocked
    ? [...blockedRecent, seedRef as string]
    : blockedRecent;

  const userPrompt = buildUserPrompt(topic, recent ?? [], usedRefs, notes ?? [], entryType, blockedForPrompt, usedSongs);

  return {
    topicId,
    userId,
    date,
    entryType,
    messages: [{ role: "user", content: userPrompt }],
    blocked: [...new Set([...usedRefs, ...blockedForPrompt])],
  };
}

/**
 * Validate a model payload and write the entry.
 *
 * Shared by both paths, so the guarantee that verse text always comes from
 * the WEB table — never from the model — holds identically whether the entry
 * was generated synchronously or in a batch.
 */
async function finalizeEntry(
  db: SupabaseClient,
  // deno-lint-ignore no-explicit-any
  topic: any,
  ctx: EntryContext,
  payloadIn: ReturnType<typeof parsePayload>,
  modelUsed: string,
) {
  const { topicId, userId, date, entryType } = ctx;
  const isUsed = (ref: string) => ctx.blocked.includes(ref);

  let payload = payloadIn;
  let fallbackUsed = false;
  let verses: VerseRow[] | null = null;

  const ref = displayRef(payload.book, payload.chapter, payload.verse_start, payload.verse_end);
  if (!isUsed(ref)) {
    verses = await resolveVerse(
      db, payload.book, payload.chapter, payload.verse_start, payload.verse_end,
    );
  }

  // fallback: curated list, keep the model's writing if we have it
  if (!verses) {
    const theme = fallbackTheme(`${topic.title} ${topic.description ?? ""}`);
    for (const [book, ch, s, e] of [...FALLBACKS[theme], ...FALLBACKS.default]) {
      const fbRef = displayRef(book, ch, s, e);
      if (isUsed(fbRef)) continue;
      verses = await resolveVerse(db, book, ch, s, e);
      if (verses) {
        payload = { ...payload, book, chapter: ch, verse_start: s, verse_end: e };
        fallbackUsed = true;
        await db.from("generation_failures").insert({
          topic_id: topicId, user_id: userId, date, stage: "fallback_used",
          detail: { fallback_ref: fbRef, theme, model: modelUsed },
        });
        break;
      }
    }
    if (!verses) {
      return { topic_id: topicId, status: "failed", date, error: "no usable fallback verse" };
    }
  }

  const p = payload;
  const verseText = verses.map((v) => v.text).join(" ");
  const mainRef = displayRef(p.book, p.chapter, p.verse_start, p.verse_end);

  // Footnote citations — validated separately, never allowed to fail the entry.
  let crossRefs: CrossRef[] = [];
  try {
    crossRefs = await validateCrossRefs(db, p.cross_refs, mainRef, {
      topicId, userId, date, model: modelUsed,
    });
  } catch { /* citations are optional; an entry without them is still valid */ }

  // Song of the day — affirming entries only, resolved against Spotify,
  // never allowed to fail the entry. A challenge entry is meant to arrive
  // quieter; the absence is the signal, not an omission.
  let song: Song | null = null;
  try {
    if (p.song && entryType !== "challenge" && spotifyConfigured()) {
      const { data: used } = await db.from("daily_entries")
        .select("song").eq("topic_id", topicId).not("song", "is", null)
        .order("date", { ascending: false }).limit(200);
      const blockedTracks = new Set<string>(
        // deno-lint-ignore no-explicit-any
        (used ?? []).map((r: any) => r.song?.track_id).filter(Boolean),
      );
      song = await resolveSong(p.song, blockedTracks);
      if (!song) {
        await db.from("generation_failures").insert({
          topic_id: topicId, user_id: userId, date, stage: "song_dropped",
          detail: { asked: p.song, model: modelUsed },
        });
      }
    }
  } catch { /* a song is decoration; an entry without one is still an entry */ }

  const { error: insErr } = await db.from("daily_entries").insert({
    topic_id: topicId,
    user_id: userId,
    date,
    verse_ref: mainRef,
    book_number: verses[0].book_number,
    chapter: p.chapter,
    verse_start: p.verse_start,
    verse_end: p.verse_end,
    verse_text: verseText,
    thought: p.thought,
    illustration: p.illustration,
    ponder: p.ponder,
    prayer_prompts: p.prayer_prompts,
    entry_type: entryType,
    fallback_used: fallbackUsed,
    cross_refs: crossRefs,
    song,
    verse_question: await writeVerseQuestion(
      db, mainRef, verseText, entryType, MODEL_AFFIRMING,
      { topic_id: topicId, path: "live" },
    ),
  });
  if (insErr) {
    if (insErr.code === "23505") return { topic_id: topicId, status: "exists", date };
    return { topic_id: topicId, status: "failed", date, error: insErr.message };
  }
  return {
    topic_id: topicId, status: "created", date,
    entry_type: entryType, fallback_used: fallbackUsed,
    model: modelUsed,
    cross_refs: crossRefs.map((c) => c.ref),
    song: song?.track_id ?? null,
  };
}

/** Synchronous generation — the on-demand path. Someone is waiting. */
// deno-lint-ignore no-explicit-any
async function generateForTopic(db: SupabaseClient, topic: any, forceDate?: string) {
  const topicId = topic.id as string;
  const userId = topic.user_id as string;

  const ctx = await buildContext(db, topic, forceDate);
  if (!ctx) {
    const { data: profile } = await db.from("profiles")
      .select("timezone").eq("id", userId).single();
    return {
      topic_id: topicId, status: "exists",
      date: forceDate ?? localDate(profile?.timezone ?? "UTC"),
    };
  }

  const { date, entryType, messages } = ctx;
  const isUsed = (ref: string) => ctx.blocked.includes(ref);

  // Pool first. Free, instant, already validated. Only threads whose theme
  // the classifier was confident about are eligible — see select_pool_entry().
  await ensureTheme(db, topic);
  if (await tryPool(db, topicId, date, entryType)) {
    return { topic_id: topicId, status: "created", date, source: "pool" };
  }

  let payload: ReturnType<typeof parsePayload> | null = null;
  let verses: VerseRow[] | null = null;
  let modelUsed = modelFor(entryType, 1);

  // attempt 1 + retry once with error feedback (retry escalates to Sonnet).
  // callClaude already backs off internally on 429/5xx, so reaching the catch
  // below means either a validation failure or a genuine outage — both end at
  // the pool fallback under the loop.
  for (let attempt = 1; attempt <= 2 && !verses; attempt++) {
    modelUsed = modelFor(entryType, attempt);
    try {
      const raw = await callClaude(messages, modelUsed, {
        db, kind: "entry", userId: ctx.userId,
        detail: { topic_id: ctx.topicId, date: ctx.date, attempt, path: "sync" },
      });
      payload = parsePayload(raw);
      const ref = displayRef(payload.book, payload.chapter, payload.verse_start, payload.verse_end);
      if (isUsed(ref)) throw new Error(`Reference ${ref} is on the do-not-use list`);
      verses = await resolveVerse(db, payload.book, payload.chapter, payload.verse_start, payload.verse_end);
      if (!verses) throw new Error(
        `Reference ${payload.book} ${payload.chapter}:${payload.verse_start}-${payload.verse_end} does not resolve in the World English Bible`,
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await db.from("generation_failures").insert({
        topic_id: topicId, user_id: userId, date,
        stage: attempt === 1 ? "attempt_1" : "attempt_2",
        detail: { error: msg, model: modelUsed, entry_type: entryType },
      });
      verses = null;
      if (attempt === 1) {
        messages.push(
          { role: "assistant", content: "I attempted to record the devotional but the verse reference was rejected." },
          { role: "user", content: `Your previous verse choice failed validation: ${msg}. Choose a DIFFERENT passage that exists in the World English Bible and is not on the do-not-use lists, and call record_devotional again with the full entry.` },
        );
      }
    }
  }

  if (!payload) {
    // The model path is exhausted. Try the pool once more with the opposite
    // entry type before giving up: a challenge entry when an affirming one
    // was wanted is a far better day than no entry at all.
    const other = entryType === "challenge" ? "affirming" : "challenge";
    if (await tryPool(db, topicId, date, other)) {
      return { topic_id: topicId, status: "created", date, source: "pool_fallback" };
    }
    return { topic_id: topicId, status: "failed", date, error: "model output unusable after retry" };
  }
  // finalizeEntry re-resolves and applies the curated fallback if needed, so
  // an exhausted retry loop still produces an entry rather than a gap.
  return await finalizeEntry(db, topic, ctx, payload, modelUsed);
}

// -------------------------------------------------------- pool building
//
// Writes entries into the shared library. This is the ONLY place model money
// is spent at scale once the pool is warm: the nightly job serves themed
// threads from here for free, so the bill scales with the number of THEMES,
// not the number of users.
//
// Synchronous and deliberately small per invocation. Edge functions have a
// wall-clock limit, and a top-up that quietly times out half way is worse
// than one that does ten and says so. Call it repeatedly, or let the pg_cron
// top-up job do it.

const POOL_BUILD_MAX = 10;

/** How deep each theme should be kept, per entry type.
 *
 * Throttled 2026-08-26 for the ~30-person test cohort: 120/40 (6,400 rows
 * across 40 themes, ~$65 to fill) was sized for a large, long-running public
 * userbase. select_pool_entry() reuses an entry across any number of
 * concurrent users/topics — depth only needs to outlast one THREAD's own
 * repeat window, not scale with user count (see 20260823000003_entry_pool.sql
 * and 20260825000001_topic_themes_side_table.sql). 30/10 covers ~40 days of
 * affirming + ~40 days of challenge per theme before any one thread falls
 * back to live generation (graceful, not a failure) — plenty for a test
 * phase, ~$13 more to reach from the current 258 rows already built.
 * Raise back toward 120/40 ahead of a real public launch. */
const POOL_TARGET_AFFIRMING = 30;
const POOL_TARGET_CHALLENGE = 10;

function poolPrompt(
  theme: { title: string; description: string },
  entryType: string,
  dayIndex: number,
  avoidRefs: string[],
): string {
  return `THEME: ${theme.title}
WHAT SOMEONE ON THIS THREAD IS SITTING WITH: ${theme.description}

ENTRY TYPE FOR TODAY: ${entryType}

POSTURE FOR THIS ENTRY: ${
    dayIndex <= 14
      ? "Unsettled — still naming the thing, its shape not yet clear."
      : dayIndex <= 90
        ? "Familiar — the first energy has gone and the question has become ordinary."
        : "Weary — the particular ache of something that has not resolved."
  } This is an internal tone marker and nothing else. It is not a timeline: it is derived from a counter over the shared library and has no relation to any real reader's history. Obey guardrail 10 absolutely — no counts, no "a while now", no "early days", no elapsed-time framing of any kind in the text you write.

DO NOT USE any of these verse references (already in the library for this theme):
${avoidRefs.length ? avoidRefs.join("; ") : "(none)"}

IMPORTANT — this entry will be read by someone whose own words you have not seen. Write for the theme itself, honestly and concretely, but do NOT invent specifics about their circumstances (no assumed spouse, job, diagnosis, city, or age) and do not address them as though you know facts about them. Second person is fine; assumed biography is not.

Write this ${entryType} entry now. Choose the passage first, ensuring its full context genuinely supports your use of it, then write the entry around it. Call record_devotional exactly once.`;
}

/**
 * Generate and store up to POOL_BUILD_MAX pool entries.
 *
 * Picks the shallowest theme/type when not told which, so repeated calls fill
 * the library evenly instead of over-serving whichever theme was asked for
 * first.
 */
async function buildPool(
  db: SupabaseClient,
  opts: { themeSlug?: string; entryType?: string; count?: number },
) {
  const want = Math.min(opts.count ?? POOL_BUILD_MAX, POOL_BUILD_MAX);
  const themes = await loadThemes(db);
  if (!themes.length) return { built: 0, reason: "no themes" };

  // Current depth per (theme, type).
  const { data: depth } = await db.rpc("pool_depth");
  const have = new Map<string, number>();
  for (const row of (depth ?? []) as Array<Record<string, unknown>>) {
    have.set(`${row.slug}:${row.entry_type}`, Number(row.available));
  }

  // Candidate slots, shallowest first.
  type Slot = { theme: typeof themes[number]; entryType: string; deficit: number };
  const slots: Slot[] = [];
  for (const theme of themes) {
    if (opts.themeSlug && theme.slug !== opts.themeSlug) continue;
    for (const [entryType, target] of [
      ["affirming", POOL_TARGET_AFFIRMING],
      ["challenge", POOL_TARGET_CHALLENGE],
    ] as const) {
      if (opts.entryType && entryType !== opts.entryType) continue;
      const deficit = target - (have.get(`${theme.slug}:${entryType}`) ?? 0);
      if (deficit > 0) slots.push({ theme, entryType, deficit });
    }
  }
  if (!slots.length) return { built: 0, reason: "pool is at target depth" };

  // Sort by how FAR BEHIND target a slot is proportionally, not by absolute
  // deficit. Absolute deficit always favoured affirming (target 120) over
  // challenge (target 40), so the first several hundred builds would have been
  // affirming-only — and every challenge entry would have fallen through to
  // live per-user generation, quietly defeating the point of the pool.
  const shortfall = (s: Slot) => {
    const target = s.entryType === "affirming" ? POOL_TARGET_AFFIRMING : POOL_TARGET_CHALLENGE;
    return s.deficit / target;
  };
  slots.sort((a, b) => shortfall(b) - shortfall(a));

  const results: Array<Record<string, unknown>> = [];
  let built = 0;

  for (let i = 0; i < want; i++) {
    const slot = slots[i % slots.length];

    // Verses already in the library for this theme, so the pool spreads
    // across the canon instead of circling the same twenty passages.
    const { data: existing } = await db.from("entry_pool")
      .select("verse_ref, day_index")
      .eq("theme_id", slot.theme.id)
      .eq("retired", false);
    const avoid = [...new Set((existing ?? []).map((r) => String(r.verse_ref)))];

    // Spread day_index across a year rather than clustering at 0.
    const dayIndex = (( (existing?.length ?? 0) * 37) % 365);

    const model = modelFor(slot.entryType, 1);
    try {
      const raw = await callClaude(
        [{ role: "user", content: poolPrompt(slot.theme, slot.entryType, dayIndex, avoid) }],
        model,
        { db, kind: "pool_build", detail: { theme: slot.theme.slug, entry_type: slot.entryType } },
      );
      const payload = parsePayload(raw);

      // Validate the verse HERE, once, so it is never validated per user.
      // This is the quiet win of the pool: a bad reference never reaches
      // anybody, and the retry cost is paid once instead of per reader.
      const verses = await resolveVerse(
        db, payload.book, payload.chapter, payload.verse_start, payload.verse_end,
      );
      if (!verses) {
        await db.from("generation_failures").insert({
          stage: "pool_verse_resolution",
          detail: { theme: slot.theme.slug, ref: `${payload.book} ${payload.chapter}:${payload.verse_start}`, model },
        });
        results.push({ theme: slot.theme.slug, status: "verse_failed" });
        continue;
      }

      const ref = displayRef(payload.book, payload.chapter, payload.verse_start, payload.verse_end);
      const { error } = await db.from("entry_pool").insert({
        theme_id: slot.theme.id,
        day_index: dayIndex,
        entry_type: slot.entryType,
        verse_ref: ref,
        book_number: verses[0].book_number,
        chapter: payload.chapter,
        verse_start: payload.verse_start,
        verse_end: payload.verse_end,
        verse_text: verses.map((v) => v.text).join(" "),
        thought: payload.thought,
        illustration: payload.illustration,
        ponder: payload.ponder,
        prayer_prompts: payload.prayer_prompts,
        // Same second pass as the live path. Miss this and every pooled entry
        // silently lands with a null anchored question, so the feature looks
        // broken for exactly the users who never hit live generation.
        verse_question: await writeVerseQuestion(
          db, ref, verses.map((v) => v.text).join(" "), slot.entryType, MODEL_AFFIRMING,
          { theme: slot.theme.slug, path: "pool" },
        ),
        model,
      });
      if (error) {
        results.push({ theme: slot.theme.slug, status: "insert_failed", error: error.message });
        continue;
      }
      built++;
      results.push({ theme: slot.theme.slug, entry_type: slot.entryType, ref, status: "built" });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await db.from("generation_failures").insert({
        stage: "pool_build",
        detail: { theme: slot.theme.slug, error: msg, model },
      });
      results.push({ theme: slot.theme.slug, status: "failed", error: msg });
      // An outage will fail every remaining slot too — stop rather than
      // hammering it and burning the retry budget.
      if (/Anthropic API (5\d\d|429)/.test(msg)) break;
    }
  }

  return { built, results };
}

// -------------------------------------------------------------- batching
//
// The Message Batches API is half price and the nightly job has no latency
// requirement, which is the whole reason this exists: at US$9.99/yr, three
// active threads cost $9.03/yr synchronously against ~$8.49 of net revenue,
// and $4.52 batched. Batching is what makes the 3-thread cap affordable.
//
// Flow: run_daily_generation() (pg_cron, 2h before each user's notification
// hour) POSTs mode=batch_submit. run_batch_collection() (every 10 min) POSTs
// mode=batch_collect until nothing is outstanding.

const BATCH_API = "https://api.anthropic.com/v1/messages/batches";

function anthropicHeaders() {
  return {
    "x-api-key": ANTHROPIC_API_KEY,
    "anthropic-version": "2023-06-01",
    "content-type": "application/json",
  };
}

/** Request body for one entry, matching the synchronous callClaude shape. */
function batchParams(messages: unknown[], model: string) {
  return {
    model,
    max_tokens: 2048,
    system: [
      { type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } },
    ],
    tools: [DEVOTIONAL_TOOL],
    tool_choice: { type: "tool", name: "record_devotional" },
    messages,
  };
}

/**
 * Build and submit one batch covering every due topic.
 *
 * custom_id is `${topicId}_${date}` — deterministic, so a result can always
 * be traced back even if the bookkeeping row were lost.
 *
 * The separator is an underscore, not a colon: Anthropic validates custom_id
 * against ^[a-zA-Z0-9_-]{1,64}$ and rejects the WHOLE batch with a 400 if any
 * id fails. A colon silently broke every nightly submit until 2026-08-22.
 */
async function submitBatch(
  db: SupabaseClient,
  // deno-lint-ignore no-explicit-any
  topics: any[],
  forceDate?: string,
) {
  const requests: unknown[] = [];
  const items: Record<string, unknown>[] = [];
  let skipped = 0;
  let pooled = 0;

  for (const topic of topics) {
    let ctx: EntryContext | null = null;
    try {
      ctx = await buildContext(db, topic, forceDate);
    } catch (e) {
      console.error(`buildContext failed for ${topic.id}: ${e}`);
      continue;
    }
    if (!ctx) { skipped++; continue; } // already has today's entry

    // Pool first, before anything is put in the batch. This is where the
    // money is actually saved: a themed thread never reaches the model at
    // all, so the nightly bill scales with the number of THEMES, not the
    // number of users.
    await ensureTheme(db, topic);
    if (await tryPool(db, ctx.topicId, ctx.date, ctx.entryType)) {
      pooled++;
      continue;
    }

    const customId = `${ctx.topicId}_${ctx.date}`;
    requests.push({
      custom_id: customId,
      params: batchParams(ctx.messages, modelFor(ctx.entryType, 1)),
    });
    items.push({
      custom_id: customId,
      topic_id: ctx.topicId,
      user_id: ctx.userId,
      date: ctx.date,
      entry_type: ctx.entryType,
      // The do-not-use list is captured at submit time and replayed at
      // collect time. Re-deriving it later would be subtly wrong: an
      // on-demand entry created in between would change the answer and could
      // reject a passage the model was legitimately told it could use.
      detail: { blocked: ctx.blocked },
    });
  }

  if (!requests.length) {
    return { submitted: 0, skipped, pooled, batch_id: null };
  }

  const res = await fetch(BATCH_API, {
    method: "POST",
    headers: anthropicHeaders(),
    body: JSON.stringify({ requests }),
  });
  if (!res.ok) {
    throw new Error(`Batch submit ${res.status}: ${(await res.text()).slice(0, 500)}`);
  }
  const batch = await res.json();

  const { data: row, error } = await db.from("generation_batches").insert({
    provider_batch_id: batch.id,
    request_count: requests.length,
    detail: { processing_status: batch.processing_status },
  }).select("id").single();
  if (error) throw new Error(`recording batch failed: ${error.message}`);

  const { error: itemErr } = await db.from("generation_batch_items")
    .insert(items.map((i) => ({ ...i, batch_id: row.id })));
  if (itemErr) throw new Error(`recording batch items failed: ${itemErr.message}`);

  return { submitted: requests.length, skipped, pooled, batch_id: batch.id };
}

/**
 * Pull one JSONL results stream into custom_id -> tool payload (or error).
 *
 * Also totals the `usage` block of every succeeded row, per model, so the
 * batch's cost can be ledgered in one write rather than one per entry. A
 * failed row still burned input tokens, but Anthropic does not bill for it,
 * so only succeeded rows are counted.
 */
async function fetchBatchResults(resultsUrl: string) {
  const res = await fetch(resultsUrl, { headers: anthropicHeaders() });
  if (!res.ok) {
    throw new Error(`Batch results ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  const text = await res.text();
  const out = new Map<string, { ok: true; input: Record<string, unknown> } | { ok: false; error: string }>();
  const usageByModel = new Map<string, Usage & { rows: number }>();

  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      const id = String(row.custom_id ?? "");
      if (!id) continue;
      if (row.result?.type !== "succeeded") {
        out.set(id, { ok: false, error: row.result?.type ?? "unknown result type" });
        continue;
      }

      const msg = row.result.message ?? {};
      const model = String(msg.model ?? "unknown");
      const u = (msg.usage ?? {}) as Usage;
      const acc = usageByModel.get(model) ??
        { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, rows: 0 };
      acc.input_tokens = (acc.input_tokens ?? 0) + (u.input_tokens ?? 0);
      acc.output_tokens = (acc.output_tokens ?? 0) + (u.output_tokens ?? 0);
      acc.cache_read_input_tokens = (acc.cache_read_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
      acc.cache_creation_input_tokens = (acc.cache_creation_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
      acc.rows += 1;
      usageByModel.set(model, acc);

      const block = (msg.content ?? [])
        .find((b: { type: string }) => b.type === "tool_use");
      if (!block?.input) {
        out.set(id, { ok: false, error: "no tool_use block" });
        continue;
      }
      out.set(id, { ok: true, input: block.input });
    } catch {
      /* a malformed line loses one entry, not the batch */
    }
  }
  return { byId: out, usageByModel };
}

/**
 * Collect every finished batch and write the entries.
 *
 * Anything that fails validation is repaired with a single SYNCHRONOUS
 * Sonnet call. That is deliberately the expensive model on the rare path:
 * repairs are a small fraction of entries, and a batch failure otherwise
 * means the user simply has no entry that day.
 */
async function collectBatches(db: SupabaseClient) {
  const { data: open, error } = await db.from("generation_batches")
    .select("id, provider_batch_id, request_count")
    .eq("status", "submitted")
    .order("submitted_at", { ascending: true })
    .limit(5);
  if (error) throw new Error(error.message);
  if (!open?.length) return { collected: 0, batches: [] };

  const summaries = [];

  for (const batch of open) {
    const statusRes = await fetch(`${BATCH_API}/${batch.provider_batch_id}`, {
      headers: anthropicHeaders(),
    });
    if (!statusRes.ok) {
      summaries.push({ batch: batch.provider_batch_id, status: `poll ${statusRes.status}` });
      continue;
    }
    const info = await statusRes.json();

    if (info.processing_status !== "ended") {
      summaries.push({ batch: batch.provider_batch_id, status: info.processing_status });
      continue; // still running — the next tick will pick it up
    }
    if (!info.results_url) {
      await db.from("generation_batches").update({
        status: "failed", collected_at: new Date().toISOString(),
        detail: { reason: "ended with no results_url", info },
      }).eq("id", batch.id);
      summaries.push({ batch: batch.provider_batch_id, status: "failed" });
      continue;
    }

    const { byId: results, usageByModel } = await fetchBatchResults(info.results_url);

    // One ledger row per model per batch. Half price — this is the Batch API.
    for (const [model, u] of usageByModel) {
      await recordSpend(db, "entry", model, u, {
        batch: true,
        detail: { batch: batch.provider_batch_id, rows: u.rows, path: "batch" },
      });
    }

    const { data: items } = await db.from("generation_batch_items")
      .select("custom_id, topic_id, user_id, date, entry_type, detail")
      .eq("batch_id", batch.id)
      .eq("status", "pending");

    let inserted = 0;

    for (const item of items ?? []) {
      const { data: topic } = await db.from("topics")
        .select(TOPIC_COLS).eq("id", item.topic_id).maybeSingle();
      // Thread deleted, concluded or paused between submit and collect.
      if (!topic) {
        await markItem(db, batch.id, item.custom_id, "failed", { reason: "thread gone" });
        continue;
      }

      const ctx: EntryContext = {
        topicId: item.topic_id as string,
        userId: item.user_id as string,
        date: item.date as string,
        entryType: item.entry_type as string,
        messages: [],
        blocked: ((item.detail as { blocked?: string[] })?.blocked) ?? [],
      };

      const result = results.get(item.custom_id as string);
      let payload: ReturnType<typeof parsePayload> | null = null;
      let modelUsed = modelFor(ctx.entryType, 1);

      if (result?.ok) {
        try {
          payload = parsePayload(result.input);
        } catch (e) {
          await db.from("generation_failures").insert({
            topic_id: ctx.topicId, user_id: ctx.userId, date: ctx.date,
            stage: "batch_parse",
            detail: { error: String(e), model: modelUsed },
          });
        }
      } else {
        await db.from("generation_failures").insert({
          topic_id: ctx.topicId, user_id: ctx.userId, date: ctx.date,
          stage: "batch_result",
          detail: { error: result?.ok === false ? result.error : "missing result" },
        });
      }

      // Repair path. Pool first — a free, already-validated entry beats
      // spending Sonnet money to rescue a batch row.
      if (!payload) {
        if (await tryPool(db, ctx.topicId, ctx.date, ctx.entryType)) {
          inserted++;
          await markItem(db, batch.id, item.custom_id, "inserted", { source: "pool" });
          continue;
        }
      }

      // Still nothing: one synchronous Sonnet attempt.
      if (!payload) {
        try {
          const repaired = await buildContext(db, topic, ctx.date);
          if (!repaired) {
            await markItem(db, batch.id, item.custom_id, "exists", {});
            continue;
          }
          modelUsed = MODEL_CHALLENGE;
          payload = parsePayload(
            await callClaude(repaired.messages, modelUsed, {
              db, kind: "entry", userId: ctx.userId,
              detail: { topic_id: ctx.topicId, date: ctx.date, path: "batch_repair" },
            }),
          );
          ctx.blocked = repaired.blocked;
        } catch (e) {
          await markItem(db, batch.id, item.custom_id, "failed", { error: String(e) });
          continue;
        }
      }

      const outcome = await finalizeEntry(db, topic, ctx, payload, modelUsed);
      if (outcome.status === "created") inserted++;
      await markItem(
        db, batch.id, item.custom_id,
        outcome.status === "created" ? "inserted"
          : outcome.status === "exists" ? "exists" : "failed",
        outcome,
      );
    }

    await db.from("generation_batches").update({
      status: "collected",
      collected_at: new Date().toISOString(),
      inserted_count: inserted,
      detail: { request_counts: info.request_counts },
    }).eq("id", batch.id);

    summaries.push({ batch: batch.provider_batch_id, status: "collected", inserted });
  }

  return { collected: summaries.length, batches: summaries };
}

function markItem(
  db: SupabaseClient,
  batchId: string,
  customId: string,
  status: string,
  detail: unknown,
) {
  return db.from("generation_batch_items")
    .update({ status, detail })
    .eq("batch_id", batchId)
    .eq("custom_id", customId);
}

// ------------------------------------------------------------------ auth

// Verify a project-issued JWT against the injected JWKS (real signature
// check — safe regardless of the platform verify_jwt setting). Returns the
// role claim, or null. Lets privileged dashboard-tester tokens through.
async function verifyPlatformJwt(token: string): Promise<string | null> {
  const raw = Deno.env.get("SUPABASE_JWKS");
  if (!raw) return null;
  try {
    const jwks = jose.createLocalJWKSet(JSON.parse(raw));
    const { payload } = await jose.jwtVerify(token, jwks);
    return typeof payload.role === "string" ? payload.role : null;
  } catch {
    return null;
  }
}

const SERVICE_ROLES = new Set(["service_role", "postgres", "supabase_admin"]);

// ------------------------------------------------------------ the gate
//
// There is no billing gate any more — Ponder is free. What guards this
// endpoint now is the monthly spend ceiling, checked in generationAllowed()
// above. Every path that can reach the Anthropic API passes through it,
// because the client-side check in src/lib/entitlements.ts is a UI
// affordance, not a security boundary — this endpoint is reachable with
// nothing but a user's JWT.
//
// has_active_entitlement() still exists and still answers truthfully; it just
// no longer decides whether anyone may use the app. It decides how much.

async function authorize(req: Request, db: SupabaseClient): Promise<
  { role: "service" } | { role: "user"; userId: string } | null
> {
  const auth = req.headers.get("authorization") ?? "";
  const token = auth.replace(/^Bearer\s+/i, "").trim();
  if (!token) return null;
  if (token === SERVICE_KEY) return { role: "service" };
  {
    const role = await verifyPlatformJwt(token);
    if (role && SERVICE_ROLES.has(role)) return { role: "service" };
  }
  // any sb_secret key for this project counts as service access
  if (token.startsWith("sb_secret_")) {
    const probe = createClient(SUPABASE_URL, token, { auth: { persistSession: false } });
    const { error } = await probe.from("bible_books").select("book_number").limit(1);
    if (!error) return { role: "service" };
    return null;
  }
  const { data, error } = await db.auth.getUser(token);
  if (error || !data?.user) return null;
  return { role: "user", userId: data.user.id };
}

// ------------------------------------------------------------------ main

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json(405, { error: "POST only" });

  if (!ANTHROPIC_API_KEY) {
    return json(500, { error: "ANTHROPIC_API_KEY secret is not set" });
  }

  const db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

  const who = await authorize(req, db);
  if (!who) return json(401, { error: "Unauthorized" });

  let body: {
    topic_id?: string;
    force_date?: string;
    user_ids?: string[];
    mode?: "batch_submit" | "batch_collect" | "pool_build";
    theme_slug?: string;
    entry_type?: string;
    count?: number;
  } = {};
  try {
    body = await req.json();
  } catch { /* empty body = legacy synchronous cron mode */ }

  // Pool building touches no user data at all — it writes to the shared
  // library — so it short-circuits before any topic resolution. Service key
  // only: this is the one path that spends money without a user asking.
  if (body.mode === "pool_build") {
    if (who.role !== "service") return json(403, { error: "service key required" });
    if (!(await generationAllowed(db))) {
      return json(429, { error: "spend_tripwire", built: 0 });
    }
    try {
      return json(200, await buildPool(db, {
        themeSlug: body.theme_slug,
        entryType: body.entry_type,
        count: body.count,
      }));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`pool_build failed: ${msg}`);
      return json(500, { error: msg });
    }
  }

  // Collection touches no user data of its own — it drains whatever is
  // outstanding — so it short-circuits before topic resolution.
  if (body.mode === "batch_collect") {
    if (who.role !== "service") return json(403, { error: "service key required" });
    try {
      return json(200, await collectBatches(db));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`batch_collect failed: ${msg}`);
      return json(500, { error: msg });
    }
  }

  // NO spend gate on the user path, deliberately. The tripwire exists to stop
  // a runaway automated loop, not to ration people — a person tapping a
  // button is rate-limited by being a person, and the user experience must
  // never change because of money. If generation fails, the pool covers it;
  // if the pool cannot, the client shows "running late", not a refusal.

  // resolve target topics
  let query = db.from("topics").select(TOPIC_COLS)
    .eq("status", "active");
  if (body.topic_id) query = query.eq("id", body.topic_id);
  if (who.role === "user") query = query.eq("user_id", who.userId);
  // Cron path: run_daily_generation() passes the exact set of due users.
  // Scoping here is what stops one user's notification hour from triggering
  // generation for everybody else.
  if (who.role === "service" && body.user_ids?.length) {
    query = query.in("user_id", body.user_ids);
  }
  const { data: allTopics, error } = await query;
  if (error) return json(500, { error: error.message });
  if (!allTopics?.length) return json(404, { error: "No matching active threads" });

  // Tripwire, service path only. run_daily_generation() already refuses to
  // submit when it has fired, but this function is also callable directly
  // with a service key (manual runs, backfills) — exactly the calls that
  // would compound a runaway. One indexed lookup against thousands of tokens.
  if (who.role === "service" && !(await generationAllowed(db))) {
    return json(429, { error: "spend_tripwire", results: [] });
  }

  const topics = allTopics;

  // Batch path — the nightly job. One API call for every due thread at half
  // price, collected later by run_batch_collection().
  if (body.mode === "batch_submit") {
    if (who.role !== "service") return json(403, { error: "service key required" });
    try {
      return json(200, await submitBatch(db, topics, body.force_date));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`batch_submit failed: ${msg}`);
      // Deliberately not fatal to the day: the caller can fall back to a
      // synchronous run, and the next hourly tick will try again.
      return json(500, { error: msg });
    }
  }

  const results = [];
  for (const t of topics) {
    try {
      results.push(await generateForTopic(db, t, body.force_date));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await db.from("generation_failures").insert({
        topic_id: t.id, user_id: t.user_id, stage: "unhandled", detail: { error: msg },
      });
      results.push({ topic_id: t.id, status: "failed", error: msg });
    }
  }
  // The user path never sees how the entry was produced. `source` says
  // "pool" or "pool_fallback" on a copied entry, and that word has no
  // business on the wire to a reader — Ponder must look like it wrote today
  // for them, in devtools as much as on screen. The service path keeps it:
  // the cron logs are where provenance is actually needed.
  return json(200, {
    results: who.role === "user" ? results.map(stripProvenance) : results,
  });
});

/** Drop server-side provenance from a per-topic result before it goes to a user. */
function stripProvenance(r: unknown): unknown {
  if (!r || typeof r !== "object") return r;
  const { source: _source, error: _error, ...rest } = r as Record<string, unknown>;
  return rest;
}
