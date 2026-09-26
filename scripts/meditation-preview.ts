// Preview Meditate phrases for real pool passages WITHOUT deploying or
// writing anything. Uses the exact prompt and verification that ship
// (supabase/functions/generate-entry/meditation.ts).
//
// Reads passages through the logged-in Supabase CLI (read-only SELECTs) and
// calls Anthropic with ANTHROPIC_API_KEY from your own shell environment.
// Each passage is run once per model in MODELS, side by side, so a cheaper
// and a stronger model can be compared on the same text.
//
//   ANTHROPIC_API_KEY=... deno run --no-lock --node-modules-dir=none -A scripts/meditation-preview.ts [ref ...]
//
// With no refs it uses a fixed set, so repeated runs are comparable.

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
const MODELS = (Deno.env.get("MODELS") ?? "claude-haiku-4-5-20251001,claude-sonnet-4-6").split(",");
const REFS = Deno.args.length ? Deno.args : [
  "Proverbs 3:5", "Acts 8:14-16", "Amos 3:8", "Amos 4:12-13", "Deuteronomy 15:7-8",
  "Deuteronomy 8:2-3", "Ecclesiastes 11:4-6", "Ecclesiastes 3:9-11",
];

async function sql(query: string): Promise<Record<string, unknown>[]> {
  // Pin the format: the CLI prints a table to a person's terminal and a
  // wrapped object to an agent, and this script is run by both.
  const out = await new Deno.Command("supabase", {
    args: ["db", "query", "--linked", "--agent", "no", "-o", "json", query],
    stdout: "piped",
    stderr: "piped",
  }).output();
  const txt = new TextDecoder().decode(out.stdout);
  const start = txt.indexOf("[");
  if (!out.success || start < 0) {
    throw new Error(`supabase db query failed:\n${new TextDecoder().decode(out.stderr)}${txt}`);
  }
  return JSON.parse(txt.slice(start));
}

const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;
const coords = await sql(
  `select verse_ref, book_number, chapter, verse_start, verse_end from (
     select distinct on (verse_ref) verse_ref, book_number, chapter, verse_start, verse_end
     from entry_pool where verse_ref in (${REFS.map(lit).join(",")})
     union all
     select 'Proverbs 3:5', 20, 3, 5, 5
   ) x`,
);
const byRef = new Map(coords.map((c) => [String(c.verse_ref), c]));

// Loose key for "was this pick kept?" — the check strips end punctuation and
// stores curly apostrophes, so compare on letters and spaces only.
const loose = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N} ]/gu, "").trim();

for (const ref of REFS) {
  const p = byRef.get(ref);
  if (!p) {
    console.log(`\n=== ${ref} === (not in the pool, skipped)`);
    continue;
  }
  const rows = await sql(
    `select translation, string_agg(text, ' ' order by verse) as text from bible_verses
     where book_number = ${p.book_number} and chapter = ${p.chapter}
       and verse between ${p.verse_start} and ${p.verse_end}
       and translation in ('WEB','BSB','KJV')
     group by translation`,
  );
  const texts: MeditationTexts = {};
  for (const r of rows) texts[r.translation as keyof MeditationTexts] = String(r.text);

  console.log(`\n=== ${ref} ===`);
  console.log(`WEB: ${texts.WEB ?? "(absent)"}`);

  const results = await Promise.all(MODELS.map(async (model) => {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify(meditationRequest(model, ref, texts)),
    });
    const data = await res.json();
    const input = (data.content ?? []).find((b: { type: string }) => b.type === "tool_use")?.input ?? {};
    return { model, input: input as Record<string, string[]>, kept: parseMeditation(input, texts) };
  }));

  for (const t of MEDITATION_TRANSLATIONS) {
    if (!texts[t]) continue;
    for (const { model, input, kept } of results) {
      const got = kept?.[t] ?? [];
      const keptKeys = new Set(got.map(loose));
      const dropped = (input[t] ?? []).filter((a) => !keptKeys.has(loose(String(a))));
      const who = model.includes("haiku") ? "cheaper " : model.includes("sonnet") ? "stronger" : model;
      console.log(`  ${t} ${who}: ${got.length ? got.join("  →  ") : "(no verse walk for this version)"}`);
      if (dropped.length) console.log(`               dropped: ${dropped.join(" | ")}`);
    }
  }
}
