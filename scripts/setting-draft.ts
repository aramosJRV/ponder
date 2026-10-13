// Draft, check and package "The setting" — the historical background sheet.
//
// Runs on your Mac, never in the app. Nothing here writes to the database:
// the output is files a person reads first.
//
//   1. Draft + check (resumable: books already in content/setting/ are skipped)
//        ANTHROPIC_API_KEY=... deno run --no-lock --node-modules-dir=none -A scripts/setting-draft.ts [bookNumber ...]
//   1b. Apply the check's clear fixes, then check again (books with flags only)
//        ANTHROPIC_API_KEY=... deno run --no-lock --node-modules-dir=none -A scripts/setting-draft.ts --fix
//   2. Review page for a person: content/setting/review.md
//        deno run --no-lock --node-modules-dir=none -A scripts/setting-draft.ts --report
//   3. After approval, the content migration loaded with `supabase db push`
//        deno run --no-lock --node-modules-dir=none -A scripts/setting-draft.ts --sql
//
// Each book is one draft call (book background + passage notes) and one
// separate checking call that flags doubtful claims for a person to look at.
// Corrections are made by editing the JSON in content/setting/ by hand.

import Anthropic from "npm:@anthropic-ai/sdk";
import { BOOKS } from "./lib/books.mjs";

const DIR = "content/setting";
const MODEL = "claude-opus-5-5";
const SAMPLE = 50;

type Book = { n: number; name: string; testament: string };
type Passage = { start: string; label: string };
type Flag = { where: string; problem: string; suggestion: string };
type Setting = {
  book_number: number;
  name: string;
  author: string;
  audience: string;
  era: string;
  /** Keyed by pericope start, "chapter:verse". Most passages are absent. */
  notes: Record<string, string>;
  flags: Flag[];
  /** Set by --fix: flags it left for a person, with why. */
  unsure?: Flag[];
  fixed?: boolean;
};

const pad = (n: number) => String(n).padStart(2, "0");
const fileFor = (n: number) => `${DIR}/${pad(n)}.json`;

async function sql(query: string): Promise<Record<string, unknown>[]> {
  // Same pinned-format read as scripts/meditation-preview.ts.
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

// Fetched once, before any book starts: concurrent `supabase db query` calls
// race on the CLI's temporary login role and fail.
let allRows: Record<string, unknown>[] | null = null;

async function passages(book: Book): Promise<Passage[]> {
  allRows ??= await sql(
    `select book_number, start_chapter, start_verse, end_chapter, end_verse
     from bible_pericope_ranges order by book_number, start_ord`,
  );
  const rows = allRows.filter((r) => Number(r.book_number) === book.n);
  return rows.map((r) => {
    const [sc, sv, ec, ev] = [r.start_chapter, r.start_verse, r.end_chapter, r.end_verse];
    const end = sc === ec ? `${ev}` : `${ec}:${ev}`;
    return { start: `${sc}:${sv}`, label: `${sc}:${sv}–${end}` };
  });
}

// ------------------------------------------------------------------ prompts

const VOICE = `You write "The setting" for Ponder, a daily devotional app. Readers are ordinary Christians reading one verse a day, not scholars. They tap "The setting" to learn who wrote the passage, who first heard it, and what was happening at the time.

Rules:
- Plain, warm, concrete English. Explain any term a churchgoer might not know. No academic jargon.
- Describe the setting only. Never say what a passage means, what it teaches, or how to apply it. No sermonising.
- Do not quote scripture.
- Where scholars genuinely disagree (authorship, date), say so in a short clause: give the traditional view and the main alternative fairly, dismissive of neither.
- Approximate dates are fine ("around 700 BC"). Use BC and AD.
- Never invent specifics. If you are not confident of a detail, leave it out.`;

const DRAFT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["author", "audience", "era", "notes"],
  properties: {
    author: { type: "string" },
    audience: { type: "string" },
    era: { type: "string" },
    notes: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["start", "note"],
        properties: { start: { type: "string" }, note: { type: "string" } },
      },
    },
  },
};

const CHECK_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["flags"],
  properties: {
    flags: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["where", "problem", "suggestion"],
        properties: {
          where: { type: "string" },
          problem: { type: "string" },
          suggestion: { type: "string" },
        },
      },
    },
  },
};

function draftPrompt(book: Book, list: Passage[]): string {
  return `Book: ${book.name}

Write three fields for the whole book:
- author: who wrote it — their background and their job or role (king, prophet, fisherman, doctor…). 2–4 sentences.
- audience: who first heard or read it, and their situation. 2–3 sentences.
- era: what was happening then — culture, politics, major events around the writer. 2–4 sentences.

Then notes: for the passages below, add a note ONLY where something specific about that passage's setting is known or widely held and is not already covered by the book fields — for example a psalm's heading linking it to an event, a dated prophecy, a named occasion, place or ruler, or the situation a letter section answers. One sentence, at most 30 words. If a heading is the only source, say "traditionally" or "the heading links it to…". Skip every other passage: where the story itself sets the scene, no note is needed. Most passages in narrative books should have no note.

Use the passage's start reference exactly as given (the part before the dash) for "start".

Passages:
${list.map((p) => p.label).join("\n")}`;
}

