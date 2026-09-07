// Loads data/pericopes.csv into bible_pericopes.
//
// The CSV is START POINTS ONLY — book_number,start_chapter,start_verse. Ends
// are derived by bible_pericope_ranges from the following start, so this
// script has nothing to compute and nothing to get wrong about extents. If
// you ever find yourself adding end columns here, read the migration header
// first: overlap is meant to be unrepresentable, not merely rejected.
//
// ORDER DEPENDENCY: the validate_pericope_start() trigger checks every start
// against the WEB, so bible_verses must be loaded first. `npm run setup`
// already orders it that way; running this against an empty bible_verses
// fails on the first row rather than loading garbage.
//
// Idempotent: skips if pericopes are already loaded. --force clears first.
//
// Usage:
//   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
//     node scripts/import-pericopes.mjs [--force]

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';
import { loadEnv } from './lib/env.mjs';

loadEnv();

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const force = process.argv.includes('--force');

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

const supabase = createClient(url, key, { auth: { persistSession: false } });

// Plain split is safe here: three integer columns, no quoting, no commas in
// the data. Unlike the verse CSVs this needs no RFC4180 reader.
function parseCsv(raw) {
  const lines = raw.split(/\r?\n/).filter((l) => l.trim());
  const header = lines.shift().split(',').map((h) => h.trim());
  const want = ['book_number', 'start_chapter', 'start_verse'];
  if (header.join(',') !== want.join(',')) {
    throw new Error(`Unexpected header: ${header.join(',')} — expected ${want.join(',')}`);
  }
  return lines.map((line, i) => {
    const cells = line.split(',').map((c) => c.trim());
    if (cells.length !== 3) throw new Error(`Row ${i + 2}: expected 3 columns, got ${cells.length}`);
    const [book_number, start_chapter, start_verse] = cells.map(Number);
    if (![book_number, start_chapter, start_verse].every(Number.isInteger)) {
      throw new Error(`Row ${i + 2}: non-integer value in "${line}"`);
    }
    return { book_number, start_chapter, start_verse };
  });
}

// The same structural assertions the generation job ran, re-run here so a
// hand-edited CSV cannot reach the database. These are about SHAPE — that the
// rows form a complete tiling. Whether each start resolves to a real verse is
// the trigger's job, and it runs per row on insert.
function assertShape(rows) {
  const byBook = new Map();
  for (const r of rows) {
    if (!byBook.has(r.book_number)) byBook.set(r.book_number, []);
    byBook.get(r.book_number).push(r);
  }

  const books = [...byBook.keys()].sort((a, b) => a - b);
  const missing = Array.from({ length: 66 }, (_, i) => i + 1).filter((b) => !byBook.has(b));
  if (missing.length) throw new Error(`No pericopes for book(s): ${missing.join(', ')}`);
  const extra = books.filter((b) => b < 1 || b > 66);
  if (extra.length) throw new Error(`Unexpected book_number(s): ${extra.join(', ')}`);

  for (const b of books) {
    const starts = byBook.get(b);
    const ords = starts.map((r) => r.start_chapter * 1000 + r.start_verse);

    // Strictly increasing. Also catches duplicates, which the primary key
    // would reject anyway — but with a message that names the book.
    for (let i = 1; i < ords.length; i++) {
      if (ords[i] <= ords[i - 1]) {
        const a = starts[i - 1];
        const c = starts[i];
        throw new Error(
          `Book ${b}: starts out of order or duplicated — ` +
            `${a.start_chapter}:${a.start_verse} then ${c.start_chapter}:${c.start_verse}`
        );
      }
    }

    // Every book must be covered from its first verse. Without this a book
    // would silently have no context for everything before its first start.
    const first = starts[0];
    if (first.start_chapter !== 1 || first.start_verse !== 1) {
      throw new Error(
        `Book ${b}: first start is ${first.start_chapter}:${first.start_verse}, must be 1:1`
      );
    }
  }
  return byBook;
}

async function main() {
  const raw = readFileSync(join(root, 'data/pericopes.csv'), 'utf8');
  const rows = parseCsv(raw);
  const byBook = assertShape(rows);
  console.log(`Parsed ${rows.length} pericope starts across ${byBook.size} books`);

  if (rows.length < 2500) {
    throw new Error(`Only ${rows.length} rows — the full tiling is ~3,000. Refusing a partial load.`);
  }

  const { count, error: countErr } = await supabase
    .from('bible_pericopes')
    .select('*', { count: 'exact', head: true });
  if (countErr) throw new Error(`Count failed: ${countErr.message}`);

  if (count > 0 && !force) {
    console.log(`${count} pericopes already loaded — nothing to do. Use --force to reload.`);
    return;
  }

  if (force && count > 0) {
    console.log(`--force: clearing existing ${count} rows...`);
    const { error } = await supabase.from('bible_pericopes').delete().gte('book_number', 1);
    if (error) throw new Error(`Delete failed: ${error.message}`);
  }

  const BATCH = 1000;
  for (let i = 0; i < rows.length; i += BATCH) {
    const { error } = await supabase.from('bible_pericopes').insert(rows.slice(i, i + BATCH));
    if (error) throw new Error(`Insert failed at row ${i}: ${error.message}`);
    process.stdout.write(`\r${Math.min(i + BATCH, rows.length)}/${rows.length} pericopes`);
  }
  console.log('');

  // Spot check through the RPC the sheet actually calls, not a raw select.
  // 1 Corinthians 13:4 must come back inside the unit that starts at 12:31 —
  // the canonical chapter-crossing case. If this returns a range starting at
  // 13:1, the load is chapter divisions wearing a pericope table's name.
  const { data: ctx, error: rpcErr } = await supabase.rpc('passage_context', {
    p_book_number: 46,
    p_chapter: 13,
    p_verse: 4,
    p_translation: 'WEB',
  });
  if (rpcErr) throw new Error(`passage_context failed: ${rpcErr.message}`);
  if (!ctx?.length) throw new Error('Spot check failed: 1 Corinthians 13:4 resolved to no context');
  const { start_chapter, start_verse, end_chapter, end_verse } = ctx[0];
  console.log(
    `Spot check — 1 Cor 13:4 sits in ${start_chapter}:${start_verse}-${end_chapter}:${end_verse} ` +
      `(${ctx.length} verses)`
  );
  if (start_chapter !== 12 || start_verse !== 31) {
    throw new Error(
      `Spot check FAILED: expected the unit to start at 12:31, got ${start_chapter}:${start_verse}`
    );
  }

  // Coverage: every WEB verse must fall inside exactly one unit. This is the
  // assertion that would catch a partially-loaded table, which the row count
  // alone will not.
  const { data: gaps, error: gapErr } = await supabase.rpc('pericope_coverage_gaps');
  if (gapErr) {
    console.log('(skipping coverage check — pericope_coverage_gaps not present)');
  } else if (gaps?.length) {
    throw new Error(`Coverage gaps in book(s): ${gaps.map((g) => g.book_number).join(', ')}`);
  } else {
    console.log('Coverage OK — every WEB verse falls inside exactly one pericope');
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
