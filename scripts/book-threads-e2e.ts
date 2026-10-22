// Book threads end to end, against the PRIVATE local copy only: the real
// generate-entry code served locally (`supabase functions serve --workdir
// localdb`), a fresh anonymous reader, a Ruth thread. No model is called:
// the section writing is put in place directly, so the loop costs nothing.
//
//   deno run --no-lock --node-modules-dir=none -A scripts/book-threads-e2e.ts
//
// Walks: start -> same day again -> next day unopened (carried forward) ->
// opened -> next day (section 2 not written yet: "running late", queued) ->
// written -> next day (section 2) -> nightly path -> reading ahead -> question
// threads untouched.

const status = JSON.parse(new TextDecoder().decode((await new Deno.Command("supabase", {
  args: ["status", "--workdir", "localdb", "-o", "json"], stdout: "piped", stderr: "null",
}).output()).stdout));
const API: string = status.API_URL;
if (!/^http:\/\/127\.0\.0\.1:/.test(API)) throw new Error(`refusing to run against ${API}: local copy only`);
const ANON: string = status.ANON_KEY;
const SERVICE: string = status.SERVICE_ROLE_KEY;

let failures = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  if (!ok) failures++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : ` -- ${JSON.stringify(detail)}`}`);
};

async function call(path: string, key: string, init: RequestInit & { json?: unknown } = {}) {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      apikey: ANON, Authorization: `Bearer ${key}`, "Content-Type": "application/json",
      Prefer: "return=representation", ...(init.headers ?? {}),
    },
    body: init.json === undefined ? init.body : JSON.stringify(init.json),
  });
  const text = await res.text();
  let body: unknown = text;
  try { body = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, body: body as any }; // deno-lint-ignore no-explicit-any
}
const rest = (path: string, key: string, init: RequestInit & { json?: unknown } = {}) => call(`/rest/v1/${path}`, key, init);

const addDays = (d: string, n: number) => new Date(Date.parse(d) + n * 86400_000).toISOString().slice(0, 10);

// ---- a fresh reader (profile comes from the auth trigger, timezone UTC)
const signup = await call("/auth/v1/signup", ANON, { method: "POST", json: {} });
const USER: string = signup.body.access_token;
const UID: string = signup.body.user?.id;
if (!USER) throw new Error(`anonymous sign-in failed: ${JSON.stringify(signup.body)}`);
const TODAY = new Date().toISOString().slice(0, 10);

// ---- section writing for Ruth 1:1 (Phase 1 sample) ready; Ruth 1:6 not yet
const ruth = JSON.parse(await Deno.readTextFile("content/book-threads/samples.json"))
  .find((s: { section: { book: string } }) => s.section.book === "Ruth").day;
const ready = (start_verse: number, kv: [number, number]) => ({
  book_number: 8, start_chapter: 1, start_verse, status: "ready", attempts: 1,
  key_chapter: 1, key_verse_start: kv[0], key_verse_end: kv[1],
  thought: ruth.thought, illustration: ruth.illustration, ponder: ruth.ponder, prayer_prompts: ruth.prayer_prompts,
  meditation: { WEB: ["Naomi", "the woman was bereaved"] },
});
await rest("book_section_content?book_number=eq.8", SERVICE, { method: "DELETE" });
await rest("book_section_content", SERVICE, { method: "POST", json: ready(1, [5, 5]) });

const topic = await rest("topics", USER, { method: "POST", json: { user_id: UID, title: "Ruth", description: "", book_number: 8 } });
const TOPIC: string = topic.body?.[0]?.id;
check("a reader can start a book thread", topic.status === 201 && !!TOPIC, topic.body);

const gen = (date?: string, key = USER) =>
  call("/functions/v1/generate-entry", key, { method: "POST", json: { topic_id: TOPIC, ...(date ? { force_date: date } : {}) } });
const entries = async () =>
  (await rest(`daily_entries?topic_id=eq.${TOPIC}&order=date`, USER)).body as Record<string, any>[]; // deno-lint-ignore no-explicit-any

// ---- start
let r = await gen();
let e = await entries();
check("start: section 1 created", r.body?.results?.[0]?.status === "created" && e.length === 1, r.body);
const first = e[0] ?? {};
const want = { start_chapter: 1, start_verse: 1, end_chapter: 1, end_verse: 5, index: 1, count: 9 };
check("section 1 is Ruth 1:1-5, 1 of 9",
  Object.entries(want).every(([k, v]) => first.book_section?.[k] === v), first.book_section);
check("key verse text comes from the Bible table, not the writer", first.verse_ref === "Ruth 1:5" &&
  String(first.verse_text).startsWith("Mahlon and Chilion both died"), [first.verse_ref, first.verse_text]);
check("old-app fields filled", !!first.thought && first.ponder?.length >= 2 && first.prayer_prompts?.length >= 2 &&
  first.entry_type === "affirming" && Array.isArray(first.cross_refs), first);
check("no provenance leaks to the reader", !("source" in (r.body?.results?.[0] ?? {})), r.body);

// ---- same day again
r = await gen();
check("same day again: nothing new", r.body?.results?.[0]?.status === "exists" && (await entries()).length === 1, r.body);

// ---- next day, not opened: carried forward, not copied
const D1 = addDays(TODAY, 1);
r = await gen(D1);
e = await entries();
check("next day unopened: same section carried to the new date", e.length === 1 && e[0].date === D1 && e[0].book_section.index === 1, e);

// ---- open it
const opened = await rest("rpc/mark_entry_opened", USER, { method: "POST", json: { p_entry_id: first.id } });
e = await entries();
check("opening records the reader's date", opened.status < 300 && e[0].opened_on === TODAY, [opened, e[0]?.opened_on]);
const queued = await rest("book_section_content?book_number=eq.8&start_verse=eq.6&select=status", SERVICE);
check("opening queues section 2 for writing", queued.body?.[0]?.status === "pending", queued.body);

// ---- next day, section 2 not written yet
const D2 = addDays(TODAY, 2);
r = await gen(D2);
check("section not written yet: reported as running late", r.status === 200 && r.body?.results?.[0]?.status === "failed", r.body);
check("and nothing moved", (await entries()).length === 1, null);

// ---- written; next day brings section 2
await rest("book_section_content?book_number=eq.8&start_verse=eq.6", SERVICE, { method: "DELETE" });
await rest("book_section_content", SERVICE, { method: "POST", json: ready(6, [16, 17]) });
r = await gen(D2);
e = await entries();
check("then section 2 arrives", r.body?.results?.[0]?.status === "created" && e.length === 2 &&
  e[1].book_section.index === 2 && e[1].verse_ref === "Ruth 1:16-17", e.map((x) => [x.date, x.verse_ref]));

// ---- nightly path for this reader: handled without the library or the batch API
const D3 = addDays(TODAY, 3);
r = await call("/functions/v1/generate-entry", SERVICE, { method: "POST", json: { mode: "batch_submit", user_ids: [UID], force_date: D3 } });
e = await entries();
check("nightly path carries the unopened section 2 forward, submits nothing", r.status === 200 &&
  r.body?.submitted === 0 && e.length === 2 && e[1].date === D3, [r.body, e.map((x) => x.date)]);
const themed = await rest(`topic_themes?topic_id=eq.${TOPIC}`, SERVICE);
check("book thread never reaches the theme classifier", Array.isArray(themed.body) && themed.body.length === 0, themed.body);

// ---- reading ahead: open section 2, then ask for section 3 on the same day
await rest("rpc/mark_entry_opened", USER, { method: "POST", json: { p_entry_id: e[1].id } });
const s3 = (await rest("book_section_content?book_number=eq.8&status=eq.pending&select=start_chapter,start_verse", SERVICE)).body?.[0];
const ahead = (from: string) =>
  call("/functions/v1/generate-entry", USER, { method: "POST", json: { topic_id: TOPIC, read_ahead_from: from, force_date: D3 } });
r = await ahead(e[1].id);
check("read ahead before the next section is written: running late, nothing moved", r.body?.results?.[0]?.status === "failed" &&
  JSON.stringify((await entries()).map((x) => x.date)) === JSON.stringify([D1, D3]), r.body);
await rest(`book_section_content?book_number=eq.8&start_chapter=eq.${s3.start_chapter}&start_verse=eq.${s3.start_verse}`, SERVICE, {
  method: "PATCH", json: { ...ready(s3.start_verse, [s3.start_verse, s3.start_verse]), start_chapter: s3.start_chapter, key_chapter: s3.start_chapter },
});
r = await ahead(e[1].id);
e = await entries();
// Section 1 sits on D1 with D2 free behind section 2, so only section 2 moves.
check("read ahead: section 3 takes today, section 2 steps back to the free day", r.body?.results?.[0]?.status === "created" &&
  JSON.stringify(e.map((x) => [x.date, x.book_section.index])) === JSON.stringify([[D1, 1], [D2, 2], [D3, 3]]), e.map((x) => [x.date, x.book_section.index]));
r = await ahead(e[1].id);
check("a second tap from the old passage moves nothing", r.body?.results?.[0]?.status === "exists" && (await entries()).length === 3, r.body);
await rest("rpc/mark_entry_opened", USER, { method: "POST", json: { p_entry_id: e[2].id } });
r = await gen(addDays(TODAY, 4));
const s4 = (await rest("book_section_content?book_number=eq.8&status=eq.pending&select=start_chapter,start_verse", SERVICE)).body;
check("next day carries on after the furthest section read (section 4 queued)", r.body?.results?.[0]?.status === "failed" &&
  s4?.length === 1 && (s4[0].start_chapter > s3.start_chapter || s4[0].start_verse > s3.start_verse), [r.body, s4]);

// ---- the writer job refuses a reader's token
r = await call("/functions/v1/generate-entry", USER, { method: "POST", json: { mode: "book_build" } });
check("a reader cannot start the writer job", r.status === 403, r.body);

console.log(`\n${failures ? `${failures} FAILED` : "all passed"}`);
Deno.exit(failures ? 1 : 0);