const FIX_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["author", "audience", "era", "notes", "unsure"],
  properties: {
    ...DRAFT_SCHEMA.properties,
    unsure: CHECK_SCHEMA.properties.flags,
  },
};

function fixPrompt(book: Book, s: Setting): string {
  const { flags, ...draft } = s;
  return `Below is "The setting" for ${book.name} and a fact-checker's flags on it.

Apply each flag's fix where it is clearly right. You may word the fix better than the suggestion. If a flag is mistaken, or the fix is a judgement call a person should make, leave that text as it is and list it under "unsure": "where" as in the flag, "problem" restating the issue, "suggestion" saying why you didn't apply it.

Change nothing that was not flagged. Return all three book fields and every note (unchanged ones too). To remove a flagged note, leave it out.

Draft:
${JSON.stringify(draft, null, 2)}

Flags:
${JSON.stringify(flags, null, 2)}`;
}

function checkPrompt(book: Book, draft: Omit<Setting, "flags">): string {
  return `You are fact-checking "The setting" for ${book.name} before a person reviews it. Flag anything that:
- is factually wrong or doubtful,
- states a disputed matter (authorship, date, setting) as settled fact,
- interprets, applies or preaches the passage instead of describing its setting,
- quotes scripture, or
- would confuse an ordinary reader.

Do not flag style preferences. An empty list is a good result. "where" is "author", "audience", "era", or a note's start reference.

${JSON.stringify(draft, null, 2)}`;
}

// ------------------------------------------------------------------ draft

const client = new Anthropic();

async function ask<T>(prompt: string, schema: Record<string, unknown>): Promise<T> {
  const stream = client.messages.stream({
    model: MODEL,
    max_tokens: 64000,
    system: VOICE,
    output_config: { effort: "high", format: { type: "json_schema", schema } },
    messages: [{ role: "user", content: prompt }],
  });
  const msg = await stream.finalMessage();
  if (msg.stop_reason !== "end_turn") throw new Error(`stopped: ${msg.stop_reason}`);
  const text = msg.content.find((b) => b.type === "text");
  if (!text || text.type !== "text") throw new Error("no text in response");
  return JSON.parse(text.text) as T;
}

async function draftBook(book: Book): Promise<void> {
  const list = await passages(book);
  const valid = new Set(list.map((p) => p.start));
  const raw = await ask<{ author: string; audience: string; era: string; notes: { start: string; note: string }[] }>(
    draftPrompt(book, list),
    DRAFT_SCHEMA,
  );
  const notes: Record<string, string> = {};
  for (const n of raw.notes) {
    // The model sometimes echoes the whole label ("3:1–7"); the start is before the dash.
    const start = n.start.split(/[–-]/)[0].trim();
    const note = n.note;
    if (valid.has(start) && note.trim()) notes[start] = note.trim();
    else console.warn(`  ${book.name}: dropped note for unknown passage "${start}"`);
  }
  const draft = { book_number: book.n, name: book.name, author: raw.author, audience: raw.audience, era: raw.era, notes };
  const { flags } = await ask<{ flags: Flag[] }>(checkPrompt(book, draft), CHECK_SCHEMA);
  await Deno.writeTextFile(fileFor(book.n), JSON.stringify({ ...draft, flags }, null, 2) + "\n");
  console.log(`${book.name}: ${Object.keys(notes).length}/${list.length} notes, ${flags.length} flagged`);
}

async function fixBook(book: Book): Promise<void> {
  const s: Setting = JSON.parse(await Deno.readTextFile(fileFor(book.n)));
  if (s.fixed || !s.flags.length) return;
  const raw = await ask<{ author: string; audience: string; era: string; notes: { start: string; note: string }[]; unsure: Flag[] }>(
    fixPrompt(book, s),
    FIX_SCHEMA,
  );
  const flaggedAt = new Set(s.flags.map((f) => f.where));
  const notes: Record<string, string> = {};
  for (const n of raw.notes) {
    if (!(n.start in s.notes)) continue; // fixes edit or remove notes, never add them
    notes[n.start] = n.note.trim();
  }
  // Guard against silent rewrites: anything unflagged that changed is put back.
  for (const [k, v] of Object.entries(s.notes)) {
    if (!flaggedAt.has(k) && notes[k] !== v) notes[k] = v;
  }
  const keep = (k: "author" | "audience" | "era") => (flaggedAt.has(k) ? raw[k] : s[k]);
  const draft = { book_number: s.book_number, name: s.name, author: keep("author"), audience: keep("audience"), era: keep("era"), notes };
  const { flags } = await ask<{ flags: Flag[] }>(checkPrompt(book, draft), CHECK_SCHEMA);
  await Deno.writeTextFile(
    fileFor(book.n),
    JSON.stringify({ ...draft, flags, unsure: raw.unsure, fixed: true }, null, 2) + "\n",
  );
  console.log(`${book.name}: ${s.flags.length} flags → ${raw.unsure.length} left for you, ${flags.length} new from the re-check`);
}

