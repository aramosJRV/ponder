// Applies voices/theme-tags-<date>.json to public.voice_quote_themes.
//
// Theme tags do NOT select the quote. They narrow the candidate slate that
// goes into the generation prompt (~12 theme-matched + ~8 general, shuffled);
// the model makes the final call and returns a quote_id or nothing. So a
// slightly wrong tag puts a quote in front of the model, not on the card.
//
// Untagged quotes are deliberate, not a backlog: they are the general pool
// that keeps quotes flowing on the ~20 of 46 themes this corpus barely
// touches (anger, church-hurt, estrangement, forgiving, generosity,
// illness-loved, rest, singleness, transition, decision — all zero).
//
// Idempotent: upserts on the composite PK, so re-running changes nothing.
// It does NOT delete tags absent from the file — pass --prune for that.
//
// Usage:
//   node scripts/apply-voice-theme-tags.mjs --dry-run
//   node scripts/apply-voice-theme-tags.mjs [--prune]

import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';
import { loadEnv } from './lib/env.mjs';

const TAGS = 'voices/theme-tags-2026-09-17.json';

const dryRun = process.argv.includes('--dry-run');
const prune = process.argv.includes('--prune');

const tags = JSON.parse(readFileSync(new URL(`../${TAGS}`, import.meta.url), 'utf8'));
const pairs = Object.entries(tags).flatMap(([quote_id, themes]) =>
  themes.map((slug) => ({ quote_id, slug })),
);
const themeSlugs = [...new Set(pairs.map((p) => p.slug))];

console.log(`${Object.keys(tags).length} quotes, ${pairs.length} tag pairs, ${themeSlugs.length} themes.`);
if (dryRun) { console.log('--dry-run: nothing written.'); process.exit(0); }

loadEnv();
const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) { console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY'); process.exit(1); }
const supabase = createClient(url, key, { auth: { persistSession: false } });

// slug -> uuid. Fail loudly on an unknown slug rather than dropping the tag:
// a silently missing tag is a quote that is never a candidate, and nothing
// anywhere would report it.
const { data: themes, error: te } = await supabase.from('entry_themes').select('id, slug');
if (te) { console.error('entry_themes read failed:', te); process.exit(1); }
const themeId = new Map(themes.map((t) => [t.slug, t.id]));
const unknown = themeSlugs.filter((s) => !themeId.has(s));
if (unknown.length) { console.error('Unknown theme slugs:', unknown.join(', ')); process.exit(1); }

// Every quote_id must exist, for the same reason.
const { data: quotes, error: qe } = await supabase.from('voice_quotes').select('id');
if (qe) { console.error('voice_quotes read failed:', qe); process.exit(1); }
const known = new Set(quotes.map((q) => q.id));
const orphans = [...new Set(pairs.map((p) => p.quote_id))].filter((id) => !known.has(id));
if (orphans.length) { console.error(`${orphans.length} quote ids not in voice_quotes:`, orphans.slice(0, 5)); process.exit(1); }

const rows = pairs.map((p) => ({ quote_id: p.quote_id, theme_id: themeId.get(p.slug) }));
for (let i = 0; i < rows.length; i += 200) {
  const { error } = await supabase
    .from('voice_quote_themes')
    .upsert(rows.slice(i, i + 200), { onConflict: 'quote_id,theme_id' });
  if (error) { console.error(`upsert failed at row ${i}:`, error); process.exit(1); }
}

if (prune) {
  const wanted = new Set(rows.map((r) => `${r.quote_id}|${r.theme_id}`));
  const { data: existing } = await supabase.from('voice_quote_themes').select('quote_id, theme_id');
  const stale = (existing ?? []).filter((r) => !wanted.has(`${r.quote_id}|${r.theme_id}`));
  for (const r of stale) {
    await supabase.from('voice_quote_themes').delete()
      .eq('quote_id', r.quote_id).eq('theme_id', r.theme_id);
  }
  console.log(`pruned ${stale.length} tags not in the file.`);
}

const { count } = await supabase.from('voice_quote_themes').select('*', { count: 'exact', head: true });
console.log(`\nWrote. voice_quote_themes = ${count} (expected ${rows.length}${prune ? '' : ' or more'}).`);
