// Book threads, phase 1: write sample book days WITHOUT deploying or writing
// anything to the database. Uses the exact prompt and checker that will ship
// (supabase/functions/generate-entry/book-day.ts), then a second model reads
// each sample against the same guidelines and lists problems.
//
// Reads sections through the logged-in Supabase CLI (SELECT only — sql()
// refuses anything else) and calls Anthropic with ANTHROPIC_API_KEY from the
// shell or .env.
//
//   deno run --no-lock --node-modules-dir=none -A scripts/book-day-preview.ts [spec ...]
//   deno run --no-lock --node-modules-dir=none -A scripts/book-day-preview.ts --check-only
//
// A spec is a book ("Mark" = its first section) or a reference inside a
// section ("Judges 19:22"). --check-only re-runs the machine checks on the
// saved samples and rewrites the report, with no API calls.
// Exit code 0 only when every sample is clean on both passes.

import {
  BOOK_DAY_SYSTEM,
  BOOK_TRANSLATIONS,
  type BookDay,
  bookDayRequest,
  checkBookDay,
  parseBookDay,
  type Section,
  sectionRef,
} from "../supabase/functions/generate-entry/book-day.ts";

const OUT_DIR = new URL("../content/book-threads/", import.meta.url);
const JSON_OUT = new URL("samples.json", OUT_DIR);
const MD_OUT = new URL("samples.md", OUT_DIR);
const WRITER = Deno.env.get("WRITER_MODEL") ?? "claude-opus-5-5";
const REVIEWER = Deno.env.get("REVIEWER_MODEL") ?? "claude-opus-5-5";
const SPECS = [
  "Mark", "Psalms", "Ruth", "Philippians", "Leviticus", "Judges 19:22", "1 Chronicles", "Song of Solomon",
];

type Sample = { section: Section; day: BookDay; machine: string[]; review: string[]; writer: string; reviewer: string };

// ------------------------------------------------------------- database

export function assertReadOnly(query: string) {
  if (!/^\s*(select|with)\b/i.test(query) || /;\s*\S/.test(query)) {
    throw new Error(`refusing non-SELECT query: ${query.slice(0, 80)}`);
  }
}

