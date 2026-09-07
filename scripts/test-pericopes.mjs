// Validates the "Read the full context" migration against a real Postgres
// (PGlite, WASM). Companion to test-migration.mjs and test-translations.mjs.
//
// The two things this suite exists to protect:
//
//  1. The starts-only design. Ends are derived from the following start, so a
//     gap or an overlap is unrepresentable. If someone later "helpfully" adds
//     end_chapter/end_verse columns, the totality test below is what catches
//     the first row that disagrees with them.
//
//  2. passage_context() returning ROWS with NULL text for verses absent from a
//     translation, rather than passage_text()'s all-or-nothing NULL. One
//     missing KJV verse must not blank a fifteen-verse context.
//
// Usage: node scripts/test-pericopes.mjs

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const sql = (f) => readFileSync(join(root, 'supabase/migrations', f), 'utf8');

const db = new PGlite();
let pass = 0;
let fail = 0;

async function test(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`  ok  ${name}`);
  } catch (e) {
    fail++;
    console.log(`FAIL  ${name}: ${e.message}`);
  }
}

async function expectError(promise, fragment) {
  try {
    await promise;
  } catch (e) {
    if (fragment && !e.message.includes(fragment)) {
      throw new Error(`wrong error: ${e.message}`);
    }
    return;
  }
  throw new Error('expected an error, got none');
}

// --- stub Supabase roles + auth schema ---
await db.exec(`
  create role anon nologin;
  create role authenticated nologin;
  create role service_role nologin bypassrls;
  create schema auth;
  create table auth.users (
    id uuid primary key default gen_random_uuid(),
    email text unique
  );
  create function auth.uid() returns uuid
    language sql stable as $$ select null::uuid $$;
`);

await db.exec(sql('20260707000001_initial_schema.sql'));
await db.exec(sql('20260728000003_topic_seed_verse.sql'));
await db.exec(sql('20260901000001_bible_translations.sql'));

// --- fixtures ---
// bible_translations is seeded by the translations migration; do not re-insert.
// 1 Corinthians 12:29-31, 13:1-13, 14:1 is the canonical chapter-crossing
// case: the love chapter begins at 12:31 ("a most excellent way"), so the
// unit runs 12:31-13:13 and 14:1 starts the next one.
await db.exec(`
  insert into public.bible_books (book_number, name, aliases, testament, chapter_count) values
    (46, '1 Corinthians', array['1 cor','1cor','1 co'], 'NT', 16);
`);

const web = [
  [12, 29, 'Are all apostles? Are all prophets?'],
  [12, 30, 'Do all have gifts of healings?'],
  [12, 31, 'But earnestly desire the best gifts. Moreover, I show a most excellent way to you.'],
  [13, 1, 'If I speak with the languages of men and of angels, but do not have love...'],
  [13, 2, 'If I have the gift of prophecy...'],
  [13, 3, 'If I give away all my goods to feed the poor...'],
  [13, 4, 'Love is patient and is kind.'],
  [13, 5, "doesn't behave itself inappropriately."],
  [13, 6, "doesn't rejoice in unrighteousness."],
  [13, 7, 'bears all things, believes all things.'],
  [13, 8, 'Love never fails.'],
  [13, 9, 'For we know in part and we prophesy in part;'],
  [13, 10, 'but when that which is complete has come...'],
  [13, 11, 'When I was a child, I spoke as a child.'],
  [13, 12, 'For now we see in a mirror, dimly.'],
  [13, 13, 'But now faith, hope, and love remain — these three. The greatest of these is love.'],
  [14, 1, 'Follow after love and earnestly desire spiritual gifts.'],
];

for (const [c, v, t] of web) {
  await db.query(
    `insert into public.bible_verses (translation, book_number, book, chapter, verse, text)
     values ('WEB', 46, '1 Corinthians', $1, $2, $3)`,
    [c, v, t]
  );
}

// KJV: same versification, but 13:5 deliberately absent — this stands in for
// the real gaps (Romans 14:24-26 in the KJV, fifteen BSB omissions).
for (const [c, v] of web) {
  if (c === 13 && v === 5) continue;
  await db.query(
    `insert into public.bible_verses (translation, book_number, book, chapter, verse, text)
     values ('KJV', 46, '1 Corinthians', $1, $2, $3)`,
    [c, v, `KJV ${c}:${v}`]
  );
}

