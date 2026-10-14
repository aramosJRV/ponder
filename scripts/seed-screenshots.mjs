// Seed: demo data for App Store / Play screenshots.
//
// WHY THIS EXISTS SEPARATELY FROM scripts/seed.mjs
// seed.mjs makes the app testable (one thread, one entry, today).
// Screenshots need something else: a believable account with *history* —
// several threads at different stages, entries stretching back weeks, real
// notes, and a synthesis. A day-one empty state photographs badly.
//
// WHICH USER THIS SEEDS
// The app has no sign-in screen: first launch calls signInAnonymously() and
// that anonymous auth.users row IS the account (email is only ever used for
// backup/restore via OTP). So there is no way to "log in as" a demo account
// in the Simulator — instead, launch the app once to mint its anonymous user,
// then seed onto that user:
//
//   node scripts/seed-screenshots.mjs --latest-anon
//
// which targets the most recently created anonymous user. Pass
// SCREENSHOT_USER_ID=<uuid> instead to be explicit about which one.
//
// PRIVACY: --latest-anon is safe on a fresh Simulator, where the newest
// anonymous user is definitionally the one just created. Run it against a
// device holding your real account and it will DELETE that account's threads.
// The script prints the target user and its current row counts before
// touching anything, and refuses to wipe a user that already has content
// unless --force is passed.
//
// SCRIPTURE CONTRACT: unchanged from everywhere else in this codebase.
// Verse text is fetched from bible_verses via resolve_verse_ref(); it is
// never written literally in this file. Cross-references are resolved the
// same way and the script HARD FAILS on any reference that doesn't exist,
// rather than silently dropping it the way generate-entry does — a missing
// footnote in a screenshot is a defect we'd rather catch here than notice
// after the shot is uploaded.
//
// Usage:
//   1. Launch the app in the Simulator (creates its anonymous user)
//   2. node scripts/seed-screenshots.mjs --latest-anon
//   3. Force-quit and relaunch the app — the threads are there
//
// (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY via env or .env)
//
// Re-running wipes and rebuilds the target user's rows only. Idempotent.

import { createClient } from '@supabase/supabase-js';
import { loadEnv } from './lib/env.mjs';

loadEnv();

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

const args = new Set(process.argv.slice(2));
const useLatestAnon = args.has('--latest-anon');
const force = args.has('--force');
const explicitId = process.env.SCREENSHOT_USER_ID;

if (!url || !key) {
  console.error(
    'Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.\n' +
      'Both live in .env at the repo root — SUPABASE_SERVICE_ROLE_KEY is the\n' +
      'Secret key from Dashboard → Project Settings → API Keys.',
  );
  process.exit(1);
}

if (!useLatestAnon && !explicitId) {
  console.error(
    'Nothing to target.\n\n' +
      '  --latest-anon            seed the most recent anonymous user\n' +
      '                           (launch the app in the Simulator first)\n' +
      '  SCREENSHOT_USER_ID=<uuid>  seed a specific user\n\n' +
      'Add --force to overwrite a user that already has threads.',
  );
  process.exit(1);
}

const db = createClient(url, key, { auth: { persistSession: false } });

// ---------------------------------------------------------------- helpers

/** Local ISO date N days before today. */
function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

/** Display convention used throughout the app: 'Psalms' reads as 'Psalm'. */
function displayRef(book, chapter, start, end) {
  const b = book === 'Psalms' ? 'Psalm' : book;
  return start === end ? `${b} ${chapter}:${start}` : `${b} ${chapter}:${start}-${end}`;
}

/**
 * Resolve a reference against the WEB table. Throws rather than returning
 * null — see the SCRIPTURE CONTRACT note at the top of the file.
 */