async function sql(query: string): Promise<Record<string, unknown>[]> {
  assertReadOnly(query);
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

export async function loadSection(spec: string): Promise<Section> {
  const m = spec.match(/^(.+?)\s+(\d+):(\d+)$/);
  const book = m ? m[1] : spec;
  const at = m ? Number(m[2]) * 1000 + Number(m[3]) : 0;
  // Ends are derived from the next start (see the bible_pericopes migration).
  const rows = await sql(
    `with p as (
       select b.book_number, p.start_ord,
              row_number() over (order by p.start_ord) as idx,
              count(*) over () as cnt,
              lead(p.start_ord) over (order by p.start_ord) as next_ord
       from bible_pericopes p join bible_books b using (book_number)
       where b.name = ${lit(book)}
     )
     select p.idx, p.cnt, v.translation, v.chapter, v.verse, v.text
     from p join bible_verses v
       on v.book_number = p.book_number
      and v.chapter * 1000 + v.verse >= p.start_ord
      and (p.next_ord is null or v.chapter * 1000 + v.verse < p.next_ord)
     where v.translation in ('WEB','BSB','KJV')
       and p.idx = coalesce((select max(idx) from p where start_ord <= ${at}), 1)
     order by v.translation, v.chapter, v.verse`,
  );
  if (!rows.length) throw new Error(`no section found for "${spec}"`);
  const web = rows.filter((r) => r.translation === "WEB");
  const first = web[0] ?? rows[0], last = web[web.length - 1] ?? rows[rows.length - 1];
  const texts: Section["texts"] = {};
  for (const t of BOOK_TRANSLATIONS) {
    const vs = rows.filter((r) => r.translation === t);
    if (vs.length) texts[t] = vs.map((r) => String(r.text).trim()).join(" ");
  }
  return {
    book, index: Number(first.idx), count: Number(first.cnt),
    chapter_start: Number(first.chapter), verse_start: Number(first.verse),
    chapter_end: Number(last.chapter), verse_end: Number(last.verse), texts,
  };
}

// ------------------------------------------------------------- model calls

async function loadKey(): Promise<string> {
  const fromShell = Deno.env.get("ANTHROPIC_API_KEY");
  if (fromShell) return fromShell;
  try {
    const env = await Deno.readTextFile(new URL("../.env", import.meta.url));
    const line = env.split("\n").find((l) => l.trim().startsWith("ANTHROPIC_API_KEY="));
    if (line) return line.split("=").slice(1).join("=").trim().replace(/^["']|["']$/g, "");
  } catch { /* no .env */ }
  console.error("Set ANTHROPIC_API_KEY in this shell or in .env first.");
  Deno.exit(1);
}

async function callTool(key: string, body: Record<string, unknown>, tool: string): Promise<unknown> {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "server-side-fallback-2026-07-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({ ...body, fallbacks: "default" }),
    });
    if ((res.status === 429 || res.status >= 500) && attempt < 4) {
      await new Promise((r) => setTimeout(r, 5000 * attempt));
      continue;
    }
    const data = await res.json();
    if (!res.ok) throw new Error(`API ${res.status}: ${JSON.stringify(data).slice(0, 400)}`);
    if (data.stop_reason === "refusal") throw new Error(`refused: ${JSON.stringify(data.stop_details)}`);
    const block = (data.content ?? []).find((b: { type: string; name?: string }) => b.type === "tool_use" && b.name === tool);
    if (!block) throw new Error(`model did not call ${tool} (stop_reason ${data.stop_reason})`);
    return block.input;
  }
}

const REVIEW_TOOL = {
  name: "record_review",
  description: "Record every problem found. An empty list means the reading is clean.",
  strict: true,
  input_schema: {
    type: "object",
    additionalProperties: false,
    required: ["problems"],
    properties: {
      problems: {
        type: "array",
        items: { type: "string" },
        description: "One plain sentence per problem, quoting the words at fault. Empty if none.",
      },
    },
  },
};

const REVIEW_SYSTEM = `You are reviewing a devotional reading written for a slow read-through of a book of the Bible. Below are the exact guidelines the writer was given, between the markers. Check the reading against every one of them, and also check that it describes the passage accurately: nothing the passage does not say, nothing important misread, no factual or theological error.

List only real problems: a broken guideline, an inaccuracy, a claim about the reader's time or progress, belittling or interpretive wording about other peoples or faiths, a verdict about what God is telling the reader, self-improvement, or a hard passage handled glibly. Do not list matters of taste or ways it could be "even better". If there are no real problems, return an empty list.

=== WRITER GUIDELINES ===
${BOOK_DAY_SYSTEM}
=== END GUIDELINES ===

Respond only by calling the record_review tool.`;

function reviewRequest(s: Section, d: BookDay) {
  return {
    model: REVIEWER,
    max_tokens: 16000,
    output_config: { effort: "high" },
    system: REVIEW_SYSTEM,
    tools: [REVIEW_TOOL],
    tool_choice: { type: "auto" },
    messages: [{
      role: "user",
      content:
        `SECTION: ${sectionRef(s)}\n\n` +
        BOOK_TRANSLATIONS.filter((t) => s.texts[t]).map((t) => `${t}:\n${s.texts[t]}`).join("\n\n") +
        `\n\nREADING TO REVIEW:\n${JSON.stringify(d, null, 2)}`,
    }],
  };
}

// ------------------------------------------------------------- report

