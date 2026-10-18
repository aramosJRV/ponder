// Proves checkBookDay catches each thing it claims to. No network.
//   deno test --no-lock --node-modules-dir=none supabase/functions/generate-entry/book-day.test.ts

import { type BookDay, checkBookDay, parseBookDay, type Section } from "./book-day.ts";

const SECTION: Section = {
  book: "Ruth", index: 1, count: 9,
  chapter_start: 1, verse_start: 1, chapter_end: 1, verse_end: 5,
  texts: {
    WEB: "In the days when the judges judged, there was a famine in the land. A certain man of Bethlehem Judah went to live in the country of Moab with his wife and his two sons.",
    BSB: "In the days when the judges ruled, there was a famine in the land. And a certain man from Bethlehem in Judah, with his wife and two sons, went to reside in the land of Moab.",
    KJV: "Now it came to pass in the days when the judges ruled, that there was a famine in the land. And a certain man of Bethlehemjudah went to sojourn in the country of Moab, he, and his wife, and his two sons.",
  },
};

const pad = (n: number) => Array.from({ length: n }, () => "word").join(" ");
const GOOD: BookDay = {
  key_verse: { chapter: 1, verse_start: 1, verse_end: 2 },
  thought: `A famine drives a family out of "the land" and into Moab. ${pad(140)}`,
  illustration: `Imagine a door closing behind a family. ${pad(100)}`,
  ponder: ["Where do you look when the ground gives way?", "What would it cost to stay?"],
  prayer_prompts: ["Bring to God whatever feels like famine.", "Ask for eyes to see his care in hard places."],
};
const bad = (patch: Partial<BookDay>) => checkBookDay({ ...GOOD, ...patch }, SECTION);

function expectCaught(name: string, problems: string[], needle: string) {
  if (!problems.some((x) => x.includes(needle))) {
    throw new Error(`${name}: expected a problem containing "${needle}", got ${JSON.stringify(problems)}`);
  }
}

Deno.test("a good sample passes", () => {
  const p = checkBookDay(GOOD, SECTION);
  if (p.length) throw new Error(JSON.stringify(p));
});

Deno.test("a time word that is in the passage is allowed", () => {
  const p = bad({ thought: `In the days of the judges, a famine. ${pad(140)}` });
  if (p.length) throw new Error(JSON.stringify(p));
});

Deno.test("catches missing parts (empty tool input)", () => {
  const p = checkBookDay(parseBookDay({}), SECTION);
  for (const n of ["thought is 0", "illustration is 0", "0 ponder", "0 prayer", "key verse is missing"]) {
    expectCaught("empty", p, n);
  }
});

Deno.test("catches length limits", () => {
  expectCaught("short", bad({ thought: pad(50) }), "thought is 50 words");
  expectCaught("long", bad({ illustration: pad(400) }), "illustration is 400 words");
  expectCaught("4 ponder", bad({ ponder: ["a?", "b?", "c?", "d?"] }), "4 ponder");
  expectCaught("no ?", bad({ ponder: ["A statement.", "b?"] }), 'does not end with "?"');
  expectCaught("long prayer", bad({ prayer_prompts: [pad(40), "b"] }), "prayer line over");
});

Deno.test("catches a key verse outside the section or too long", () => {
  expectCaught("outside", bad({ key_verse: { chapter: 1, verse_start: 8, verse_end: 8 } }), "outside");
  expectCaught("other chapter", bad({ key_verse: { chapter: 2, verse_start: 1, verse_end: 1 } }), "outside");
  expectCaught("span", bad({ key_verse: { chapter: 1, verse_start: 1, verse_end: 5 } }), "spans 5");
});

Deno.test("catches quotes that differ between translations (hard rule 4)", () => {
  expectCaught("WEB-only", bad({ thought: `He went "to live in the country of Moab". ${pad(140)}` }), "not word-for-word in BSB, KJV");
  expectCaught("invented", bad({ thought: `“The Lord is my shepherd” ${pad(140)}` }), "not word-for-word");
});

Deno.test("catches time-on-thread wording (hard rule 6)", () => {
  expectCaught("today", bad({ prayer_prompts: ["Pray about today.", "b"] }), 'time word "today"');
  expectCaught("week", bad({ illustration: `Imagine a week of rain. ${pad(100)}` }), 'time word "week"');
  expectCaught("so far", bad({ ponder: ["What have you noticed so far?", "b?"] }), "so far");
  expectCaught("you've been", bad({ ponder: ["You've been reading Ruth; what stands out?", "b?"] }), "you'?ve been");
  expectCaught("journey", bad({ thought: `On this journey through Ruth. ${pad(140)}` }), 'time word "journey"');
  expectCaught("curly", bad({ ponder: ["As we’ve seen, what now?", "b?"] }), "as we'?ve seen");
});

Deno.test("catches belittling or other-faith wording", () => {
  expectCaught("pagan", bad({ thought: `Moab was a pagan land. ${pad(140)}` }), '"pagan"');
  expectCaught("jews", bad({ thought: `Unlike the Jews of later times. ${pad(140)}` }), '"jews"');
  expectCaught("legalism", bad({ illustration: `Imagine legalism. ${pad(100)}` }), '"legalism"');
});

Deno.test("catches verdicts, the word thread, and formatting", () => {
  expectCaught("verdict", bad({ thought: `God is telling you to move. ${pad(140)}` }), "what God is saying");
  expectCaught("thread", bad({ ponder: ["How does this touch your thread?", "b?"] }), '"thread"');
  expectCaught("bold", bad({ thought: `**Famine** ${pad(140)}` }), "formatting");
});
