// guardrail-preview — THROWAWAY. Dry-run comparison of the old vs proposed
// guardrail 4 wording for one thread. Writes NOTHING to the database.
// Service secret key only. Delete after the guardrail decision is made.

import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
const MODEL = "claude-haiku-4-5-20251001"; // what affirming entries really use

const OLD_G4 = `4. Broadly orthodox, non-denominational Christian posture. Avoid partisan politics and denominationally contentious claims (e.g. modes of baptism, predestination debates) unless the thread explicitly invites them.`;
const NEW_G4 = `4. Broadly orthodox, non-denominational Christian posture. Cover the full breadth of what Scripture says about the thread's subject, including its demanding and stirring parts, not only the gentlest reading. Where Christians genuinely disagree (e.g. baptism, predestination, which spiritual gifts continue today), you may describe the question and the views Christians have held, but never decide it for the reader. Avoid partisan politics.`;

const BASE = `You write daily devotional entries for a personal discernment journal. The user tracks "threads" — things they sense God may be speaking to them about — and your entries are material for their reflection and discernment, never verdicts.

Non-negotiable guardrails:
1. NEVER claim God is telling the user something, and never make predictive or directive claims about their life decisions. Frame everything as invitation to reflect: "consider", "notice", "sit with".
2. Scripture must be handled in context. Do not proof-text: never use a verse fragment against the meaning of its surrounding passage. Choose passages whose actual context genuinely relates to the thread.
3. Illustrations must be either clearly framed as hypothetical/analogy or verifiably true and commonly known. NEVER invent quotes, statistics, or historical anecdotes presented as fact.
__G4__
5. Do NOT reproduce the passage as a full quotation — quote at most a short distinctive phrase.
6. NEVER state or imply how long the person has been on this thread.

affirming: sits inside the user's sense of the thread and deepens it. Write from availability and unhurry. Prefer one concrete thing to a general principle. Do not promise outcomes.

Never write self-improvement. Choose ONE passage (1-3 consecutive verses) not on the do-not-use list. Prefer variety across the whole canon over famous verses.`;

const TOOL = {
  name: "record_devotional",
  description: "Record the entry.",
  input_schema: {
    type: "object",
    required: ["book", "chapter", "verse_start", "verse_end", "thought", "illustration"],
    properties: {
      book: { type: "string", description: "WEB book name, e.g. 'Psalms'" },
      chapter: { type: "integer" },
      verse_start: { type: "integer" },
      verse_end: { type: "integer" },
      thought: { type: "string", description: "80-150 word reflection" },
      illustration: { type: "string", description: "100-180 word illustration" },
    },
  },
};

async function one(system: string, user: string) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: MODEL, max_tokens: 1500, system, tools: [TOOL], tool_choice: { type: "tool", name: "record_devotional" }, messages: [{ role: "user", content: user }] }),
  });
  if (!res.ok) return { error: `${res.status} ${(await res.text()).slice(0, 200)}` };
  const data = await res.json();
  const b = (data.content ?? []).find((x: { type: string }) => x.type === "tool_use");
  return b?.input ?? { error: "no tool_use" };
}

Deno.serve(async (req) => {
  const token = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  if (!token.startsWith("sb_secret_")) return new Response("Unauthorized", { status: 401 });
  const db = createClient(SUPABASE_URL, token, { auth: { persistSession: false } });
  const probe = await db.from("bible_books").select("book_number").limit(1);
  if (probe.error) return new Response("Unauthorized", { status: 401 });

  const { topic_id } = await req.json();
  const { data: topic } = await db.from("topics").select("title, description").eq("id", topic_id).single();
  const { data: tt } = await db.from("topic_themes").select("facets").eq("topic_id", topic_id).single();
  const { data: used } = await db.from("daily_entries").select("verse_ref, facet").eq("topic_id", topic_id);
  const usedFacets = new Set((used ?? []).map((u) => u.facet).filter(Boolean));
  const facets = ((tt?.facets ?? []) as Array<{ slug: string; label: string; brief: string }>)
    .filter((f) => !usedFacets.has(f.slug)).slice(0, 3);
  const avoid = (used ?? []).map((u) => u.verse_ref).join("; ") || "(none)";

  const jobs: Promise<Record<string, unknown>>[] = [];
  for (const f of facets) {
    const user = `THREAD: ${topic?.title}\nUSER'S OWN WORDS ABOUT IT: ${topic?.description ?? "(none)"}\n\nENTRY TYPE FOR TODAY: affirming\n\nTODAY'S SIDE OF THIS THREAD: ${f.label}\n${f.brief}\nWrite about THIS side specifically. Never name it.\n\nDO NOT USE: ${avoid}\n\nCall record_devotional exactly once.`;
    for (const variant of ["old", "new"]) {
      const system = BASE.replace("__G4__", variant === "old" ? OLD_G4 : NEW_G4);
      jobs.push(one(system, user).then(async (out: Record<string, unknown>) => {
        let verse_text: string | null = null;
        if (out.book) {
          const { data } = await db.rpc("resolve_verse_ref", { p_book: out.book, p_chapter: out.chapter, p_verse_start: out.verse_start, p_verse_end: out.verse_end ?? out.verse_start });
          verse_text = (data ?? []).map((v: { text: string }) => v.text).join(" ") || null;
        }
        return { facet: f.label, variant, ref: `${out.book} ${out.chapter}:${out.verse_start}-${out.verse_end}`, verse_text, thought: out.thought, illustration: out.illustration, error: out.error };
      }));
    }
  }
  const results = await Promise.all(jobs);
  return new Response(JSON.stringify({ results }), { headers: { "content-type": "application/json" } });
});
