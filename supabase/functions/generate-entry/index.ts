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

import { createClient, SupabaseClient } from "npm:@supabase/supabase-js@2";
import * as jose from "npm:jose@5";

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

// The topic's seed passage may be chosen again as a daily entry. Set this to a
// positive number of days to suppress it for a topic's opening stretch (avoids
// the "it just gave me back the verse I typed in" moment in week one).
// 0 = never suppressed.
const SEED_VERSE_COOLDOWN_DAYS = 0;

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

async function callClaude(
  messages: unknown[],
  model: string,
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
  const toolUse = (data.content ?? []).find((b: { type: string }) => b.type === "tool_use");
  if (!toolUse?.input) throw new Error("No tool_use block in model response");
  return toolUse.input as Record<string, unknown>;
}

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
    if (!Array.isArray(x)) return null;
    const arr = x.map((s) => String(s).trim()).filter(Boolean).slice(0, max);
    return arr.length >= min ? arr : null;
  };

  const thought = String(raw.thought ?? "").trim();
  const illustration = String(raw.illustration ?? "").trim();
  const ponder = strArr(raw.ponder, 2, 3);
  const prayer_prompts = strArr(raw.prayer_prompts, 2, 3);

  if (!book || !Number.isInteger(chapter) || !Number.isInteger(verse_start)) {
    throw new Error("Malformed verse reference in model output");
  }
  if (thought.length < 100 || illustration.length < 100 || !ponder || !prayer_prompts) {
    throw new Error("Malformed content fields in model output");
  }
  const cross_refs = parseCrossRefs(raw.cross_refs);
  return { book, chapter, verse_start, verse_end, thought, illustration, ponder, prayer_prompts, cross_refs };
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
function buildUserPrompt(topic: any, recent: any[], usedRefs: string[], notes: any[], entryType: string, blockedRecent: string[]) {
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

  return `THREAD: ${topic.title}
USER'S OWN WORDS ABOUT IT: ${topic.description || "(none provided)"}

${originBlock}

ENTRY TYPE FOR TODAY: ${entryType}

LAST ENTRIES (for continuity — do not repeat their angle or verses):
${recentBlock}

DO NOT USE any of these verse references (already used in this thread):
${usedRefs.length ? usedRefs.join("; ") : "(none)"}

ALSO AVOID these references (used recently across the user's other threads):
${blockedRecent.length ? blockedRecent.join("; ") : "(none)"}

RECENT USER NOTES (their own reflections — weave awareness of these in gently, without quoting them back verbatim):
${notesBlock}

Write today's ${entryType} entry now. Choose the passage first, ensuring its full context genuinely supports your use of it, then write the entry around it. Call record_devotional exactly once.`;
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

  const userPrompt = buildUserPrompt(topic, recent ?? [], usedRefs, notes ?? [], entryType, blockedForPrompt);

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

  let payload: ReturnType<typeof parsePayload> | null = null;
  let verses: VerseRow[] | null = null;
  let modelUsed = modelFor(entryType, 1);

  // attempt 1 + retry once with error feedback (retry escalates to Sonnet)
  for (let attempt = 1; attempt <= 2 && !verses; attempt++) {
    modelUsed = modelFor(entryType, attempt);
    try {
      const raw = await callClaude(messages, modelUsed);
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
    return { topic_id: topicId, status: "failed", date, error: "model output unusable after retry" };
  }
  // finalizeEntry re-resolves and applies the curated fallback if needed, so
  // an exhausted retry loop still produces an entry rather than a gap.
  return await finalizeEntry(db, topic, ctx, payload, modelUsed);
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

  for (const topic of topics) {
    let ctx: EntryContext | null = null;
    try {
      ctx = await buildContext(db, topic, forceDate);
    } catch (e) {
      console.error(`buildContext failed for ${topic.id}: ${e}`);
      continue;
    }
    if (!ctx) { skipped++; continue; } // already has today's entry

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
    return { submitted: 0, skipped, batch_id: null };
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

  return { submitted: requests.length, skipped, batch_id: batch.id };
}

/** Pull one JSONL results stream into custom_id -> tool payload (or error). */
async function fetchBatchResults(resultsUrl: string) {
  const res = await fetch(resultsUrl, { headers: anthropicHeaders() });
  if (!res.ok) {
    throw new Error(`Batch results ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  const text = await res.text();
  const out = new Map<string, { ok: true; input: Record<string, unknown> } | { ok: false; error: string }>();

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
      const block = (row.result.message?.content ?? [])
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
  return out;
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

    const results = await fetchBatchResults(info.results_url);

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

      // Repair path: one synchronous Sonnet attempt.
      if (!payload) {
        try {
          const repaired = await buildContext(db, topic, ctx.date);
          if (!repaired) {
            await markItem(db, batch.id, item.custom_id, "exists", {});
            continue;
          }
          modelUsed = MODEL_CHALLENGE;
          payload = parsePayload(await callClaude(repaired.messages, modelUsed));
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

// ---------------------------------------------------------- entitlement
//
// The billing gate. Every path in this function that can reach the Anthropic
// API passes through here, because the client-side check in
// src/lib/entitlements.ts is a UI affordance, not a security boundary — this
// endpoint is reachable with nothing but a user's JWT.
//
// Fails CLOSED: an RPC error means we do not generate. A transient database
// error costs the user one day's entry; the alternative is an open endpoint
// that bills tokens to whoever asks.

async function isEntitled(db: SupabaseClient, userId: string): Promise<boolean> {
  const { data, error } = await db.rpc("has_active_entitlement", {
    p_user_id: userId,
  });
  if (error) {
    console.error(`entitlement check failed for ${userId}: ${error.message}`);
    return false;
  }
  return data === true;
}

/** Batch variant for the cron path — one round trip per distinct user. */
async function entitledUserSet(
  db: SupabaseClient,
  userIds: string[],
): Promise<Set<string>> {
  const out = new Set<string>();
  await Promise.all(
    [...new Set(userIds)].map(async (id) => {
      if (await isEntitled(db, id)) out.add(id);
    }),
  );
  return out;
}

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
    mode?: "batch_submit" | "batch_collect";
  } = {};
  try {
    body = await req.json();
  } catch { /* empty body = legacy synchronous cron mode */ }

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

  // Billing gate, user path: refuse before any topic lookup or model call.
  // 402 (not 403) so the client can distinguish "you need to subscribe" from
  // "this isn't yours" and route to the paywall.
  if (who.role === "user" && !(await isEntitled(db, who.userId))) {
    return json(402, {
      error: "subscription_required",
      message: "An active Ponder subscription is required to generate entries.",
    });
  }

  // resolve target topics
  let query = db.from("topics").select(TOPIC_COLS)
    .eq("status", "active");
  if (body.topic_id) query = query.eq("id", body.topic_id);
  if (who.role === "user") query = query.eq("user_id", who.userId);
  // Cron path: run_daily_generation() passes the exact set of due + entitled
  // users. Scoping here is what stops one user's notification hour from
  // triggering generation for everybody else.
  if (who.role === "service" && body.user_ids?.length) {
    query = query.in("user_id", body.user_ids);
  }
  const { data: allTopics, error } = await query;
  if (error) return json(500, { error: error.message });
  if (!allTopics?.length) return json(404, { error: "No matching active threads" });

  // Billing gate, service path. run_daily_generation() already filters on
  // entitlement, but this function is also callable directly with a service
  // key (manual runs, backfills), and an unentitled user must never be
  // generated for by accident. Re-checking here is the cheap belt to that
  // brace — it is one indexed lookup against thousands of tokens.
  let topics = allTopics;
  let skippedUnentitled = 0;
  if (who.role === "service") {
    const entitled = await entitledUserSet(
      db,
      allTopics.map((t) => t.user_id as string),
    );
    topics = allTopics.filter((t) => entitled.has(t.user_id as string));
    skippedUnentitled = allTopics.length - topics.length;
    if (!topics.length) {
      return json(200, { results: [], skipped_unentitled: skippedUnentitled });
    }
  }

  // Batch path — the nightly job. One API call for every due thread at half
  // price, collected later by run_batch_collection().
  if (body.mode === "batch_submit") {
    if (who.role !== "service") return json(403, { error: "service key required" });
    try {
      return json(200, {
        ...(await submitBatch(db, topics, body.force_date)),
        skipped_unentitled: skippedUnentitled,
      });
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
  return json(200, { results, skipped_unentitled: skippedUnentitled });
});