async function readAll(): Promise<Setting[]> {
  const all: Setting[] = [];
  for (const b of BOOKS as Book[]) {
    try {
      all.push(JSON.parse(await Deno.readTextFile(fileFor(b.n))));
    } catch {
      /* not drafted yet */
    }
  }
  return all;
}

// ------------------------------------------------------------------ report

// Fixed seed so the sample doesn't change between runs of --report.
function sample<T>(items: T[], k: number): T[] {
  let s = 20261012;
  const rand = () => ((s = (s * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, k);
}

async function report(): Promise<void> {
  const all = await readAll();
  const flagged = all.flatMap((s) => [...(s.unsure ?? []), ...s.flags].map((f) => ({ s, f })));
  const flaggedKeys = new Set(flagged.map(({ s, f }) => `${s.book_number}|${f.where}`));
  const notes = all.flatMap((s) => Object.entries(s.notes).map(([start, note]) => ({ s, start, note })));
  const picked = sample(notes.filter(({ s, start }) => !flaggedKeys.has(`${s.book_number}|${start}`)), SAMPLE);
  const quote = (where: string, s: Setting) =>
    where in s.notes ? s.notes[where] : (s as unknown as Record<string, string>)[where] ?? "(not found)";

  const out = [
    `# The setting — review`,
    ``,
    `${all.length} of 66 books drafted · ${notes.length} passage notes · ${flagged.length} flagged by the check.`,
    ``,
    `Read: every book below, every flagged item, and the random sample.`,
    ``,
    `## For you to decide`,
    ``,
    `What the fix step left alone, then anything the re-check found.`,
    ``,
    ...flagged.flatMap(({ s, f }) => [
      `**${s.name} — ${f.where}**`,
      `> ${quote(f.where, s)}`,
      ``,
      `- Problem: ${f.problem}`,
      `- Suggested: ${f.suggestion}`,
      ``,
    ]),
    `## Random sample of passage notes`,
    ``,
    ...picked.map(({ s, start, note }) => `- **${s.name} ${start}** — ${note}`),
    ``,
    `## Books`,
    ``,
    ...all.flatMap((s) => [
      `### ${s.name}`,
      ``,
      `**Who wrote it.** ${s.author}`,
      ``,
      `**Who first heard it.** ${s.audience}`,
      ``,
      `**What was happening.** ${s.era}`,
      ``,
    ]),
  ];
  await Deno.writeTextFile(`${DIR}/review.md`, out.join("\n"));
  console.log(`Wrote ${DIR}/review.md`);
}

// ------------------------------------------------------------------ sql

async function toSql(): Promise<void> {
  const all = await readAll();
  if (all.length !== 66) throw new Error(`only ${all.length} of 66 books drafted`);
  const lit = (t: string) => `'${t.replace(/'/g, "''")}'`;
  const lines = [
    `-- "The setting" content. Generated by scripts/setting-draft.ts --sql from`,
    `-- the reviewed files in ${DIR}/. Edit those, not this.`,
    ``,
    `delete from public.bible_pericope_settings;`,
    `delete from public.bible_book_settings;`,
    ``,
    ...all.map((s) =>
      `insert into public.bible_book_settings (book_number, author, audience, era) values (${s.book_number}, ${lit(s.author)}, ${lit(s.audience)}, ${lit(s.era)});`
    ),
    ``,
    ...all.flatMap((s) =>
      Object.entries(s.notes).map(([start, note]) => {
        const [c, v] = start.split(":");
        return `insert into public.bible_pericope_settings (book_number, start_chapter, start_verse, note) values (${s.book_number}, ${c}, ${v}, ${lit(note)});`;
      })
    ),
    ``,
  ];
  const path = "supabase/migrations/20261012000002_the_setting_content.sql";
  await Deno.writeTextFile(path, lines.join("\n"));
  console.log(`Wrote ${path}`);
}

// ------------------------------------------------------------------ main

await Deno.mkdir(DIR, { recursive: true });

async function pool(books: Book[], run: (b: Book) => Promise<void>): Promise<void> {
  // A few books at a time; a failure is logged and the rest carry on.
  // Rerun to pick up whatever failed.
  const queue = [...books];
  await Promise.all(Array.from({ length: 4 }, async () => {
    for (let b = queue.shift(); b; b = queue.shift()) {
      await run(b).catch((e) => console.error(`${b!.name}: FAILED — ${e.message ?? e}`));
    }
  }));
}

if (Deno.args.includes("--fix")) {
  await pool(BOOKS as Book[], fixBook);
  await report();
} else if (Deno.args.includes("--report")) {
  await report();
} else if (Deno.args.includes("--sql")) {
  await toSql();
} else {
  const wanted = Deno.args.map(Number);
  const todo: Book[] = [];
  for (const b of BOOKS as Book[]) {
    if (wanted.length && !wanted.includes(b.n)) continue;
    try {
      await Deno.stat(fileFor(b.n));
    } catch {
      todo.push(b);
    }
  }
  if (todo.length) await passages(todo[0]);
  await pool(todo, draftBook);
  await report();
}
