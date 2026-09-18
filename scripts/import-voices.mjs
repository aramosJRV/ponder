// Loads the approved public-domain quotes into voices + voice_quotes.
//
// Source: voices/candidates-2026-09-15.json — 213 quotes harvested verbatim
// from CCEL plaintext editions and reviewed by Antonio on 16 Sep 2026.
// Nothing here was written by a model, and nothing here may be edited: the
// whole point of Bucket 1 is that the text on the entry card is real.
//
// Ids are deterministic: <voice-slug>-<first 8 hex of sha1(text)>. Re-running
// this produces byte-identical ids, so it is idempotent and used-quote history
// survives a reseed. Theme tagging is a separate pass (voice_quote_themes) and
// is NOT done here.
//
// Usage:
//   node scripts/import-voices.mjs --dry-run     # prints, writes nothing
//   node scripts/import-voices.mjs               # writes
//   (SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY from .env)

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';
import { loadEnv } from './lib/env.mjs';

const SOURCE = 'voices/candidates-2026-09-15.json';
const HARVESTED = '2026-09-15';

// Keyed by the exact JSON heading. Death years and CCEL paths are not in the
// JSON, so they live here. work_title is the FULL title as it will render in
// the attribution line under the quote.
const VOICES = {
  'Thomas Watson — A Body of Divinity (1692)': {
    id: 'watson-divinity', name: 'Thomas Watson', died: 1686,
    work_title: 'A Body of Divinity', work_year: 1692,
    ccel: 'https://www.ccel.org/ccel/w/watson/divinity/cache/divinity.txt',
  },
  'Charles Spurgeon — Morning and Evening (1865)': {
    id: 'spurgeon-morning-evening', name: 'Charles Spurgeon', died: 1892,
    work_title: 'Morning and Evening', work_year: 1865,
    ccel: 'https://www.ccel.org/ccel/s/spurgeon/morneve/cache/morneve.txt',
  },
  'Samuel Rutherford — Letters (1664)': {
    id: 'rutherford-letters', name: 'Samuel Rutherford', died: 1661,
    work_title: 'Letters', work_year: 1664,
    ccel: 'https://www.ccel.org/ccel/r/rutherford/letters/cache/letters.txt',
  },
  'William Law — A Serious Call to a Devout and Holy Life (1729)': {
    id: 'law-serious-call', name: 'William Law', died: 1761,
    work_title: 'A Serious Call to a Devout and Holy Life', work_year: 1729,
    ccel: 'https://www.ccel.org/ccel/l/law/serious_call/cache/serious_call.txt',
  },
  'Andrew Murray — With Christ in the School of Prayer (1885)': {
    id: 'murray-prayer', name: 'Andrew Murray', died: 1917,
    work_title: 'With Christ in the School of Prayer', work_year: 1885,
    ccel: 'https://www.ccel.org/ccel/m/murray/prayer/cache/prayer.txt',
    // Murray wrote in both Dutch and English. Recorded as an English original;
    // if this edition turns out to be a translation, the translator's own
    // copyright applies and must be checked before it reaches a reader.
    translation_note: 'Recorded as English original; translator status UNVERIFIED.',
  },
  'Charles Spurgeon — All of Grace (1886)': {
    id: 'spurgeon-grace', name: 'Charles Spurgeon', died: 1892,
    work_title: 'All of Grace', work_year: 1886,
    ccel: 'https://www.ccel.org/ccel/s/spurgeon/grace/cache/grace.txt',
  },
  'Jonathan Edwards — Religious Affections (1746)': {
    id: 'edwards-affections', name: 'Jonathan Edwards', died: 1758,
    work_title: 'Religious Affections', work_year: 1746,
    ccel: 'https://www.ccel.org/ccel/e/edwards/affections/cache/affections.txt',
  },
};

