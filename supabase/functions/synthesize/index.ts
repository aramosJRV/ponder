// synthesize — produces a "what's emerging" synthesis for a topic.
//
// POST { topic_id: string, kind?: "on_demand" | "conclusion" }
//
// Sends the topic description + every entry's verse ref & thought + all user
// notes to Claude, and returns three lists: recurring threads, tensions/open
// questions, and 2-3 suggested next steps. Stores the result in `syntheses`.
//
// Auth (verify_jwt is OFF; checked explicitly, same as generate-entry):
//   - service key (legacy JWT or sb_secret_*) → full access (admin)
//   - user JWT → only their own topic
//
// This never quotes scripture text back (verse text lives in the DB); it works
// from references + the user's own words, staying reflective, not directive.
//
// content.sources records what the synthesis was actually built from (entry
// refs, counts, date span). It is computed server-side from the query results,
// never requested from the model — so the footnote cannot be embellished.

import { createClient, SupabaseClient } from "npm:@supabase/supabase-js@2";
import * as jose from "npm:jose@5";

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

// ------------------------------------------------------------ system prompt

const SYSTEM_PROMPT = `You help a person discern patterns in a personal spiritual journal. They track a "thread" — something they sense God may be speaking to them about — and over time they receive daily devotional entries (each built on one scripture passage) and write their own notes.

Your job: read the whole arc of a thread and reflect back what is emerging. You are a discernment companion, NOT an oracle.

If you refer to what they are tracking, call it a "thread", never a "topic".

Non-negotiable guardrails:
1. NEVER tell the person what God is saying, what to decide, or what will happen. No directive or predictive claims about their life. Offer observations and questions: "a thread that keeps returning is...", "you might sit with...".
2. Work from the references and the person's own notes. Do not invent scripture, quotes, or events. You may name a passage's reference but do not fabricate its wording.
3. Name real tension honestly and pastorally. If their notes and the entries pull in different directions, or if they seem to be avoiding something, say so gently — discernment needs friction, not just affirmation.
4. Broadly orthodox, non-denominational Christian posture. Avoid partisan or denominationally contentious claims.
5. Keep each item concrete and specific to THIS thread — no generic devotional filler.

Output three things via the tool:
- threads: 2-4 recurring themes you actually see across the entries and notes.
- tensions: 1-3 unresolved questions, tensions, or things left open (may be empty only if truly none).
- next_steps: 2-3 suggested directions for prayer or study (invitational, never commands).

If the kind is "conclusion", frame it as a looking-back reflection on the whole journey, honouring where the person has arrived without forcing a neat resolution.`;

const SYNTHESIS_TOOL = {
  name: "record_synthesis",
  description: "Record the thread synthesis in structured form.",
  input_schema: {
    type: "object",
    additionalProperties: false,
    required: ["threads", "tensions", "next_steps"],
    properties: {
      threads: {
        type: "array",
        minItems: 1,
        maxItems: 4,
        items: { type: "string" },
        description: "Recurring themes seen across entries and notes",
      },
      tensions: {
        type: "array",
        minItems: 0,
        maxItems: 3,
        items: { type: "string" },
        description: "Unresolved questions or tensions",
      },
      next_steps: {
        type: "array",
        minItems: 2,
        maxItems: 3,
        items: { type: "string" },
        description: "Invitational directions for prayer or study",
      },
    },
  },
};

// ---------------------------------------------------------------- claude

async function callClaude(userPrompt: string): Promise<{
  threads: string[];
  tensions: string[];
  next_steps: string[];
}> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 1536,
      system: SYSTEM_PROMPT,
      tools: [SYNTHESIS_TOOL],
      tool_choice: { type: "tool", name: "record_synthesis" },
      messages: [{ role: "user", content: userPrompt }],
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Anthropic API ${res.status}: ${body.slice(0, 500)}`);
  }
  const data = await res.json();
  const toolUse = (data.content ?? []).find(
    (b: { type: string }) => b.type === "tool_use",
  );
  if (!toolUse?.input) throw new Error("No tool_use block in model response");

  const raw = toolUse.input as Record<string, unknown>;
  const arr = (x: unknown, min: number): string[] => {
    const list = Array.isArray(x)
      ? x.map((s) => String(s).trim()).filter(Boolean)
      : [];
    if (list.length < min) throw new Error("Synthesis missing required fields");
    return list;
  };
  return {
    threads: arr(raw.threads, 1),
    tensions: Array.isArray(raw.tensions)
      ? (raw.tensions as unknown[]).map((s) => String(s).trim()).filter(Boolean)
      : [],
    next_steps: arr(raw.next_steps, 2),
  };
}

// deno-lint-ignore no-explicit-any
function buildPrompt(topic: any, entries: any[], notes: any[], kind: string): string {
  const entryBlock = entries.length
    ? entries
        .map(
          (e) =>
            `- ${e.date} [${e.entry_type}] ${e.verse_ref}: ${String(e.thought).slice(0, 200)}`,
        )
        .join("\n")
    : "(no entries yet)";
  const noteBlock = notes.length
    ? notes
        .map((n) => `- ${String(n.created_at).slice(0, 10)}: ${String(n.body).slice(0, 400)}`)
        .join("\n")
    : "(no notes written yet)";

  return `SYNTHESIS KIND: ${kind}

