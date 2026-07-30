// Seed: creates the app user (if missing), a demo topic, and a first
// daily entry so the app is testable end-to-end immediately.
//
// The seed entry's verse TEXT is fetched from bible_verses via
// resolve_verse_ref() — same contract the generation function will use.
// (The written content here is static seed copy; real entries come from
// the generation edge function in build step 2.)
//
// Usage:
//   SEED_USER_EMAIL=you@example.com node scripts/seed.mjs
//   (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / SEED_USER_EMAIL via env or .env)

import { createClient } from '@supabase/supabase-js';
import { loadEnv } from './lib/env.mjs';

loadEnv();

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
const email = process.env.SEED_USER_EMAIL;
if (!url || !key || !email) {
  console.error('Missing SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY or SEED_USER_EMAIL');
  process.exit(1);
}

const supabase = createClient(url, key, { auth: { persistSession: false } });

const DEMO_TOPIC = {
  title: 'Learning to be still',
  description:
    'I keep sensing an invitation to slow down and stop striving — that ' +
    'trust looks like stillness right now, not more effort.',
  // The passage that triggered the pondering. Coordinates only: the
  // topics_resolve_seed trigger derives seed_verse_ref/seed_verse_text
  // from bible_verses, so the WEB text is never client-supplied.
  seed_book_number: 2, // Exodus
  seed_chapter: 14,
  seed_verse_start: 14,
  seed_verse_end: 14,
};

const SEED_ENTRY = {
  verse: { book: 'Psalm', chapter: 46, verse_start: 10, verse_end: 10 },
  thought:
    'Stillness is not the absence of activity but the presence of trust. ' +
    'The psalmist writes from the middle of upheaval — nations raging, ' +
    'mountains shaking — and the command is not "fix it" but "be still, and ' +
    'know." Knowing God is God relieves you of the job. Today, notice the ' +
    'moments you reach for control out of habit rather than necessity. What ' +
    'would it look like to release just one of them? Stillness is a practice, ' +
    'and practices start small.',
  illustration:
    'A field left fallow looks like waste to a hurried eye. Nothing is ' +
    'planted; nothing visible grows. But underneath, the soil is doing slow, ' +
    'essential work — restoring nitrogen, rebuilding structure, preparing for ' +
    'a harvest it cannot yet see. Farmers who refuse their fields rest get ' +
    'diminishing returns from exhausted ground. The fallow season is not the ' +
    'opposite of fruitfulness; it is part of how fruitfulness works. Perhaps ' +
    'stillness functions the same way in a life.',
  ponder: [
    'Where in your life does stillness feel most like a threat rather than a gift?',
    'What are you afraid would happen if you stopped striving in that area?',
    'What is one small act of "letting the field rest" you could take today?',
  ],
  prayer_prompts: [
    'Ask for the trust that makes stillness possible.',
    'Name one thing you are gripping tightly, and practice releasing it in prayer.',
    'Sit in silence for two minutes and simply be present.',
  ],
};

async function getOrCreateUser() {
  const { data, error } = await supabase.auth.admin.listUsers();
  if (error) throw error;
  const existing = data.users.find((u) => u.email === email);
  if (existing) {
    console.log(`User exists: ${email}`);
    return existing;
  }
  const { data: created, error: createErr } = await supabase.auth.admin.createUser({
    email,
    email_confirm: true,
  });
  if (createErr) throw createErr;
  console.log(`Created user: ${email}`);
  return created.user;
}

async function main() {
  const user = await getOrCreateUser();

  // demo topic (idempotent by title)
  let { data: topic } = await supabase
    .from('topics')
    .select('*')
    .eq('user_id', user.id)
    .eq('title', DEMO_TOPIC.title)
    .maybeSingle();

  if (!topic) {
    const { data, error } = await supabase
      .from('topics')
      .insert({ user_id: user.id, ...DEMO_TOPIC, focus: true })
      .select()
      .single();
    if (error) throw error;
    topic = data;
    console.log(`Created demo topic: "${topic.title}"`);
  } else {
    console.log(`Demo topic exists: "${topic.title}"`);
  }

  // first entry for today (idempotent via unique(topic_id, date))
  const today = new Date().toISOString().slice(0, 10);
  const { data: existingEntry } = await supabase
    .from('daily_entries')
    .select('id')
    .eq('topic_id', topic.id)
    .eq('date', today)
    .maybeSingle();
  if (existingEntry) {
    console.log('Entry for today already exists — done.');
    return;
  }

  // verse text MUST come from the bible table, never hardcoded
  const v = SEED_ENTRY.verse;
  const { data: verseRows, error: verseErr } = await supabase.rpc('resolve_verse_ref', {
    p_book: v.book,
    p_chapter: v.chapter,
    p_verse_start: v.verse_start,
    p_verse_end: v.verse_end,
  });
  if (verseErr) throw verseErr;
  if (!verseRows?.length) {
    throw new Error('Verse did not resolve — run `npm run import:bible` first.');
  }

  const { error: entryErr } = await supabase.from('daily_entries').insert({
    topic_id: topic.id,
    user_id: user.id,
    date: today,
    verse_ref: `${v.book} ${v.chapter}:${v.verse_start}`,
    book_number: verseRows[0].book_number,
    chapter: v.chapter,
    verse_start: v.verse_start,
    verse_end: v.verse_end,
    verse_text: verseRows.map((r) => r.text).join(' '),
    thought: SEED_ENTRY.thought,
    illustration: SEED_ENTRY.illustration,
    ponder: SEED_ENTRY.ponder,
    prayer_prompts: SEED_ENTRY.prayer_prompts,
    entry_type: 'affirming',
  });
  if (entryErr) throw entryErr;

  console.log(`Seeded first entry (${v.book} ${v.chapter}:${v.verse_start}) for ${today}.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