async function resolve({ book, chapter, verse_start, verse_end }) {
  const end = verse_end ?? verse_start;
  const { data, error } = await db.rpc('resolve_verse_ref', {
    p_book: book,
    p_chapter: chapter,
    p_verse_start: verse_start,
    p_verse_end: end,
  });
  if (error) throw new Error(`resolve_verse_ref failed for ${book} ${chapter}:${verse_start} — ${error.message}`);
  if (!data?.length) {
    throw new Error(
      `"${book} ${chapter}:${verse_start}" did not resolve. Did you run \`npm run import:bible\`?`,
    );
  }
  if (data.length !== end - verse_start + 1) {
    throw new Error(`"${book} ${chapter}:${verse_start}-${end}" resolved only partially (${data.length} verses).`);
  }
  return {
    book_number: data[0].book_number,
    text: data.map((r) => r.text).join(' '),
    ref: displayRef(book, chapter, verse_start, end),
  };
}

/** Build the validated cross_refs JSON the entry footnote renders from. */
async function resolveCrossRefs(refs) {
  const out = [];
  for (const r of refs) {
    const end = r.verse_end ?? r.verse_start;
    await resolve(r); // existence check; throws if bad
    out.push({
      ref: displayRef(r.book, r.chapter, r.verse_start, end),
      book: r.book,
      chapter: r.chapter,
      verse_start: r.verse_start,
      verse_end: end,
    });
  }
  return out;
}

// ------------------------------------------------------------------ data
//
// Deliberately generic subject matter: vocation, rest, money. Nothing here
// should read as anyone's actual private life, because it will be public.

