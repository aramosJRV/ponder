// Preview Meditate phrases for real pool passages WITHOUT deploying or
// writing anything. Uses the exact prompt and verification that ship
// (supabase/functions/generate-entry/meditation.ts).
//
// Reads passages through the logged-in Supabase CLI (read-only SELECTs) and
// calls Anthropic with ANTHROPIC_API_KEY from your own shell environment.
//
//   ANTHROPIC_API_KEY=... deno run --no-lock --node-modules-dir=none -A scripts/meditation-preview.ts [count]

import {
  MEDITATION_TRANSLATIONS,
  type MeditationTexts,
  meditationRequest,
  parseMeditation,
} from "../supabase/functions/generate-entry/meditation.ts";

const KEY = Deno.env.get("ANTHROPIC_API_KEY");
if (!KEY) {
  console.error("Set ANTHROPIC_API_KEY in this shell first.");
  Deno.exit(1);
}
const MODEL = Deno.env.get("ANTHROPIC_MODEL_AFFIRMING") ?? "claude-haiku-4-5-20251001";
const COUNT = Number(Deno.args[0] ?? 8);

async function sql(query: string): Promise<Record<string, unknown>[]> {
  const out = await new Deno.Command("supabase", {
    args: ["db", "query", "--linked", query],
    stdout: "piped",
    stderr: "null",
  }).output();
  const txt = new TextDecoder().decode(out.stdout);
  return JSON.parse(txt.slice(txt.indexOf("{"))).rows ?? [];
}

const passages = await sql(
  `select distinct on (verse_ref) verse_ref, book_number, chapter, verse_start, verse_end
   from (select * from entry_pool where not retired order by created_at desc limit 200) p
   order by verse_ref, random() limit ${COUNT}`,
);

for (const p of passages) {
  const rows = await sql(
    `select translation, string_agg(text, ' ' order by verse) as text from bible_verses
     where book_number = ${p.book_number} and chapter = ${p.chapter}
       and verse between ${p.verse_start} and ${p.verse_end}
       and translation in ('WEB','BSB','KJV')
     group by translation`,
  );
  const texts: MeditationTexts = {};
  for (const r of rows) texts[r.translation as keyof MeditationTexts] = String(r.text);

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify(meditationRequest(MODEL, String(p.verse_ref), texts)),
  });
  const data = await res.json();
  const toolUse = (data.content ?? []).find((b: { type: string }) => b.type === "tool_use");
  const kept = parseMeditation(toolUse?.input, texts);

  console.log(`\n=== ${p.verse_ref} ===`);
  for (const t of MEDITATION_TRANSLATIONS) {
    if (!texts[t]) continue;
    const asked = ((toolUse?.input ?? {})[t] ?? []) as string[];
    const got = kept?.[t] ?? [];
    const dropped = asked.filter((a) => !got.some((g) => g.toLowerCase() === a.trim().toLowerCase()));
    console.log(`${t}: ${texts[t]}`);
    console.log(`   walk:    ${got.length ? got.join("  →  ") : "(no Meditate for this version)"}`);
    if (dropped.length) console.log(`   dropped: ${dropped.join(" | ")}`);
  }
}