THREAD: ${topic.title}
THE PERSON'S OWN WORDS ABOUT IT: ${topic.description || "(none provided)"}
${
  topic.seed_verse_ref
    ? `THE PASSAGE THAT STARTED IT: ${topic.seed_verse_ref} — "${String(topic.seed_verse_text ?? "").slice(0, 600)}"
Compare where they started with where the arc has actually gone. If the thread has drifted from this passage, or if the passage now reads differently in light of the notes, that is worth naming.`
    : "THE PASSAGE THAT STARTED IT: (none given)"
}

DAILY ENTRIES SO FAR (reference + the entry's thought; ${entries.length} total):
${entryBlock}

THE PERSON'S NOTES (their own reflections, chronological; ${notes.length} total):
${noteBlock}

Read the whole arc and call record_synthesis exactly once. Ground every item in what you actually see above — name specific threads, real tensions, and invitational next steps.`;
}

// ------------------------------------------------------------------ auth

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

async function authorize(
  req: Request,
  db: SupabaseClient,
): Promise<{ role: "service" } | { role: "user"; userId: string } | null> {
  const auth = req.headers.get("authorization") ?? "";
  const token = auth.replace(/^Bearer\s+/i, "").trim();
  if (!token) return null;
  if (token === SERVICE_KEY) return { role: "service" };
  {
    const role = await verifyPlatformJwt(token);
    if (role && SERVICE_ROLES.has(role)) return { role: "service" };
  }
  if (token.startsWith("sb_secret_")) {
    const probe = createClient(SUPABASE_URL, token, {
      auth: { persistSession: false },
    });
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

  const db = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false },
  });

  const who = await authorize(req, db);
  if (!who) return json(401, { error: "Unauthorized" });

  let body: { topic_id?: string; kind?: string } = {};
  try {
    body = await req.json();
  } catch {
    return json(400, { error: "Invalid JSON body" });
  }
  if (!body.topic_id) return json(400, { error: "topic_id is required" });
  const kind = body.kind === "conclusion" ? "conclusion" : "on_demand";

  // Load the topic (scoped to the user when a user token is used).
  let topicQuery = db
    .from("topics")
    .select("id, user_id, title, description, seed_verse_ref, seed_verse_text")
    .eq("id", body.topic_id);
  if (who.role === "user") topicQuery = topicQuery.eq("user_id", who.userId);
  const { data: topic, error: topicErr } = await topicQuery.maybeSingle();
  if (topicErr) return json(500, { error: topicErr.message });
  if (!topic) return json(404, { error: "Thread not found" });

  const [{ data: entries }, { data: notes }] = await Promise.all([
    db
      .from("daily_entries")
      .select("date, verse_ref, thought, entry_type")
      .eq("topic_id", topic.id)
      .order("date", { ascending: true }),
    db
      .from("notes")
      .select("body, created_at")
      .eq("topic_id", topic.id)
      .order("created_at", { ascending: true }),
  ]);

  if (!entries?.length && !notes?.length) {
    return json(422, {
      error: "Nothing to synthesize yet — no entries or notes on this thread.",
    });
  }

  let content;
  try {
    content = await callClaude(
      buildPrompt(topic, entries ?? [], notes ?? [], kind),
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await db.from("generation_failures").insert({
      topic_id: topic.id,
      user_id: topic.user_id,
      stage: "synthesis",
      detail: { error: msg },
    });
    return json(502, { error: `Synthesis failed: ${msg}` });
  }

  // Footnote provenance. Computed here from what we actually sent the model —
  // never asked of the model, so it cannot be embellished. Refs come straight
  // off the stored entries, which were themselves validated at generation time.
  const sourceRefs = [...new Set((entries ?? []).map((e) => String(e.verse_ref)))];
  const dates = (entries ?? []).map((e) => String(e.date)).sort();
  const sources = {
    entry_refs: sourceRefs,
    entry_count: entries?.length ?? 0,
    note_count: notes?.length ?? 0,
    first_entry_date: dates[0] ?? null,
    last_entry_date: dates[dates.length - 1] ?? null,
    model: MODEL,
  };

  const { data: inserted, error: insErr } = await db
    .from("syntheses")
    .insert({
      topic_id: topic.id,
      user_id: topic.user_id,
      kind,
      content: { ...content, sources },
    })
    .select()
    .single();
  if (insErr) return json(500, { error: insErr.message });

  return json(200, { synthesis: inserted });
});
