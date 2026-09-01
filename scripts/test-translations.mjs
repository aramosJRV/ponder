// Validates the multi-translation migration against a real Postgres (PGlite,
// WASM). Companion to test-migration.mjs, which covers the initial schema.
//
// The point of this suite is the failure mode the migration exists to close:
// three functions used to read bible_verses with no translation filter, so a
// second translation would have made resolve_verse_ref() return duplicates
// and made parse_verse_ref() / the seed-verse trigger reject every valid
// reference. Those regressions are asserted explicitly below — if someone
// adds a fourth translation and forgets a filter somewhere, these fail.
//
// Usage: node scripts/test-translations.mjs

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

// --- WEB-only fixtures, loaded BEFORE the migration so the backfill is
//     exercised the way it will run in production ---
await db.exec(`
  insert into public.bible_books (book_number, name, aliases, testament, chapter_count) values
    (19, 'Psalms', array['psalm','ps','psa'], 'OT', 150),
    (24, 'Jeremiah', array['jer','je'], 'OT', 52),
    (45, 'Romans', array['rom','ro','rm'], 'NT', 16),
    (46, '1 Corinthians', array['1 cor','1cor','1 co'], 'NT', 16);
  insert into public.bible_verses (book_number, book, chapter, verse, text) values
    (19, 'Psalms', 46, 10, 'Be still, and know that I am God.'),
    (24, 'Jeremiah', 17, 9, 'The heart is deceitful above all things and it is exceedingly corrupt.'),
    (45, 'Romans', 14, 24, 'Now to him who is able to establish you'),
    (46, '1 Corinthians', 13, 4, 'Love is patient and is kind.'),
    (46, '1 Corinthians', 13, 5, 'doesn''t behave itself inappropriately.');
`);

await db.exec(sql('20260901000001_bible_translations.sql'));
console.log('Migration applied cleanly over populated WEB data.\n');

await test('existing rows backfilled to WEB', async () => {
  const r = await db.query(
    `select count(*)::int n from public.bible_verses where translation <> 'WEB'`
  );
  if (r.rows[0].n !== 0) throw new Error(`${r.rows[0].n} rows are not WEB`);
});

await test('catalogue has the three public-domain translations', async () => {
  const r = await db.query(
    `select code from public.bible_translations order by sort_order`
  );
  const got = r.rows.map((x) => x.code).join(',');
  if (got !== 'WEB,BSB,KJV') throw new Error(`got ${got}`);
});

await test('a translation not in the catalogue is rejected', () =>
  expectError(
    db.query(
      `insert into public.bible_verses (translation, book_number, book, chapter, verse, text)
       values ('NIV', 19, 'Psalms', 46, 10, 'nope')`
    ),
    'foreign key'
  ));

await test('same verse can exist once per translation, not twice within one', async () => {
  await db.exec(`
    insert into public.bible_verses (translation, book_number, book, chapter, verse, text) values
      ('BSB', 19, 'Psalms', 46, 10, 'Be still and know that I am God;'),
      ('KJV', 19, 'Psalms', 46, 10, 'Be still, and know that I am God:'),
      ('BSB', 24, 'Jeremiah', 17, 9, 'The heart is deceitful above all things and beyond cure.'),
      ('KJV', 24, 'Jeremiah', 17, 9, 'The heart is deceitful above all things, and desperately wicked:'),
      ('BSB', 46, '1 Corinthians', 13, 4, 'Love is patient, love is kind.'),
      ('KJV', 46, '1 Corinthians', 13, 4, 'Charity suffereth long, and is kind;'),
      ('BSB', 46, '1 Corinthians', 13, 5, 'It is not rude, not self-seeking.'),
      ('KJV', 46, '1 Corinthians', 13, 5, 'Doth not behave itself unseemly.');
  `);
  await expectError(
    db.query(
      `insert into public.bible_verses (translation, book_number, book, chapter, verse, text)
       values ('BSB', 19, 'Psalms', 46, 10, 'dupe')`
    ),
    'duplicate key'
  );
});

