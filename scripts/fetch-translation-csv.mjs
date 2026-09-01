// Rebuilds data/<code>_bible.csv for a public-domain translation from its
// upstream source. data/ is gitignored, so without this script the BSB and
// KJV text exists only on whichever machine first downloaded it.
//
// Source: scrollmapper/bible_databases, which publishes per-translation CSVs
// with a Book,Chapter,Verse,Text header. This script normalises them onto the
// canonical book list in scripts/lib/books.mjs so the output is a drop-in
// match for data/web_bible.csv:
//
//   - 'I Samuel' / 'II Kings' / 'III John'  ->  '1 Samuel' / '2 Kings' / '3 John'
//   - 'Revelation of John'                  ->  'Revelation'
//   - book_number is the canonical 1-66, taken from books.mjs, not from
//     the source file's ordering
//   - rows with empty text are DROPPED, not stored blank. The BSB leaves the
//     sixteen textual-critical verses (Matthew 17:21, Mark 9:44, John 5:4,
//     Acts 8:37 and the rest) empty on purpose. An empty row would render as
//     an empty passage; a missing row makes passage_text() return NULL and
//     the entry card say "this passage isn't in the Berean Standard Bible",
//     which is the truth.
//
// Usage: node scripts/fetch-translation-csv.mjs BSB
//        node scripts/fetch-translation-csv.mjs KJV

import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BOOKS } from './lib/books.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const SOURCES = {
  BSB: 'https://raw.githubusercontent.com/scrollmapper/bible_databases/master/formats/csv/BSB.csv',
  KJV: 'https://raw.githubusercontent.com/scrollmapper/bible_databases/master/formats/csv/KJV.csv',
};

const code = (process.argv[2] || '').toUpperCase();
if (!SOURCES[code]) {
  console.error(`Usage: node scripts/fetch-translation-csv.mjs <${Object.keys(SOURCES).join('|')}>`);
  process.exit(1);
}

/** Minimal RFC4180 reader — the text column contains commas and quoted quotes. */
function parseCsv(raw) {
  const rows = [];
  let field = '', row = [], quoted = false;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (quoted) {
      if (c === '"') {
        if (raw[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

const csvCell = (s) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);

function canonical(name) {
  let n = name === 'Revelation of John' ? 'Revelation' : name;
  const m = /^(I{1,3})\s+(.*)$/.exec(n);
  if (m) n = `${m[1].length} ${m[2]}`;
  return n;
}

const BY_NAME = new Map(BOOKS.map((b) => [b.name, b.n]));

const res = await fetch(SOURCES[code]);
if (!res.ok) throw new Error(`${SOURCES[code]} -> HTTP ${res.status}`);
const rows = parseCsv(await res.text());

const header = rows.shift();
if (header.join(',') !== 'Book,Chapter,Verse,Text') {
  throw new Error(`Unexpected upstream header: ${header.join(',')}`);
}

const out = [];
let dropped = 0;
const seenBooks = new Set();
for (const r of rows) {
  if (r.length < 4) continue;
  const name = canonical(r[0]);
  const n = BY_NAME.get(name);
  if (!n) throw new Error(`Unmapped book name: ${r[0]} (normalised to ${name})`);
  seenBooks.add(n);
  const text = r[3].trim();
  if (!text) { dropped++; continue; }
  out.push([n, name, Number(r[1]), Number(r[2]), text]);
}

if (seenBooks.size !== 66) throw new Error(`Expected 66 books, got ${seenBooks.size}`);
if (out.length < 31000) throw new Error(`Suspiciously low verse count: ${out.length}`);

const dest = join(root, 'data', `${code.toLowerCase()}_bible.csv`);
writeFileSync(
  dest,
  'book_number,book,chapter,verse,text\n' +
    out.map((r) => r.map((c) => csvCell(String(c))).join(',')).join('\n') +
    '\n',
  'utf8'
);
console.log(
  `${code}: wrote ${out.length} verses to data/${code.toLowerCase()}_bible.csv` +
    (dropped ? ` (${dropped} empty rows dropped — verses absent from this translation)` : '')
);
