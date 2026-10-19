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

// ------------------------------------------------ the write/check/fix loop

import { writeCheckedBookDay } from "./book-day.ts";

/** A fake model: hands back scripted tool inputs in order and records requests. */
function fakeModel(script: unknown[]) {
  const seen: { tool: string; body: Record<string, unknown> }[] = [];
  const call = (body: Record<string, unknown>, tool: string) => {
    seen.push({ tool, body });
    if (!script.length) throw new Error("fake model ran out of answers");
    return Promise.resolve(script.shift());
  };
  return { call, seen };
}
const asInput = (d: BookDay) => ({
  key_verse: d.key_verse, thought: d.thought, illustration: d.illustration,
  ponder_1: d.ponder[0], ponder_2: d.ponder[1], prayer_1: d.prayer_prompts[0], prayer_2: d.prayer_prompts[1],
});
const OPTS = { writer: "w", reviewer: "r" };

Deno.test("loop: clean first time -> one write, one review, no fix-up", async () => {
  const m = fakeModel([asInput(GOOD), { problems: [] }]);
  const r = await writeCheckedBookDay(SECTION, m.call, OPTS);
  if (!r.clean || r.fixed.length || m.seen.length !== 2) throw new Error(JSON.stringify(r));
});

Deno.test("loop: reviewer problem goes back to the writer, then clean", async () => {
  const m = fakeModel([asInput(GOOD), { problems: ["misreads verse 5"] }, asInput(GOOD), { problems: [] }]);
  const r = await writeCheckedBookDay(SECTION, m.call, OPTS);
  if (!r.clean || r.fixed.length !== 1) throw new Error(JSON.stringify(r));
  const fix = JSON.stringify(m.seen[2].body);
  if (m.seen[2].tool !== "record_book_day" || !fix.includes("misreads verse 5")) throw new Error("fix request lacks the problem");
});

Deno.test("loop: machine problem goes back too, without asking the reviewer first", async () => {
  const bad = { ...asInput(GOOD), thought: "too short" };
  const m = fakeModel([bad, asInput(GOOD), { problems: [] }]);
  const r = await writeCheckedBookDay(SECTION, m.call, OPTS);
  if (!r.clean || r.fixed.length !== 1 || m.seen[1].tool !== "record_book_day") throw new Error(JSON.stringify(r));
});

Deno.test("loop: still failing after 2 fix-ups -> not clean, problems kept", async () => {
  const p = { problems: ["still wrong"] };
  const m = fakeModel([asInput(GOOD), p, asInput(GOOD), p, asInput(GOOD), p]);
  const r = await writeCheckedBookDay(SECTION, m.call, OPTS);
  if (r.clean || r.fixed.length !== 2 || !r.review.includes("still wrong")) throw new Error(JSON.stringify(r));
});

Deno.test("loop: a malformed review is never a pass", async () => {
  const m = fakeModel([asInput(GOOD), {}, asInput(GOOD), {}, asInput(GOOD), {}]);
  const r = await writeCheckedBookDay(SECTION, m.call, OPTS);
  if (r.clean) throw new Error("malformed review counted as clean");
});

Deno.test("a time phrase the passage itself uses is allowed (Philippians 1:5, 'until now')", () => {
  const phil: Section = { ...SECTION, texts: { WEB: "for your partnership in furtherance of the Good News from the first day until now", BSB: "because of your partnership in the gospel from the first day until now", KJV: "For your fellowship in the gospel from the first day until now" } };
  const p = checkBookDay({ ...GOOD, thought: `Paul thanks them for their partnership from the first day until now. ${pad(140)}`, key_verse: { chapter: 1, verse_start: 1, verse_end: 1 } }, phil);
  if (p.some((x) => x.includes("until now"))) throw new Error(JSON.stringify(p));
  // ...but not when the passage does not say it
  expectCaught("not in passage", bad({ thought: `Until now you have waited. ${pad(140)}` }), "until now");
});

Deno.test("a passage word with a possessive apostrophe still counts (Deuteronomy 1:2, \"eleven days’ journey\")", () => {
  const deut: Section = { ...SECTION, texts: { WEB: "It is eleven days’ journey from Horeb", BSB: "It is an eleven-day journey from Horeb", KJV: "There are eleven days' journey from Horeb" } };
  const p = checkBookDay({ ...GOOD, thought: `The trip from Horeb should take eleven days. ${pad(140)}`, key_verse: { chapter: 1, verse_start: 1, verse_end: 1 } }, deut);
  if (p.some((x) => x.includes('"days"'))) throw new Error(JSON.stringify(p));
});
