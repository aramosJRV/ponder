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

import { createClient, SupabaseClient } from "npm:@supabase/supabase-js@2";
import * as jose from "npm:jose@5";

// ---------------------------------------------------------------- config

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY =
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? Deno.env.get("SB_SECRET_KEY")!;
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
const MODEL = Deno.env.get("ANTHROPIC_MODEL") ?? "claude-sonnet-4-6";

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

const SYSTEM_PROMPT = `You write daily devotional entries for a personal discernment journal. The user tracks topics they sense God may be speaking to them about, and your entries are material for their reflection and discernment — never verdicts.

Non-negotiable guardrails:
1. NEVER claim God is telling the user something, and never make predictive or directive claims about their life decisions ("God is saying...", "this means you should quit/stay/move" are all forbidden). Frame everything as invitation to reflect: "consider", "notice", "sit with".
2. Scripture must be handled in context. Do not proof-text: never use a verse fragment against the meaning of its surrounding passage. Choose passages whose actual context genuinely relates to the topic.
3. Illustrations must be either clearly framed as hypothetical/analogy ("imagine...", "a farmer who...") or verifiably true and commonly known. NEVER invent quotes, statistics, or historical anecdotes presented as fact. No invented named people.
4. Broadly orthodox, non-denominational Christian posture. Avoid partisan politics and denominationally contentious claims (e.g. modes of baptism, predestination debates) unless the topic explicitly invites them.
5. Challenge entries question the user's framing honestly but pastorally — hard questions, not harsh ones. Never mock, never shame.
6. Use the World English Bible naming: "Psalms" (not "Psalm") as the book name in references.
7. The passage text is shown to the reader verbatim (World English Bible) directly above your writing. Do NOT reproduce the passage as a full quotation in your thought or illustration — you will misremember the exact wording and contradict the text on screen (e.g. writing "the LORD" where the WEB reads "Yahweh", or adding words like "both"). Refer to the passage instead: describe what it says, and quote at most a short distinctive phrase of a few words. Never present a reconstructed full-verse quotation.

You will be told whether to write an "affirming" or a "challenge" entry:
- affirming: sits inside the user's sense of the topic and deepens it.
- challenge: gently questions their framing, offers a scriptural counterpoint, or asks what they might be avoiding. It should still end in hope.

Verse selection: choose ONE passage (1-3 consecutive verses) from the provided do-not-use lists' complement — i.e. any passage NOT in those lists. Prefer variety across the whole canon over famous verses.`;

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
      thought: { type: "string", description: "80-150 word reflection on the passage and topic" },
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

async function callClaude(messages: unknown[]): Promise<Record<string, unknown>> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 2048,
      system: SYSTEM_PROMPT,
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
  return { book, chapter, verse_start, verse_end, thought, illustration, ponder, prayer_prompts };
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

  return `TOPIC: ${topic.title}
USER'S OWN WORDS ABOUT IT: ${topic.description || "(none provided)"}

ENTRY TYPE FOR TODAY: ${entryType}

LAST ENTRIES (for continuity — do not repeat their angle or verses):
${recentBlock}

DO NOT USE any of these verse references (already used in this topic):
${usedRefs.length ? usedRefs.join("; ") : "(none)"}

ALSO AVOID these references (used recently across the user's other topics):
${blockedRecent.length ? blockedRecent.join("; ") : "(none)"}

RECENT USER NOTES (their own reflections — weave awareness of these in gently, without quoting them back verbatim):
${notesBlock}

Write today's ${entryType} entry now. Choose the passage first, ensuring its full context genuinely supports your use of it, then write the entry around it. Call record_devotional exactly once.`;
}

// ------------------------------------------------------------- generation

// deno-lint-ignore no-explicit-any
async function generateForTopic(db: SupabaseClient, topic: any, forceDate?: string) {
  const topicId = topic.id as string;
  const userId = topic.user_id as string;

  const { data: profile } = await db.from("profiles")
    .select("timezone, challenge_frequency").eq("id", userId).single();
  const tz = profile?.timezone ?? "UTC";
  const date = forceDate ?? localDate(tz);

  // already generated?
  const { data: existing } = await db.from("daily_entries")
    .select("id").eq("topic_id", topicId).eq("date", date).maybeSingle();
  if (existing) return { topic_id: topicId, status: "exists", date };

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

  const userPrompt = buildUserPrompt(topic, recent ?? [], usedRefs, notes ?? [], entryType, blockedRecent);
  const messages: unknown[] = [{ role: "user", content: userPrompt }];

  const isUsed = (ref: string) =>
    usedRefs.includes(ref) || blockedRecent.includes(ref);

  let payload: ReturnType<typeof parsePayload> | null = null;
  let verses: VerseRow[] | null = null;
  let fallbackUsed = false;

  // attempt 1 + retry once with error feedback
  for (let attempt = 1; attempt <= 2 && !verses; attempt++) {
    try {
      const raw = await callClaude(messages);
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
        detail: { error: msg, model: MODEL },
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

  // fallback: curated list, keep model content if we have it
  if (!verses) {
    if (!payload) {
      return { topic_id: topicId, status: "failed", date, error: "model output unusable after retry" };
    }
    const theme = fallbackTheme(`${topic.title} ${topic.description ?? ""}`);
    for (const [book, ch, s, e] of [...FALLBACKS[theme], ...FALLBACKS.default]) {
      const ref = displayRef(book, ch, s, e);
      if (isUsed(ref)) continue;
      verses = await resolveVerse(db, book, ch, s, e);
      if (verses) {
        payload = { ...payload, book, chapter: ch, verse_start: s, verse_end: e };
        fallbackUsed = true;
        await db.from("generation_failures").insert({
          topic_id: topicId, user_id: userId, date, stage: "fallback_used",
          detail: { fallback_ref: ref, theme },
        });
        break;
      }
    }
    if (!verses) {
      return { topic_id: topicId, status: "failed", date, error: "no usable fallback verse" };
    }
  }

  const p = payload!;
  const verseText = verses.map((v) => v.text).join(" ");
  const { error: insErr } = await db.from("daily_entries").insert({
    topic_id: topicId,
    user_id: userId,
    date,
    verse_ref: displayRef(p.book, p.chapter, p.verse_start, p.verse_end),
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
  });
  if (insErr) {
    if (insErr.code === "23505") return { topic_id: topicId, status: "exists", date };
    return { topic_id: topicId, status: "failed", date, error: insErr.message };
  }
  return { topic_id: topicId, status: "created", date, entry_type: entryType, fallback_used: fallbackUsed };
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

  let body: { topic_id?: string; force_date?: string } = {};
  try {
    body = await req.json();
  } catch { /* empty body = cron mode */ }

  // resolve target topics
  let query = db.from("topics").select("id, user_id, title, description")
    .eq("status", "active");
  if (body.topic_id) query = query.eq("id", body.topic_id);
  if (who.role === "user") query = query.eq("user_id", who.userId);
  const { data: topics, error } = await query;
  if (error) return json(500, { error: error.message });
  if (!topics?.length) return json(404, { error: "No matching active topics" });

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
  return json(200, { results });
});