await db.exec(sql('20260907000003_bible_pericopes.sql'));

await db.exec(`
  insert into public.bible_pericopes (book_number, start_chapter, start_verse) values
    (46, 12, 29),
    (46, 12, 31),
    (46, 14,  1);
`);

// ---------------------------------------------------------------- the table

await test('a start that does not resolve to a WEB verse is rejected', async () => {
  await expectError(
    db.query(`insert into public.bible_pericopes values (46, 99, 1)`),
    'does not resolve to a WEB verse'
  );
});

await test('a start past the end of a real chapter is rejected', async () => {
  await expectError(
    db.query(`insert into public.bible_pericopes values (46, 13, 99)`),
    'does not resolve to a WEB verse'
  );
});

await test('duplicate starts are rejected by the primary key', async () => {
  await expectError(
    db.query(`insert into public.bible_pericopes values (46, 12, 31)`),
    'duplicate key'
  );
});

await test('start_ord is generated, not supplied', async () => {
  const r = await db.query(
    `select start_ord from public.bible_pericopes where start_chapter = 12 and start_verse = 31`
  );
  if (r.rows[0].start_ord !== 12031) throw new Error(`got ${r.rows[0].start_ord}`);
});

// ---------------------------------------------------------------- derived ranges

await test('the love unit is 12:31-13:13 — it crosses the chapter break', async () => {
  const r = await db.query(`
    select end_chapter, end_verse from public.bible_pericope_ranges
    where book_number = 46 and start_chapter = 12 and start_verse = 31
  `);
  const { end_chapter, end_verse } = r.rows[0];
  if (end_chapter !== 13 || end_verse !== 13) {
    throw new Error(`got ${end_chapter}:${end_verse}, expected 13:13`);
  }
});

await test('display end is a real verse, never verse 0 of the next chapter', async () => {
  const r = await db.query(`
    select r.end_chapter, r.end_verse
    from public.bible_pericope_ranges r
    left join public.bible_verses v
      on v.translation = 'WEB' and v.book_number = r.book_number
     and v.chapter = r.end_chapter and v.verse = r.end_verse
    where v.id is null
  `);
  if (r.rows.length) {
    throw new Error(`unreal display ends: ${JSON.stringify(r.rows)}`);
  }
});

await test('the last unit in a book runs to the last verse of the book', async () => {
  const r = await db.query(`
    select end_chapter, end_verse from public.bible_pericope_ranges
    where book_number = 46 and start_chapter = 14 and start_verse = 1
  `);
  const { end_chapter, end_verse } = r.rows[0];
  if (end_chapter !== 14 || end_verse !== 1) {
    throw new Error(`got ${end_chapter}:${end_verse}`);
  }
});

await test('pericope_for is total — every verse falls in exactly one unit', async () => {
  const r = await db.query(`
    select v.chapter, v.verse, count(p.*) as hits
    from public.bible_verses v
    left join lateral public.pericope_for(v.book_number, v.chapter, v.verse) p on true
    where v.translation = 'WEB'
    group by v.chapter, v.verse
    having count(p.*) <> 1
  `);
  if (r.rows.length) throw new Error(`bad coverage: ${JSON.stringify(r.rows)}`);
});

await test('13:1 resolves to the unit that starts at 12:31, not to 13:1', async () => {
  const r = await db.query(`select * from public.pericope_for(46, 13, 1)`);
  const { start_chapter, start_verse } = r.rows[0];
  if (start_chapter !== 12 || start_verse !== 31) {
    throw new Error(`got ${start_chapter}:${start_verse}`);
  }
});

// ---------------------------------------------------------------- passage_context

await test('passage_context returns the whole unit across the chapter break', async () => {
  const r = await db.query(`select * from public.passage_context(46, 13, 4, 'WEB')`);
  if (r.rows.length !== 14) throw new Error(`got ${r.rows.length} rows, expected 14`);
  const first = r.rows[0];
  const last = r.rows[r.rows.length - 1];
  if (first.chapter !== 12 || first.verse !== 31) throw new Error('does not start at 12:31');
  if (last.chapter !== 13 || last.verse !== 13) throw new Error('does not end at 13:13');
});

