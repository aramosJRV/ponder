// Book threads: database checks against the PRIVATE local copy (localdb/),
// never the live project. Everything runs inside one transaction that is
// rolled back, so the copy is left exactly as it was.
//
//   supabase start --workdir localdb        (once; see localdb/README.md)
//   deno run --no-lock --node-modules-dir=none -A scripts/book-threads-db-check.ts
//   ... --extra-sql bad.sql    also apply bad.sql after the migration (proves the checks bite)
//
// Checks:
//  - every query in each shipped app version's src/lib/api.ts (read from git,
//    not from today's code) still runs as a signed-in reader
//  - a book day reads back through those queries with every field an old app
//    needs, and its verse works with the old Context / translation calls
//  - the content library is hidden from apps; a reader can't mark another
//    reader's entry; the writer job can't be run from an app; the catalogue
//    lists 66 books; opening a book day queues the next section

const SHIPPED = { "1.0.20": "6c120b8", "1.0.21": "94086d5" };
const MIGRATION = "supabase/migrations/20261020000001_book_threads.sql";
const DB = "supabase_db_ponder-local";
const A = "00000000-0000-0000-0000-00000000000a";
const B = "00000000-0000-0000-0000-00000000000b";

const run = async (cmd: string, args: string[], stdin?: string) => {
  const p = new Deno.Command(cmd, { args, stdin: stdin ? "piped" : "null", stdout: "piped", stderr: "piped" }).spawn();
  if (stdin) {
    const w = p.stdin.getWriter();
    await w.write(new TextEncoder().encode(stdin));
    await w.close();
  }
  const o = await p.output();
  return { ok: o.success, out: new TextDecoder().decode(o.stdout), err: new TextDecoder().decode(o.stderr) };
};