// Australian copyright is life + 70. The voices_public_domain_au check already
// refuses died >= 1955; this string is the audit trail for why each row is
// reproducible AND attributable.
function pdBasis(v) {
  const parts = [
    `${v.name} d.${v.died}; AU copyright life+70, public domain since ${v.died + 71}.`,
    v.translation_note ?? 'English original — no separate translation copyright.',
    `Text harvested ${HARVESTED} from ${v.ccel}.`,
  ];
  return parts.join(' ');
}

const quoteId = (voiceId, text) =>
  `${voiceId}-${createHash('sha1').update(text, 'utf8').digest('hex').slice(0, 8)}`;

// ------------------------------------------------------------
const dryRun = process.argv.includes('--dry-run');
const raw = JSON.parse(readFileSync(new URL(`../${SOURCE}`, import.meta.url), 'utf8'));

const unknown = Object.keys(raw).filter((k) => !VOICES[k]);
if (unknown.length) {
  console.error('Headings in the JSON with no VOICES entry:\n  ' + unknown.join('\n  '));
  process.exit(1);
}

const voiceRows = [];
const quoteRows = [];
const seenId = new Map();
const seenText = new Map();

for (const [heading, quotes] of Object.entries(raw)) {
  const v = VOICES[heading];
  voiceRows.push({
    id: v.id, name: v.name, died: v.died,
    work_title: v.work_title, work_year: v.work_year,
    pd_basis: pdBasis(v), active: true,
  });

  for (const text of quotes) {
    const t = text.trim();
    if (t.length < 40 || t.length > 400) {
      console.error(`Length check would reject (${t.length} chars): ${t.slice(0, 60)}...`);
      process.exit(1);
    }
    const id = quoteId(v.id, t);
    if (seenId.has(id)) {
      console.error(`sha1 prefix collision on ${id}:\n  A: ${seenId.get(id)}\n  B: ${t}`);
      process.exit(1);
    }
    seenId.set(id, t);
    if (seenText.has(t)) {
      console.error(`Duplicate quote text across works:\n  ${seenText.get(t)} / ${v.id}\n  ${t}`);
      process.exit(1);
    }
    seenText.set(t, v.id);

    quoteRows.push({
      id, voice_id: v.id, text: t,
      citation: null,          // chapter/section needs a second extraction pass
      reviewed: true,          // Antonio reviewed all 213 on 16 Sep 2026
      retired: false,
    });
  }
}

console.log(`${voiceRows.length} voices, ${quoteRows.length} quotes, 0 collisions, 0 duplicates.`);
for (const v of voiceRows) {
  const n = quoteRows.filter((q) => q.voice_id === v.id).length;
  console.log(`  ${v.id.padEnd(26)} ${String(n).padStart(3)}  ${v.name} — ${v.work_title}`);
}
console.log(`\nsample id: ${quoteRows[0].id}\nsample pd_basis: ${voiceRows[0].pd_basis}`);

if (dryRun) {
  console.log('\n--dry-run: nothing written.');
  process.exit(0);
}

loadEnv();
const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}
const supabase = createClient(url, key, { auth: { persistSession: false } });

// upsert, not insert: re-running must be a no-op, never a duplicate-key abort.
const { error: ve } = await supabase.from('voices').upsert(voiceRows, { onConflict: 'id' });
if (ve) { console.error('voices upsert failed:', ve); process.exit(1); }

for (let i = 0; i < quoteRows.length; i += 100) {
  const chunk = quoteRows.slice(i, i + 100);
  const { error } = await supabase.from('voice_quotes').upsert(chunk, { onConflict: 'id' });
  if (error) { console.error(`voice_quotes upsert failed at row ${i}:`, error); process.exit(1); }
}

const { count: vc } = await supabase.from('voices').select('*', { count: 'exact', head: true });
const { count: qc } = await supabase.from('voice_quotes').select('*', { count: 'exact', head: true });
console.log(`\nWrote. voices = ${vc}, voice_quotes = ${qc}.`);
if (qc !== quoteRows.length) console.error(`WARNING: expected ${quoteRows.length} quotes, DB has ${qc}.`);