// ---------------------------------------------------------------- the trap
//
// With three translations loaded, every one of these would return the wrong
// thing if its query had no translation filter.

await test('REGRESSION: resolve_verse_ref returns one row per verse, not three', async () => {
  const r = await db.query(`select * from public.resolve_verse_ref('Psalm', 46, 10)`);
  if (r.rows.length !== 1) throw new Error(`got ${r.rows.length} rows`);
  if (!r.rows[0].text.startsWith('Be still, and know that I am God.')) {
    throw new Error(`wrong translation: ${r.rows[0].text}`);
  }
});

await test('resolve_verse_ref: legacy 4-arg call still resolves (WEB default)', async () => {
  const r = await db.query(`select * from public.resolve_verse_ref('1 COR', 13, 4, 5)`);
  if (r.rows.length !== 2) throw new Error(`expected 2 rows, got ${r.rows.length}`);
  if (!r.rows[0].text.startsWith('Love is patient and is kind')) {
    throw new Error('did not default to WEB');
  }
});

await test('resolve_verse_ref: named translation switches the text', async () => {
  const r = await db.query(
    `select * from public.resolve_verse_ref('Jeremiah', 17, 9, null, 'KJV')`
  );
  if (r.rows.length !== 1) throw new Error(`got ${r.rows.length} rows`);
  if (!r.rows[0].text.includes('desperately wicked')) {
    throw new Error(`wrong text: ${r.rows[0].text}`);
  }
});

await test('resolve_verse_ref: only one function of that name (no ambiguity)', async () => {
  const r = await db.query(`
    select count(*)::int n from pg_proc
    where proname = 'resolve_verse_ref'
      and pronamespace = 'public'::regnamespace
  `);
  if (r.rows[0].n !== 1) throw new Error(`${r.rows[0].n} overloads — 4-arg calls will be ambiguous`);
});

await test('REGRESSION: parse_verse_ref still validates with 3 translations loaded', async () => {
  const r = await db.query(`select * from public.parse_verse_ref('1 Cor 13:4-5')`);
  if (r.rows.length !== 1) throw new Error('reference no longer resolves');
  if (!r.rows[0].verse_text.startsWith('Love is patient and is kind')) {
    throw new Error(`wrong translation: ${r.rows[0].verse_text}`);
  }
});

await test('parse_verse_ref: honours a named translation', async () => {
  const r = await db.query(`select * from public.parse_verse_ref('1 Cor 13:4-5', 'KJV')`);
  if (r.rows.length !== 1) throw new Error('did not resolve in KJV');
  if (!r.rows[0].verse_text.startsWith('Charity suffereth long')) {
    throw new Error(`wrong text: ${r.rows[0].verse_text}`);
  }
});

await test('parse_verse_ref: only one function of that name', async () => {
  const r = await db.query(`
    select count(*)::int n from pg_proc
    where proname = 'parse_verse_ref' and pronamespace = 'public'::regnamespace
  `);
  if (r.rows[0].n !== 1) throw new Error(`${r.rows[0].n} overloads`);
});

// ---------------------------------------------------------------- passage_text

await test('passage_text: single verse in each translation', async () => {
  const want = {
    WEB: 'exceedingly corrupt',
    BSB: 'beyond cure',
    KJV: 'desperately wicked',
  };
  for (const [code, fragment] of Object.entries(want)) {
    const r = await db.query(
      `select public.passage_text(24, 17, 9, 9, $1) t`, [code]
    );
    if (!r.rows[0].t?.includes(fragment)) {
      throw new Error(`${code}: expected "${fragment}", got ${r.rows[0].t}`);
    }
  }
});

await test('passage_text: joins a multi-verse span in order', async () => {
  const r = await db.query(`select public.passage_text(46, 13, 4, 5, 'KJV') t`);
  if (r.rows[0].t !== 'Charity suffereth long, and is kind; Doth not behave itself unseemly.') {
    throw new Error(`got: ${r.rows[0].t}`);
  }
});