const STILLNESS = {
  title: 'Learning to be still',
  description:
    'I keep sensing an invitation to slow down and stop striving — that trust ' +
    'looks like stillness right now, not more effort.',
  seed: { book: 'Exodus', chapter: 14, verse_start: 14, verse_end: 14 },
  status: 'active',
  focus: true,
  created_days_ago: 26,
  entries: [
    {
      days_ago: 0,
      verse: { book: 'Psalms', chapter: 46, verse_start: 10, verse_end: 10 },
      entry_type: 'affirming',
      thought:
        'Stillness is not the absence of activity but the presence of trust. The psalmist ' +
        'writes from the middle of upheaval — nations raging, mountains shaking — and the ' +
        'instruction is not "fix it" but "be still, and know." Knowing God is God relieves ' +
        'you of the job of being God. Notice today the moments you reach for control out of ' +
        'habit rather than necessity. There is usually one you could release without anything ' +
        'falling apart. Stillness is a practice, and practices start small enough to actually ' +
        'begin.',
      illustration:
        'A field left fallow looks like waste to a hurried eye. Nothing is planted; nothing ' +
        'visible grows. But underneath, the soil is doing slow and essential work — restoring ' +
        'nitrogen, rebuilding structure, preparing for a harvest it cannot yet see. Farmers ' +
        'who refuse their fields rest get diminishing returns from exhausted ground, and the ' +
        'decline is gradual enough that it is easy to blame on the weather. The fallow season ' +
        'is not the opposite of fruitfulness. It is part of the mechanism by which ' +
        'fruitfulness keeps being possible. It is worth asking whether stillness functions ' +
        'the same way in a life.',
      ponder: [
        'Where does stillness feel most like a threat rather than a gift?',
        'What are you afraid would happen if you stopped striving in that area?',
        'What is one small way you could let a field rest this week?',
      ],
      prayer_prompts: [
        'Ask for the kind of trust that makes stillness possible.',
        'Name one thing you are gripping tightly and practice releasing it.',
        'Sit in silence for two minutes without asking for anything.',
      ],
      cross_refs: [
        { book: 'Genesis', chapter: 2, verse_start: 2, verse_end: 3 },
        { book: 'Hebrews', chapter: 4, verse_start: 9, verse_end: 11 },
      ],
    },
    {
      days_ago: 1,
      verse: { book: 'Isaiah', chapter: 30, verse_start: 15, verse_end: 15 },
      entry_type: 'challenge',
      thought:
        'Worth sitting with the harder possibility: that "be still" has become a way of ' +
        'avoiding something rather than trusting through it. Isaiah is speaking to people who ' +
        'wanted to solve a crisis by allying with Egypt — the busy, sensible, self-protective ' +
        'option. But rest can be self-protective too. Withdrawal wears the same clothes as ' +
        'peace and is much easier to justify. If stillness in this season means a difficult ' +
        'conversation keeps getting postponed, that is not the rest being offered here.',
      illustration:
        'There is a difference between a ship at anchor and a ship becalmed, though from the ' +
        'shore they look identical. The anchored ship has chosen its position and is holding ' +
        'it deliberately; the crew could raise anchor within the hour. The becalmed ship is ' +
        'simply stuck, waiting for conditions to change, its stillness entirely outside its ' +
        'control. Both are motionless. Only one is at rest. Sailors know which they are, ' +
        'because they know whether they could move if they decided to. That is the question ' +
        'worth asking of any season of stillness: is this chosen, or has choosing quietly ' +
        'stopped happening?',
      ponder: [
        'Is there something stillness is currently letting you avoid?',
        'Are you anchored or becalmed — and how would you tell the difference?',
        'What would change if the rest you are practising had a deadline?',
      ],
      prayer_prompts: [
        'Ask honestly whether rest has become avoidance anywhere.',
        'Pray for courage for whatever is being postponed.',
      ],
      cross_refs: [{ book: 'Philippians', chapter: 4, verse_start: 6, verse_end: 7 }],
    },
    {
      days_ago: 2,
      verse: { book: 'Mark', chapter: 6, verse_start: 31, verse_end: 31 },
      entry_type: 'affirming',
      thought:
        'The detail worth noticing is the timing. This comes immediately after the disciples ' +
        'return from their most fruitful stretch of work, with more demand than they can meet ' +
        'and no time even to eat. Precisely then, they are told to withdraw. Rest is not the ' +
        'reward for finished work here; it interrupts unfinished work. The need was still ' +
        'there when they left, and still there when they came back. Something in that ordering ' +
        'refuses the logic that rest must be earned.',
      illustration:
        'Orchestras tune between pieces, not because the instruments have failed but because ' +
        'they drift. Steel and wood respond to heat, humidity, and the simple tension of being ' +
        'played, and the drift is far too small for the player to hear from behind the ' +
        'instrument. It is only audible from the audience, and only once it has become bad ' +
        'enough to be embarrassing. So the tuning is scheduled rather than triggered — built ' +
        'into the shape of the evening, whether or not anyone thinks it is needed. The players ' +
        'who most need it are precisely the ones least able to tell.',
      ponder: [
        'When did you last stop before the work was finished?',
        'What convinces you that rest has to be earned?',
      ],
      prayer_prompts: [
        'Give thanks for work that matters, and for permission to leave it unfinished.',
        'Ask where a scheduled pause belongs in your week.',
      ],
      cross_refs: [{ book: 'Matthew', chapter: 11, verse_start: 28, verse_end: 30 }],
    },
    {
      days_ago: 4,
      verse: { book: 'Luke', chapter: 10, verse_start: 41, verse_end: 42 },
      entry_type: 'affirming',
      thought:
        'Martha is not rebuked for working. She is rebuked for being "anxious and troubled ' +
        'about many things" — the internal state, not the activity. It is possible to sit ' +
        'perfectly still and be entirely Martha. The one thing needful is not idleness but ' +
        'attention: a single point of focus rather than a scattered one. That reframes the ' +
        'question this thread keeps circling. Perhaps the invitation is less about doing less ' +
        'and more about being less divided while doing it.',
      illustration:
        'Photographers talk about depth of field. Open the aperture wide and only a narrow ' +
        'plane stays sharp — everything nearer and further dissolves. Close it down and almost ' +
        'everything is acceptably sharp, but nothing is truly sharp, and the image loses the ' +
        'subject entirely. Beginners tend to close the aperture, wanting to keep everything, ' +
        'and produce photographs where the eye has nowhere to rest. Choosing what will be ' +
        'blurred is not a loss of information. It is the entire act of composition, and it is ' +
        'what makes a photograph a photograph rather than a record.',
      ponder: [
        'What are the "many things" currently dividing your attention?',
        'If you could keep only one thing sharp this week, what would it be?',
      ],
      prayer_prompts: [
        'Ask for an undivided heart rather than an empty schedule.',
        'Name the many things, then set them down one at a time.',
      ],
      cross_refs: [],
    },
    {
      days_ago: 6,
      verse: { book: '1 Kings', chapter: 19, verse_start: 11, verse_end: 12 },
      entry_type: 'affirming',
      thought:
        'Elijah has just won publicly and comprehensively, and is now suicidal under a broom ' +
        'tree. What he gets is not a rebuke and not an explanation but food, sleep, and then a ' +
        'question. God is not in the wind, the earthquake, or the fire — all the dramatic ' +
        'forms of divine action Elijah had just been part of. The still small voice comes ' +
        'after them, and only to someone who has stopped long enough to notice something that ' +
        'quiet.',
      illustration:
        'Radio astronomers build their dishes in valleys deliberately chosen for what they ' +
        'lack. The Murchison in Western Australia was picked because it is one of the quietest ' +
        'places on earth at radio frequencies — hundreds of kilometres from broadcast towers, ' +
        'with mobile phones banned on site. The signals being listened for are unimaginably ' +
        'faint, some of them older than the solar system. No increase in the sensitivity of ' +
        'the instrument can compensate for a noisy site. The only way to hear something that ' +
        'quiet is to go somewhere the loud things are not.',
      ponder: [
        'What has been loud enough lately to drown out something quieter?',
        'What did you need most the last time you were exhausted — and did you get it?',
      ],
      prayer_prompts: [
        'Ask for the honesty to admit exhaustion before it becomes despair.',
        'Pray for ears tuned to the quiet register.',
      ],
      cross_refs: [{ book: 'Romans', chapter: 8, verse_start: 26, verse_end: 26 }],
    },
  ],
  notes: [
    {
      entry_days_ago: 0,
      days_ago: 0,
      body:
        'The fallow field image landed. I think I have been treating rest as the reward at the ' +
        'end of the productive stretch, and the stretch never actually ends.',
    },
    {
      entry_days_ago: 1,
      days_ago: 1,
      body:
        'Uncomfortable one. Anchored or becalmed is a fair question and I did not like my ' +
        'first answer. Coming back to this.',
    },
    {
      entry_days_ago: 4,
      days_ago: 3,
      body:
        'Undivided rather than unoccupied. That is a different thing than what I thought this ' +
        'thread was about when I started it.',
    },
  ],
  synthesis: {
    kind: 'on_demand',
    days_ago: 0,
    content: {
      threads: [
        'The thread began as a question about doing less, and has steadily become a question about attention. Four of the five entries land on focus rather than idleness.',
        'Rest keeps appearing as something scheduled rather than earned — the fallow field, the orchestra tuning between pieces, the disciples withdrawing mid-demand.',
        'Your notes show the framing shifting: "undivided rather than unoccupied" is a different question than the one you opened with.',
      ],
      tensions: [
        'Whether stillness is currently trust or avoidance is unresolved. You noted you did not like your first answer to it and have not returned to it since.',
        'You have written about rest as a practice but no entry has yet asked what would actually have to be given up to make room for it.',
      ],
      next_steps: [
        'Sit with the anchored-or-becalmed question again, in writing rather than in your head.',
        'Read Luke 10 in full rather than the two verses — the context around Martha changes the emphasis.',
        'Name one specific commitment that would need to end for this to be more than an idea.',
      ],
    },
  },
};

