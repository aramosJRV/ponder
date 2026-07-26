// Loads the full World English Bible into bible_books + bible_verses.
// Idempotent: skips if bible_verses is already populated (use --force to reload).
//
// Usage:
//   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node scripts/import-web-bible.mjs [--force]
//   (or put both in .env — see .env.example)

import { createClient } from '@supabase/supabase-js';
import { parseAll } from './lib/parse-web.mjs';
import { loadEnv } from './lib/env.mjs';

loadEnv();

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

const supabase = createClient(url, key, { auth: { persistSession: false } });
const force = process.argv.includes('--force');

const EXPECTED_BOOKS = 66;
const EXPECTED_MIN_VERSES = 31000;

async function main() {
  const { count } = await supabase
    .from('bible_verses')
    .select('*', { count: 'exact', head: true });

  if (count && count > 0 && !force) {
    console.log(`bible_verses already has ${count} rows — skipping (use --force to reload).`);
    return;
  }

  console.log('Parsing WEB text from world-english-bible package...');
  const { verses, books } = parseAll();
  console.log(`Parsed ${books.length} books, ${verses.length} verses.`);

  if (books.length !== EXPECTED_BOOKS) throw new Error(`Expected 66 books, got ${books.length}`);
  if (verses.length < EXPECTED_MIN_VERSES) throw new Error(`Suspiciously low verse count: ${verses.length}`);

  if (force && count > 0) {
    console.log('--force: clearing existing bible data...');
    await supabase.from('bible_verses').delete().neq('id', 0);
  }

  const { error: bookErr } = await supabase
    .from('bible_books')
    .upsert(books, { onConflict: 'book_number' });
  if (bookErr) throw new Error(`bible_books upsert failed: ${bookErr.message}`);
  console.log('bible_books loaded.');

  const BATCH = 1000;
  for (let i = 0; i < verses.length; i += BATCH) {
    const batch = verses.slice(i, i + BATCH);
    const { error } = await supabase.from('bible_verses').insert(batch);
    if (error) throw new Error(`Insert failed at row ${i}: ${error.message}`);
    process.stdout.write(`\r${Math.min(i + BATCH, verses.length)}/${verses.length} verses`);
  }
  console.log('\nDone.');

  // spot check
  const { data: check } = await supabase
    .rpc('resolve_verse_ref', { p_book: 'Psalm', p_chapter: 46, p_verse_start: 10 });
  if (!check?.length) throw new Error('Spot check failed: Psalm 46:10 did not resolve');
  console.log(`Spot check OK — Psalm 46:10: "${check[0].text}"`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