await test('passage_text: NULL when the span is missing from that translation', async () => {
  // Romans 14:24 exists in the WEB and in no KJV row — the KJV puts that
  // doxology at 16:25-27. This is the real gap, not a synthetic one.
  const web = await db.query(`select public.passage_text(45, 14, 24, 24, 'WEB') t`);
  if (!web.rows[0].t) throw new Error('WEB should have Romans 14:24');
  const kjv = await db.query(`select public.passage_text(45, 14, 24, 24, 'KJV') t`);
  if (kjv.rows[0].t !== null) throw new Error(`expected NULL, got ${kjv.rows[0].t}`);
});

await test('passage_text: NULL when only PART of the span exists', async () => {
  // Never return a half passage — a truncated verse reads as scripture.
  await db.exec(`
    insert into public.bible_verses (translation, book_number, book, chapter, verse, text)
    values ('KJV', 19, 'Psalms', 46, 11, 'The LORD of hosts is with us;')
  `);
  const r = await db.query(`select public.passage_text(19, 46, 10, 12, 'KJV') t`);
  if (r.rows[0].t !== null) throw new Error(`expected NULL, got ${r.rows[0].t}`);
});

await test('passage_text: unknown translation returns NULL, not an error', async () => {
  const r = await db.query(`select public.passage_text(19, 46, 10, 10, 'NIV') t`);
  if (r.rows[0].t !== null) throw new Error(`got ${r.rows[0].t}`);
});

await test('passage_text is not SECURITY DEFINER (RLS still applies)', async () => {
  const r = await db.query(`
    select prosecdef from pg_proc
    where proname = 'passage_text' and pronamespace = 'public'::regnamespace
  `);
  if (r.rows[0].prosecdef) throw new Error('passage_text bypasses RLS');
});

// ---------------------------------------------------------------- seed verse

let uid;
await test('REGRESSION: seed-verse trigger still resolves with 3 translations', async () => {
  const u = await db.query(
    `insert into auth.users (email) values ('t@example.com') returning id`
  );
  uid = u.rows[0].id;
  const r = await db.query(
    `insert into public.topics (user_id, title, seed_book_number, seed_chapter,
       seed_verse_start, seed_verse_end)
     values ($1, 'Stillness', 19, 46, 10, 10)
     returning seed_verse_ref, seed_verse_text`,
    [uid]
  );
  if (r.rows[0].seed_verse_ref !== 'Psalm 46:10') {
    throw new Error(`bad ref: ${r.rows[0].seed_verse_ref}`);
  }
  if (r.rows[0].seed_verse_text !== 'Be still, and know that I am God.') {
    throw new Error(`seed text is not the WEB: ${r.rows[0].seed_verse_text}`);
  }
});

// ---------------------------------------------------------------- profile

await test('profiles.translation defaults to WEB', async () => {
  const r = await db.query(`select translation from public.profiles where id = $1`, [uid]);
  if (r.rows[0].translation !== 'WEB') throw new Error(`got ${r.rows[0].translation}`);
});

await test('profiles.translation rejects an unlicensed translation', () =>
  expectError(
    db.query(`update public.profiles set translation = 'NIV' where id = $1`, [uid]),
    'foreign key'
  ));

await test('profiles.translation accepts KJV', async () => {
  await db.query(`update public.profiles set translation = 'KJV' where id = $1`, [uid]);
});

// ---------------------------------------------------------------- schema hygiene

await test('RLS enabled on every table, bible_translations included', async () => {
  const r = await db.query(`
    select relname from pg_class
    where relnamespace = 'public'::regnamespace
      and relkind = 'r' and not relrowsecurity
  `);
  if (r.rows.length) throw new Error(`RLS off: ${r.rows.map((x) => x.relname).join(', ')}`);
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