const VOCATION = {
  title: 'Whether to say yes to the new role',
  description:
    'A door has opened that I did not go looking for. Trying to work out whether the pull ' +
    'toward it is calling or just flattery.',
  seed: { book: 'Proverbs', chapter: 3, verse_start: 5, verse_end: 6 },
  status: 'active',
  focus: false,
  created_days_ago: 9,
  entries: [
    {
      days_ago: 0,
      verse: { book: 'James', chapter: 1, verse_start: 5, verse_end: 5 },
      entry_type: 'affirming',
      thought:
        'The promise here is oddly plain: ask, and it will be given. What it does not promise ' +
        'is a timetable, or that wisdom will arrive as certainty. Wisdom in James is practical ' +
        'and moral before it is informational — it looks more like knowing how to weigh a ' +
        'thing than like being told the answer. That is worth holding against the urge for a ' +
        'sign. You may be given clarity about what kind of person you want to be in the role ' +
        'long before you get clarity about whether to take it.',
      illustration:
        'Ship navigators before satellite positioning used dead reckoning: known speed, known ' +
        'heading, known elapsed time, and a great deal of arithmetic. It never gave a position ' +
        'so much as a best estimate carrying a growing error, and the discipline was to keep ' +
        'plotting anyway and to correct the moment a landmark or star fix became available. ' +
        'Navigators who waited for certainty before committing to a heading did not stay ' +
        'stationary. They drifted, and drifted without a record of having drifted, which is ' +
        'the harder problem to recover from.',
      ponder: [
        'What are you actually asking for — wisdom, or a guarantee?',
        'What kind of person would you need to be to do this role well?',
        'Which of those qualities are already true of you?',
      ],
      prayer_prompts: [
        'Ask for wisdom without specifying the form the answer must take.',
        'Pray for whoever holds this role if it is not you.',
      ],
      cross_refs: [{ book: 'Proverbs', chapter: 3, verse_start: 5, verse_end: 6 }],
    },
    {
      days_ago: 3,
      verse: { book: 'Proverbs', chapter: 3, verse_start: 5, verse_end: 6 },
      entry_type: 'challenge',
      thought:
        'A fair challenge to this thread: "lean not on your own understanding" is one of the ' +
        'most misused verses in scripture, usually pressed into service to mean "ignore your ' +
        'judgement and wait for a feeling." In context it sits inside a book that spends ' +
        'thirty-one chapters urging hard thinking, counsel, and the weighing of consequences. ' +
        'Trusting God with your understanding is not the same as suspending it. If the ' +
        'discernment here has consisted mostly of waiting for peace to descend, the verse is ' +
        'pulling the other way.',
      illustration:
        'A structural engineer signing off on a bridge does not know it will stand in the way ' +
        'a mathematician knows a proof. The soil surveys are samples, the load model is an ' +
        'approximation, and the steel will not be perfectly to spec. What the engineer has is ' +
        'a method: calculate carefully, apply a safety factor, get the work independently ' +
        'checked, and then sign. The signature is not a claim of certainty. It is the ' +
        'acceptance of responsibility for a decision made with incomplete information, which ' +
        'is the only kind of decision that has ever actually been available.',
      ponder: [
        'Have you done the ordinary work — counsel, numbers, honest cost — or only waited?',
        'Whose judgement do you trust here, and have you actually asked them?',
        'What would you decide if no feeling arrived at all?',
      ],
      prayer_prompts: [
        'Ask for clear thinking, not only calm feelings.',
        'Name someone wise you have been avoiding asking, and pray about why.',
      ],
      cross_refs: [],
    },
  ],
  notes: [
    {
      entry_days_ago: 3,
      days_ago: 2,
      body:
        'Ouch. I have not asked anyone. I have been calling that "praying about it" for nearly ' +
        'two weeks.',
    },
  ],
  synthesis: null,
};

