// Loads one public-domain translation into bible_verses from a CSV in data/.
//
// The WEB comes from the `world-english-bible` npm package via
// import-web-bible.mjs; BSB and KJV ship as CSVs because there is no
// equivalent package for them. Both paths write the same table, and both
// MUST set `translation` — a row without it defaults to 'WEB' and would
// silently corrupt the default text every reader sees.
//
// The CSVs use the canonical book_number/book from bible_books, so book
// names never have to be re-resolved here. They also carry FEWER rows than
// the WEB on purpose: verse spans absent from a translation are omitted
// rather than stored blank, so passage_text() returns NULL and the entry
// card can say "not in this translation" instead of rendering an empty
// passage. Do not "repair" the row counts to match.
//
// Idempotent per translation: skips if that translation is already loaded.
//
// Usage:
//   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
//     node scripts/import-translation.mjs BSB [--force]

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';
import { loadEnv } from './lib/env.mjs';

loadEnv();

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const code = (process.argv[2] || '').toUpperCase();
const force = process.argv.includes('--force');

const KNOWN = {
  BSB: { file: 'bsb_bible.csv', min: 31000 },
  KJV: { file: 'kjv_bible.csv', min: 31000 },
};

if (!KNOWN[code]) {
  console.error(
    `Usage: node scripts/import-translation.mjs <${Object.keys(KNOWN).join('|')}> [--force]\n` +
      'The WEB is loaded by import-web-bible.mjs, not this script.'
  );
  process.exit(1);
}

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

const supabase = createClient(url, key, { auth: { persistSession: false } });

/** Minimal RFC4180 reader — the text column contains commas and quoted quotes. */
function parseCsv(raw) {
  const rows = [];
  let field = '';
  let row = [];
  let quoted = false;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (quoted) {
      if (c === '"') {
        if (raw[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      quoted = true;
    } else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (c !== '\r') {
      field += c;
    }
  }
  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

async function main() {
  const { count, error: countErr } = await supabase
    .from('bible_verses')
    .select('*', { count: 'exact', head: true })
    .eq('translation', code);
  if (countErr) {
    throw new Error(
      `Could not count ${code} rows: ${countErr.message}\n` +
        'If this says the translation column does not exist, the migration ' +
        '20260901000001_bible_translations.sql has not been applied yet.'
    );
  }

  if (count && count > 0 && !force) {
    console.log(`${code} already has ${count} rows — skipping (use --force to reload).`);
    return;
  }

  const { file, min } = KNOWN[code];
  let raw;
  try {
    raw = readFileSync(join(root, 'data', file), 'utf8');
  } catch {
    throw new Error(
      `data/${file} is missing. data/ is gitignored, so a fresh clone has no ` +
        `text: run \`node scripts/fetch-translation-csv.mjs ${code}\` first.`
    );
  }
  const rows = parseCsv(raw);
  const header = rows.shift();
  const expected = 'book_number,book,chapter,verse,text';
  if (header.join(',') !== expected) {
    throw new Error(`Unexpected header in ${file}: ${header.join(',')}`);
  }

  const verses = rows
    .filter((r) => r.length === 5 && r[4].trim() !== '')
    .map((r) => ({
      translation: code,
      book_number: Number(r[0]),
      book: r[1],
      chapter: Number(r[2]),
      verse: Number(r[3]),
      text: r[4],
    }));

  if (verses.length < min) {
    throw new Error(`Suspiciously low verse count for ${code}: ${verses.length}`);
  }
  const books = new Set(verses.map((v) => v.book_number));
  if (books.size !== 66) {
    throw new Error(`Expected 66 books in ${code}, got ${books.size}`);
  }

  console.log(`Parsed ${verses.length} ${code} verses across ${books.size} books.`);

  if (force && count > 0) {
    console.log(`--force: clearing existing ${code} rows...`);
    const { error } = await supabase.from('bible_verses').delete().eq('translation', code);
    if (error) throw new Error(`Delete failed: ${error.message}`);
  }

  const BATCH = 1000;
  for (let i = 0; i < verses.length; i += BATCH) {
    const { error } = await supabase.from('bible_verses').insert(verses.slice(i, i + BATCH));
    if (error) throw new Error(`Insert failed at row ${i}: ${error.message}`);
    process.stdout.write(`\r${Math.min(i + BATCH, verses.length)}/${verses.length} verses`);
  }
  console.log('');

  // Spot check through the same function the app calls, not a raw select —
  // this is what proves the tabs will work, not just that rows landed.
  const { data: text, error: rpcErr } = await supabase.rpc('passage_text', {
    p_book_number: 19,
    p_chapter: 46,
    p_verse_start: 10,
    p_verse_end: 10,
    p_translation: code,
  });
  if (rpcErr) throw new Error(`passage_text failed: ${rpcErr.message}`);
  if (!text) throw new Error(`Spot check failed: Psalm 46:10 did not resolve in ${code}`);
  console.log(`Spot check OK — Psalm 46:10 (${code}): "${text}"`);

  // And prove the WEB was not disturbed. An import that writes rows with no
  // translation would land them on 'WEB' by default and quietly duplicate it.
  const { count: webCount } = await supabase
    .from('bible_verses')
    .select('*', { count: 'exact', head: true })
    .eq('translation', 'WEB');
  console.log(`WEB rows still present: ${webCount}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