/** (table, columns) for every `.from("t")...select(cols)` in a shipped api.ts. */
async function shippedSelects(ref: string): Promise<[string, string][]> {
  const src = (await run("git", ["show", `${ref}:src/lib/api.ts`])).out;
  if (!src) throw new Error(`cannot read src/lib/api.ts at ${ref}`);
  const consts = new Map([...src.matchAll(/const (\w+)\s*=\s*"([^"]+)"/g)].map((m) => [m[1], m[2]]));
  const found = new Map<string, [string, string]>();
  for (const m of src.matchAll(/\.from\("(\w+)"\)\s*\.select\(\s*([^,)]*)/g)) {
    const arg = m[2].trim();
    const cols = !arg ? "*" : arg.startsWith('"') ? arg.slice(1, -1) : consts.get(arg);
    if (!cols) throw new Error(`${ref}: cannot resolve select(${arg})`);
    found.set(`${m[1]}|${cols}`, [m[1], cols]);
  }
  return [...found.values()];
}

const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;
const asUser = (uid: string) =>
  `perform set_config('role', 'authenticated', true);
   perform set_config('request.jwt.claims', ${lit(JSON.stringify({ sub: uid, role: "authenticated" }))}, true);`;
const asAnon = `perform set_config('role', 'anon', true);
   perform set_config('request.jwt.claims', '{"role":"anon"}', true);`;
/** One check: a DO block whose failure is reported, then rolled back to keep going. */
const test = (name: string, body: string) => `
do $t$ begin
  begin
    ${body}
    raise notice 'CHECK ok %', ${lit(name)};
  exception when others then
    raise notice 'CHECK FAIL % -- %', ${lit(name)}, sqlerrm;
  end;
end $t$;`;

const extraIdx = Deno.args.indexOf("--extra-sql");
const extra = extraIdx >= 0 ? await Deno.readTextFile(Deno.args[extraIdx + 1]) : "";

// The copy may already carry the migration (app run-throughs need it applied).
const applied = (await run("docker", ["exec", DB, "psql", "-U", "postgres", "-tAc",
  "select 1 from information_schema.columns where table_name = 'topics' and column_name = 'book_number'"])).out.trim() === "1";
if (applied) console.log("(migration already applied to the local copy; checking it as it stands)\n");

const parts: string[] = [
  "\\set ON_ERROR_STOP 1",
  "begin;",
  applied ? "" : await Deno.readTextFile(MIGRATION),
  extra,
  // Two readers, one book thread with one book day (Mark 1:1-8, key verse 7-8).
  `insert into auth.users (id, aud, role) values (${lit(A)}, 'authenticated', 'authenticated'), (${lit(B)}, 'authenticated', 'authenticated');
   insert into public.profiles (id, timezone) values (${lit(A)}, 'Australia/Sydney'), (${lit(B)}, 'UTC') on conflict (id) do nothing;
   insert into public.topics (id, user_id, title, description, book_number)
     values ('00000000-0000-0000-0000-0000000000f1', ${lit(A)}, 'Mark', '', 41);`,
  `insert into public.daily_entries (id, topic_id, user_id, date, verse_ref, book_number, chapter, verse_start, verse_end,
     verse_text, thought, illustration, ponder, prayer_prompts, entry_type, fallback_used, cross_refs, book_section)
   select '00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000f1', ${lit(A)}, current_date,
     'Mark 1:7-8', 41, 1, 7, 8, string_agg(text, ' ' order by verse), 'thought', 'illustration',
     array['q1?', 'q2?'], array['p1', 'p2'], 'affirming', false, '[]'::jsonb,
     '{"start_chapter":1,"start_verse":1,"end_chapter":1,"end_verse":8,"index":1,"count":87}'::jsonb
   from public.bible_verses where translation = 'WEB' and book_number = 41 and chapter = 1 and verse between 7 and 8;
   insert into public.book_section_content (book_number, start_chapter, start_verse, status) values (41, 1, 1, 'pending');`,
];

for (const [version, ref] of Object.entries(SHIPPED)) {
  for (const [table, cols] of await shippedSelects(ref)) {
    parts.push(test(`${version}: select ${cols} from ${table}`, `${asUser(A)} execute 'select ${cols} from public.${table} limit 5';`));
  }
}

parts.push(
  test("old topics query shows the book thread as 'Mark'", `${asUser(A)}
    if (select title from public.topics where id = '00000000-0000-0000-0000-0000000000f1') <> 'Mark'
      then raise exception 'book thread missing'; end if;`),
  test("old entries query returns the book day with every field filled", `${asUser(A)}
    if not exists (select 1 from public.daily_entries where id = '00000000-0000-0000-0000-0000000000e1'
      and verse_text <> '' and thought <> '' and illustration <> '' and cardinality(ponder) >= 1 and cardinality(prayer_prompts) >= 1)
    then raise exception 'book day not readable'; end if;`),
  test("old translation and Context calls work on the book day's verse", `${asUser(A)}
    if public.passage_text(41, 1, 7, 8, 'BSB') is null then raise exception 'passage_text BSB null'; end if;
    if (select count(*) from public.passage_context(41, 1, 7, 'KJV')) = 0 then raise exception 'passage_context empty'; end if;
    perform * from public.verse_setting(41, 1, 7);`),
  test("another reader cannot see the book thread", `${asUser(B)}
    if exists (select 1 from public.daily_entries where id = '00000000-0000-0000-0000-0000000000e1') then raise exception 'visible to B'; end if;`),
  test("content library hidden from apps", `${asUser(A)}
    if exists (select 1 from public.book_section_content) then raise exception 'library visible'; end if;`),
  test("a reader cannot mark someone else's entry opened", `${asUser(B)}
    perform public.mark_entry_opened('00000000-0000-0000-0000-0000000000e1');
    perform set_config('role', 'postgres', true);
    if (select opened_on from public.daily_entries where id = '00000000-0000-0000-0000-0000000000e1') is not null
      then raise exception 'opened by another reader'; end if;`),
  test("opening a book day records the reader's date and queues the next section", `${asUser(A)}
    perform public.mark_entry_opened('00000000-0000-0000-0000-0000000000e1');
    perform set_config('role', 'postgres', true);
    if (select opened_on from public.daily_entries where id = '00000000-0000-0000-0000-0000000000e1')
       <> (now() at time zone 'Australia/Sydney')::date then raise exception 'opened_on wrong'; end if;
    if not exists (select 1 from public.book_section_content b join public.bible_pericopes p using (book_number, start_chapter, start_verse)
       where b.book_number = 41 and b.status = 'pending'
         and p.start_ord = (select min(start_ord) from public.bible_pericopes where book_number = 41 and start_ord > 1001))
    then raise exception 'next section not queued'; end if;`),
  test("catalogue lists 66 books for a signed-in reader", `${asUser(A)}
    if (select count(*) from public.book_catalogue()) <> 66 then raise exception 'not 66'; end if;`),
  test("catalogue refused to signed-out callers", `${asAnon}
    begin perform public.book_catalogue(); raise exception 'anon allowed';
    exception when insufficient_privilege then null; end;`),
  ...["run_book_build()", "queue_book_section(41, 1, 1)"].flatMap((fn) => [
    test(`apps cannot run ${fn}`, `${asUser(A)}
      begin perform public.${fn}; raise exception 'allowed';
      exception when insufficient_privilege then null; end;`),
  ]),
  "rollback;",
);

const res = await run("docker", ["exec", "-i", DB, "psql", "-U", "postgres", "-q", "-X"], parts.join("\n"));
const lines = res.err.split("\n").filter((l) => l.includes("CHECK"));
const fails = lines.filter((l) => l.includes("CHECK FAIL"));
for (const l of lines) console.log(l.replace(/^.*NOTICE:\s+CHECK /, "  "));
const expected = parts.filter((p) => p.includes("raise notice 'CHECK ok")).length;
if (!res.ok) console.log(`\npsql stopped early:\n${res.err.split("\n").filter((l) => /ERROR/.test(l)).join("\n")}`);
const passed = lines.length - fails.length;
console.log(`\n${passed} of ${expected} database checks passed.`);
Deno.exit(res.ok && !fails.length && lines.length === expected ? 0 : 1);