const GENEROSITY = {
  title: 'Holding money more loosely',
  description:
    'A sense that I have been quietly anxious about money for years and that it has been ' +
    'shaping decisions I would not defend out loud.',
  seed: { book: 'Matthew', chapter: 6, verse_start: 21, verse_end: 21 },
  status: 'concluded',
  focus: false,
  created_days_ago: 88,
  concluded_days_ago: 12,
  entries: [
    {
      days_ago: 14,
      verse: { book: '2 Corinthians', chapter: 9, verse_start: 7, verse_end: 7 },
      entry_type: 'affirming',
      thought:
        'The emphasis falls on "as he has determined in his heart" — decided in advance, ' +
        'deliberately, rather than produced in the moment under pressure. Reluctance and ' +
        'compulsion are both named as the wrong soil, and both are what spontaneous giving ' +
        'tends to grow in. There is something freeing in that. Generosity is treated here as ' +
        'something you can plan your way into rather than something you must feel your way ' +
        'into, which is good news for anyone who has waited to feel generous first.',
      illustration:
        'Water diviners were once hired across rural Australia to find where to sink a bore, ' +
        'walking paddocks with a forked stick. Controlled trials have never supported the ' +
        'practice, yet it persisted for generations because it produced a decision, and any ' +
        'decision beat standing in a dry paddock arguing. Hydrogeology eventually offered ' +
        'something better: not a stronger feeling about where the water was, but a method for ' +
        'working it out beforehand. The relief was less in the accuracy than in no longer ' +
        'having to consult an instinct that was never trustworthy.',
      ponder: [
        'What have you decided in advance about giving, if anything?',
        'Where does reluctance show up most reliably?',
      ],
      prayer_prompts: [
        'Ask for freedom from the anxiety underneath the arithmetic.',
        'Decide one thing in advance rather than in the moment.',
      ],
      cross_refs: [{ book: 'Acts', chapter: 20, verse_start: 35, verse_end: 35 }],
    },
    {
      days_ago: 21,
      verse: { book: 'Luke', chapter: 12, verse_start: 15, verse_end: 15 },
      entry_type: 'affirming',
      thought:
        'The warning is against covetousness in the plural — "all covetousness" — as though it ' +
        'takes more than one form and you are unlikely to recognise every one of them in ' +
        'yourself. The reason given is not that possessions are wrong but that life does not ' +
        'consist of them, which is a claim about where meaning is located rather than a rule ' +
        'about spending. That is harder to obey and easier to test. You can check what you ' +
        'reach for when you want to feel that your life is going well.',
      illustration:
        'Sailors crossing long stretches of ocean once suffered scurvy while eating heavily ' +
        'and constantly — salt pork, hard biscuit, more calories than a man ashore would get. ' +
        'The ships were not short of food. They were short of one thing food was assumed to ' +
        'contain, and no quantity of what they had could substitute for the thing they did ' +
        'not. Crews would increase rations as symptoms worsened, which was reasonable given ' +
        'what they believed, and made no difference at all. More of the wrong thing is not a ' +
        'partial solution.',
      ponder: [
        'What do you reach for when you want to feel your life is going well?',
        'Where might you be increasing the ration rather than changing it?',
      ],
      prayer_prompts: [
        'Name what you are actually hungry for.',
        'Give thanks for enough, specifically and by name.',
      ],
      cross_refs: [{ book: 'Ecclesiastes', chapter: 5, verse_start: 10, verse_end: 10 }],
    },
  ],
  notes: [
    {
      entry_days_ago: 14,
      days_ago: 13,
      body:
        'Deciding in advance was the whole thing. Set it up as a standing transfer the same ' +
        'week and have not thought about it since, which is the point.',
    },
    {
      entry_days_ago: 21,
      days_ago: 20,
      body:
        'Increasing the ration rather than changing it. That describes about four years of ' +
        'decisions.',
    },
  ],
  synthesis: {
    kind: 'conclusion',
    days_ago: 12,
    content: {
      threads: [
        'The thread resolved faster than it opened. Deciding in advance, rather than waiting to feel generous, turned out to be the whole mechanism.',
        'Anxiety about money and the desire for more of it turned out to be the same problem wearing two faces, not two problems.',
      ],
      tensions: [
        'You concluded the thread once the practice was in place, which may be early. Practices hold under ordinary conditions and reveal themselves under pressure.',
      ],
      next_steps: [
        'Revisit this in six months, particularly if income changes in either direction.',
        'The "increasing the ration" note deserves its own thread if the pattern shows up outside money.',
      ],
    },
  },
};