function render(samples: Sample[]): string {
  const clean = samples.filter((s) => !s.machine.length && !s.review.length).length;
  const lines = [
    `# Book threads: sample readings`,
    ``,
    `Generated by \`scripts/book-day-preview.ts\`. Nothing was written to the database.`,
    `Writer: ${samples[0]?.writer ?? "?"} · Reviewer: ${samples[0]?.reviewer ?? "?"}`,
    ``,
    `## Check results: ${clean} of ${samples.length} clean`,
    ``,
    `| Section | Machine checks | Reviewer |`,
    `|---|---|---|`,
    ...samples.map((s) =>
      `| ${sectionRef(s.section)} (section ${s.section.index} of ${s.section.count}) | ` +
      `${s.machine.length ? `${s.machine.length} problem(s)` : "pass"} | ` +
      `${s.review.length ? `${s.review.length} problem(s)` : "pass"} |`
    ),
    ``,
    `Machine checks: all parts present, length limits, key verse inside the section, quotes word-for-word in WEB, BSB and KJV, no time-on-thread wording, no belittling or other-faith words, no "God is telling you", no "thread", no formatting.`,
    ``,
  ];
  for (const s of samples) {
    const k = s.day.key_verse;
    lines.push(
      `---`, ``,
      `## ${sectionRef(s.section)}`,
      `*${s.section.book} · section ${s.section.index} of ${s.section.count} · key verse ${s.section.book} ${k.chapter}:${k.verse_start}${k.verse_end !== k.verse_start ? `-${k.verse_end}` : ""}*`,
      ``,
      `<details><summary>Passage (WEB)</summary>`, ``, s.section.texts.WEB ?? "", ``, `</details>`, ``,
      `**Thought**`, ``, s.day.thought, ``,
      `**Illustration**`, ``, s.day.illustration, ``,
      `**Ponder**`, ``, ...s.day.ponder.map((q) => `- ${q}`), ``,
      `**Prayer**`, ``, ...s.day.prayer_prompts.map((q) => `- ${q}`), ``,
      `**Checks:** machine ${s.machine.length ? "" : "pass"}${s.machine.map((x) => `\n- ${x}`).join("")}`,
      ``,
      `reviewer ${s.review.length ? "" : "pass"}${s.review.map((x) => `\n- ${x}`).join("")}`,
      ``,
    );
  }
  return lines.join("\n");
}

// ------------------------------------------------------------- main

if (import.meta.main) {
  let samples: Sample[];
  if (Deno.args.includes("--check-only")) {
    samples = JSON.parse(await Deno.readTextFile(JSON_OUT));
    for (const s of samples) s.machine = checkBookDay(s.day, s.section);
  } else {
    const key = await loadKey();
    const specs = Deno.args.length ? Deno.args : SPECS;
    samples = await Promise.all(specs.map(async (spec) => {
      const section = await loadSection(spec);
      const day = parseBookDay(await callTool(key, bookDayRequest(WRITER, section), "record_book_day"));
      const machine = checkBookDay(day, section);
      const review = ((await callTool(key, reviewRequest(section, day), "record_review")) as { problems?: string[] })
        .problems ?? [];
      console.log(`${sectionRef(section)}: machine ${machine.length}, reviewer ${review.length}`);
      return { section, day, machine, review, writer: WRITER, reviewer: REVIEWER };
    }));
    await Deno.mkdir(OUT_DIR, { recursive: true });
    await Deno.writeTextFile(JSON_OUT, JSON.stringify(samples, null, 2));
  }
  await Deno.writeTextFile(MD_OUT, render(samples));
  for (const s of samples) {
    for (const x of s.machine) console.log(`  [machine] ${sectionRef(s.section)}: ${x}`);
    for (const x of s.review) console.log(`  [review]  ${sectionRef(s.section)}: ${x}`);
  }
  const dirty = samples.filter((s) => s.machine.length || s.review.length).length;
  console.log(`\n${samples.length - dirty} of ${samples.length} clean. Report: content/book-threads/samples.md`);
  Deno.exit(dirty ? 1 : 0);
}
