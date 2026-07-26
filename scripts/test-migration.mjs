// Validates the initial migration against a real Postgres (PGlite, WASM).
// Stubs the Supabase `auth` schema, applies the migration, then exercises
// the constraints, triggers and resolve_verse_ref().
//
// Usage: npm i -D @electric-sql/pglite && node scripts/test-migration.mjs

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const migration = readFileSync(
  join(root, 'supabase/migrations/20260707000001_initial_schema.sql'),
  'utf8'
);

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

// --- apply migration ---
await db.exec(migration);
console.log('Migration applied cleanly.\n');

// --- fixtures ---
const {
  rows: [user],
} = await db.query(`insert into auth.users (email) values ('t@example.com') returning id`);
const uid = user.id;

await db.exec(`
  insert into public.bible_books (book_number, name, aliases, testament, chapter_count) values
    (19, 'Psalms', array['psalm','ps','psa'], 'OT', 150),
    (46, '1 Corinthians', array['1 cor','1cor','1 co'], 'NT', 16);
  insert into public.bible_verses (book_number, book, chapter, verse, text) values
    (19, 'Psalms', 46, 10, 'Be still, and know that I am God.'),
    (46, '1 Corinthians', 13, 4, 'Love is patient and is kind.'),
    (46, '1 Corinthians', 13, 5, 'doesn''t behave itself inappropriately.');
`);

// --- tests ---
await test('signup trigger auto-creates profile', async () => {
  const r = await db.query(`select * from public.profiles where id = $1`, [uid]);
  if (r.rows.length !== 1) throw new Error('no profile row');
  if (r.rows[0].challenge_frequency !== '0.25') throw new Error('bad default');
});

await test('challenge_frequency capped at 0.5', () =>
  expectError(
    db.query(`update public.profiles set challenge_frequency = 0.6 where id = $1`, [uid]),
    'check'
  ));

await test('resolve_verse_ref: alias + single verse', async () => {
  const r = await db.query(
    `select * from public.resolve_verse_ref('Psalm', 46, 10)`
  );
  if (r.rows.length !== 1) throw new Error('did not resolve');
  if (!r.rows[0].text.startsWith('Be still')) throw new Error('wrong text');
});

await test('resolve_verse_ref: range + case-insensitive alias', async () => {
  const r = await db.query(
    `select * from public.resolve_verse_ref('1 COR', 13, 4, 5)`
  );
  if (r.rows.length !== 2) throw new Error(`expected 2 rows, got ${r.rows.length}`);
});

await test('resolve_verse_ref: bogus ref returns nothing', async () => {
  const r = await db.query(`select * from public.resolve_verse_ref('Psalm', 999, 1)`);
  if (r.rows.length !== 0) throw new Error('should not resolve');
});

let topicId;
await test('topic insert', async () => {
  const r = await db.query(
    `insert into public.topics (user_id, title, focus) values ($1, 'Stillness', true) returning id`,
    [uid]
  );
  topicId = r.rows[0].id;
});

await test('only one focus topic per user', () =>
  expectError(
    db.query(
      `insert into public.topics (user_id, title, focus) values ($1, 'Second', true)`,
      [uid]
    ),
    'topics_one_focus_per_user'
  ));

let entryId;
await test('daily entry insert', async () => {
  const r = await db.query(
    `insert into public.daily_entries
       (topic_id, user_id, date, verse_ref, book_number, chapter, verse_start, verse_end,
        verse_text, thought, illustration, ponder, prayer_prompts, entry_type)
     values ($1, $2, current_date, 'Psalm 46:10', 19, 46, 10, 10,
        'Be still, and know that I am God.', 't', 'i',
        array['q1','q2'], array['p1','p2'], 'affirming')
     returning id`,
    [topicId, uid]
  );
  entryId = r.rows[0].id;
});

await test('one entry per topic per day', () =>
  expectError(
    db.query(
      `insert into public.daily_entries
         (topic_id, user_id, date, verse_ref, book_number, chapter, verse_start, verse_end,
          verse_text, thought, illustration, ponder, prayer_prompts)
       values ($1, $2, current_date, 'Psalm 46:10', 19, 46, 10, 10, 'x', 't', 'i',
          array['q'], array['p'])`,
      [topicId, uid]
    ),
    'duplicate key'
  ));

await test('note insert on active topic', async () => {
  await db.query(
    `insert into public.notes (entry_id, topic_id, user_id, body) values ($1, $2, $3, 'a note')`,
    [entryId, topicId, uid]
  );
});

await test('concluding topic sets concluded_at + clears focus', async () => {
  const r = await db.query(
    `update public.topics set status = 'concluded' where id = $1
     returning concluded_at, focus`,
    [topicId]
  );
  if (!r.rows[0].concluded_at) throw new Error('concluded_at not set');
  if (r.rows[0].focus) throw new Error('focus not cleared');
});

await test('concluded topic is read-only', () =>
  expectError(
    db.query(`update public.topics set title = 'renamed' where id = $1`, [topicId]),
    'read-only'
  ));

await test('no new notes on concluded topic', () =>
  expectError(
    db.query(
      `insert into public.notes (entry_id, topic_id, user_id, body) values ($1, $2, $3, 'late')`,
      [entryId, topicId, uid]
    ),
    'concluded'
  ));

await test('RLS enabled on all user tables', async () => {
  const r = await db.query(`
    select relname from pg_class
    where relnamespace = 'public'::regnamespace
      and relkind = 'r' and not relrowsecurity
  `);
  if (r.rows.length) throw new Error(`RLS off: ${r.rows.map((x) => x.relname).join(', ')}`);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