const THREADS = [STILLNESS, VOCATION, GENEROSITY];

// ------------------------------------------------------------------ main

/**
 * Pick the user to seed. There is no demo *account* to create — the app's
 * account is whatever anonymous user the device minted on first launch, so
 * seeding means writing onto that existing row.
 */
async function resolveTargetUser() {
  const { data, error } = await db.auth.admin.listUsers({ perPage: 200 });
  if (error) throw error;

  if (explicitId) {
    const u = data.users.find((x) => x.id === explicitId);
    if (!u) throw new Error(`No user with id ${explicitId}`);
    return u;
  }

  const anons = data.users
    .filter((u) => u.is_anonymous)
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

  if (!anons.length) {
    throw new Error(
      'No anonymous users found. Launch the app in the Simulator first — the ' +
        'first launch creates one.',
    );
  }
  return anons[0];
}

/**
 * Wipe the target user's content. Cascades handle entries/notes/syntheses.
 * Refuses without --force if the user already has threads, because
 * --latest-anon could in principle pick a device you care about.
 */
async function resetDemoData(userId) {
  const { data: existing, error: countErr } = await db
    .from('topics')
    .select('id, title')
    .eq('user_id', userId);
  if (countErr) throw countErr;

  if (existing.length && !force) {
    console.error(
      `\nThis user already has ${existing.length} thread(s):\n` +
        existing.map((t) => `  · ${t.title}`).join('\n') +
        '\n\nRefusing to delete them. Re-run with --force if this is the ' +
        'Simulator account you meant.',
    );
    process.exit(1);
  }

  const { error } = await db.from('topics').delete().eq('user_id', userId);
  if (error) throw error;
  if (existing.length) console.log(`Cleared ${existing.length} existing thread(s).`);
}