await test('rows come back in verse order', async () => {
  const r = await db.query(`select * from public.passage_context(46, 13, 4, 'WEB')`);
  const ords = r.rows.map((x) => x.chapter * 1000 + x.verse);
  if (JSON.stringify(ords) !== JSON.stringify([...ords].sort((a, b) => a - b))) {
    throw new Error('out of order');
  }
});

await test('every row carries the range, so the header needs no second call', async () => {
  const r = await db.query(`select * from public.passage_context(46, 13, 4, 'WEB')`);
  for (const row of r.rows) {
    if (row.start_chapter !== 12 || row.start_verse !== 31) throw new Error('range missing');
    if (row.end_chapter !== 13 || row.end_verse !== 13) throw new Error('range missing');
  }
});

await test('a verse absent from a translation comes back NULL, not dropped', async () => {
  const r = await db.query(`select * from public.passage_context(46, 13, 4, 'KJV')`);
  if (r.rows.length !== 14) {
    throw new Error(`got ${r.rows.length} rows — the gap was dropped instead of marked`);
  }
  const hole = r.rows.find((x) => x.chapter === 13 && x.verse === 5);
  if (!hole) throw new Error('13:5 missing from the skeleton');
  if (hole.verse_text !== null) throw new Error('13:5 should have no KJV text');
  const neighbour = r.rows.find((x) => x.chapter === 13 && x.verse === 6);
  if (!neighbour.verse_text) throw new Error('13:6 lost its KJV text');
});

await test('an unknown translation yields a skeleton, never an error', async () => {
  const r = await db.query(`select * from public.passage_context(46, 13, 4, 'NIV')`);
  if (r.rows.length !== 14) throw new Error(`got ${r.rows.length} rows`);
  if (r.rows.some((x) => x.verse_text !== null)) throw new Error('text leaked from another translation');
});

await test('the WEB skeleton is what defines the rows, not the chosen translation', async () => {
  const web = await db.query(`select * from public.passage_context(46, 13, 4, 'WEB')`);
  const kjv = await db.query(`select * from public.passage_context(46, 13, 4, 'KJV')`);
  const key = (rs) => rs.rows.map((x) => `${x.chapter}:${x.verse}`).join(',');
  if (key(web) !== key(kjv)) throw new Error('row sets differ between translations');
});

await test('pericope_coverage_gaps returns nothing on a healthy tiling', async () => {
  const r = await db.query(`select * from public.pericope_coverage_gaps()`);
  if (r.rows.length) throw new Error(`gaps: ${JSON.stringify(r.rows)}`);
});

await test('pericope_coverage_gaps catches a book with no pericopes at all', async () => {
  await db.query(`begin`);
  await db.query(`delete from public.bible_pericopes where book_number = 46`);
  const r = await db.query(`select * from public.pericope_coverage_gaps()`);
  await db.query(`rollback`);
  if (!r.rows.length) throw new Error('a fully unloaded book went undetected');
});

// ---------------------------------------------------------------- schema hygiene

await test('RLS is enabled on bible_pericopes', async () => {
  const r = await db.query(`
    select relrowsecurity from pg_class
    where oid = 'public.bible_pericopes'::regclass
  `);
  if (!r.rows[0].relrowsecurity) throw new Error('RLS off');
});

await test('the ranges view is security_invoker, so bible_verses RLS still applies', async () => {
  const r = await db.query(`
    select reloptions from pg_class
    where oid = 'public.bible_pericope_ranges'::regclass
  `);
  const opts = (r.rows[0].reloptions || []).join(',');
  if (!opts.includes('security_invoker=true')) throw new Error(`reloptions: ${opts}`);
});

await test('no function was made SECURITY DEFINER', async () => {
  const r = await db.query(`
    select proname from pg_proc
    where pronamespace = 'public'::regnamespace
      and proname in ('pericope_for', 'passage_context', 'validate_pericope_start')
      and prosecdef
  `);
  if (r.rows.length) throw new Error(`definer: ${r.rows.map((x) => x.proname).join(', ')}`);
});

await test('no column-level grants were introduced (see the 25 Aug outage)', async () => {
  const r = await db.query(`
    select table_name, column_name from information_schema.column_privileges
    where table_schema = 'public' and grantee in ('anon', 'authenticated')
  `);
  if (r.rows.length) {
    throw new Error(
      `column grants found: ${r.rows.map((x) => `${x.table_name}.${x.column_name}`).join(', ')}`
    );
  }
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