async function seedThread(userId, spec) {
  const seedVerse = await resolve(spec.seed);

  const createdAt = new Date();
  createdAt.setDate(createdAt.getDate() - spec.created_days_ago);

  // A concluded thread is created ACTIVE and concluded at the end of this
  // function, never inserted as concluded. Two database triggers make the
  // direct route impossible:
  //   · guard_notes_on_concluded rejects notes attached to a concluded topic
  //   · guard_concluded_topic rejects any update to a concluded topic
  // so inserting it already-concluded leaves nowhere to put its notes. This
  // mirrors what actually happens in the app, where a thread accumulates
  // entries and notes and is concluded afterwards.
  const concludeAfterwards = spec.status === 'concluded';

  const topicRow = {
    user_id: userId,
    title: spec.title,
    description: spec.description,
    status: concludeAfterwards ? 'active' : spec.status,
    focus: spec.focus,
    created_at: createdAt.toISOString(),
    seed_book_number: seedVerse.book_number,
    seed_chapter: spec.seed.chapter,
    seed_verse_start: spec.seed.verse_start,
    seed_verse_end: spec.seed.verse_end ?? spec.seed.verse_start,
  };

  const { data: topic, error: topicErr } = await db
    .from('topics')
    .insert(topicRow)
    .select()
    .single();
  if (topicErr) throw topicErr;

  // entries, keyed by days_ago so notes can find them
  const entryIdByDaysAgo = new Map();
  for (const e of spec.entries) {
    const v = await resolve(e.verse);
    const crossRefs = await resolveCrossRefs(e.cross_refs ?? []);
    const date = daysAgo(e.days_ago);

    const { data: entry, error: entryErr } = await db
      .from('daily_entries')
      .insert({
        topic_id: topic.id,
        user_id: userId,
        date,
        verse_ref: v.ref,
        book_number: v.book_number,
        chapter: e.verse.chapter,
        verse_start: e.verse.verse_start,
        verse_end: e.verse.verse_end ?? e.verse.verse_start,
        verse_text: v.text,
        thought: e.thought,
        illustration: e.illustration,
        ponder: e.ponder,
        prayer_prompts: e.prayer_prompts,
        entry_type: e.entry_type,
        cross_refs: crossRefs,
        created_at: new Date(`${date}T04:00:00Z`).toISOString(),
      })
      .select('id')
      .single();
    if (entryErr) throw entryErr;
    entryIdByDaysAgo.set(e.days_ago, entry.id);
  }

  for (const n of spec.notes ?? []) {
    const entryId = entryIdByDaysAgo.get(n.entry_days_ago);
    if (!entryId) throw new Error(`Note references a missing entry (${n.entry_days_ago} days ago)`);
    const created = new Date();
    created.setDate(created.getDate() - n.days_ago);
    const { error } = await db.from('notes').insert({
      entry_id: entryId,
      topic_id: topic.id,
      user_id: userId,
      body: n.body,
      created_at: created.toISOString(),
    });
    if (error) throw error;
  }

  if (spec.synthesis) {
    // `sources` mirrors what the synthesize function computes server-side, so
    // the synthesis footnote renders in screenshots exactly as it will in
    // production. Derived from the rows just inserted, not invented.
    const refs = [];
    for (const e of spec.entries) {
      const r = displayRef(
        e.verse.book,
        e.verse.chapter,
        e.verse.verse_start,
        e.verse.verse_end ?? e.verse.verse_start,
      );
      if (!refs.includes(r)) refs.push(r);
    }
    const dates = spec.entries.map((e) => daysAgo(e.days_ago)).sort();
    const created = new Date();
    created.setDate(created.getDate() - spec.synthesis.days_ago);

    const { error } = await db.from('syntheses').insert({
      topic_id: topic.id,
      user_id: userId,
      kind: spec.synthesis.kind,
      content: {
        ...spec.synthesis.content,
        sources: {
          entry_refs: refs,
          entry_count: spec.entries.length,
          note_count: (spec.notes ?? []).length,
          first_entry_date: dates[0] ?? null,
          last_entry_date: dates[dates.length - 1] ?? null,
          model: 'claude-sonnet-4-6',
        },
      },
      created_at: created.toISOString(),
    });
    if (error) throw error;
  }

  // Now that entries, notes and the synthesis are in place, close the thread.
  // This is also what frees an active slot for the next thread — see the
  // ordering note in main().
  if (concludeAfterwards) {
    const c = new Date();
    c.setDate(c.getDate() - spec.concluded_days_ago);
    const { error } = await db
      .from('topics')
      .update({ status: 'concluded', concluded_at: c.toISOString() })
      .eq('id', topic.id);
    if (error) throw error;
  }

  console.log(
    `  ${spec.title} — ${spec.entries.length} entries, ` +
      `${(spec.notes ?? []).length} notes${spec.synthesis ? ', 1 synthesis' : ''} [${spec.status}]`,
  );
}

/**
 * Grant the demo user an entitlement so the app is reachable at all.
 *
 * Ponder is a hard paywall: without a live subscription row the Simulator
 * shows Paywall.tsx and there is nothing to screenshot. This writes the same
 * shape the rc-webhook edge function writes, marked SANDBOX and with a
 * transparently fake RevenueCat id so it can never be mistaken for a real
 * purchase in reporting.
 */
async function seedEntitlement(userId) {
  const expires = new Date();
  expires.setFullYear(expires.getFullYear() + 1);

  const { error } = await db.from('subscriptions').upsert(
    {
      user_id: userId,
      rc_app_user_id: `screenshot-seed:${userId}`,
      entitlement_id: 'pro',
      product_id: 'au.com.ponder.app.pro.annual',
      store: 'APP_STORE',
      period_type: 'NORMAL',
      environment: 'SANDBOX',
      purchased_at: new Date().toISOString(),
      expires_at: expires.toISOString(),
      last_event_id: 'screenshot-seed',
      raw: { seeded_by: 'seed-screenshots.mjs' },
    },
    { onConflict: 'user_id' },
  );
  if (error) throw error;
  console.log('Granted a 1-year sandbox entitlement (required to get past the paywall).');
}

async function main() {
  const user = await resolveTargetUser();
  console.log(
    `Target user: ${user.id}\n` +
      `  ${user.is_anonymous ? 'anonymous' : user.email}, created ${user.created_at}\n`,
  );

  await resetDemoData(user.id);
  await seedEntitlement(user.id);

  // Concluded threads first. Only 2 threads may be ACTIVE at once
  // (guard_active_topic_cap), and a concluded thread has to pass through
  // 'active' to receive its entries and notes. Seeding it first means it has
  // already been concluded — and its slot released — before the two genuinely
  // active threads are created. Seeding in declaration order would hit the cap.
  const ordered = [
    ...THREADS.filter((t) => t.status === 'concluded'),
    ...THREADS.filter((t) => t.status !== 'concluded'),
  ];

  console.log('Seeding threads:');
  for (const spec of ordered) {
    await seedThread(user.id, spec);
  }

  console.log(
    '\nDone. Force-quit and relaunch the app in the Simulator to pick these up.\n' +
      'Focus thread is "Learning to be still" — that is what Today will show.',
  );
}

main().catch((e) => {
  console.error(`\nSeed failed: ${e.message}`);
  process.exit(1);
});
