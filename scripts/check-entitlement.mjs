/**
 * Diagnostic: why is the Simulator still showing the paywall?
 *
 *   node scripts/check-entitlement.mjs
 *
 * Lists every anonymous user newest-first, and for each one whether it has a
 * subscription row, whether that row is still in date, and how much seeded
 * content it has. The user the app is actually signed in as is normally the
 * newest — the one marked TARGET, which is what seed-screenshots.mjs
 * --latest-anon writes to.
 *
 * Read-only. Writes nothing.
 */

import { createClient } from '@supabase/supabase-js';
import { loadEnv } from './lib/env.mjs';

loadEnv();

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !key) {
  console.error(
    '\nMissing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env\n' +
      'Get the service role key from:\n' +
      '  Supabase Dashboard > Project Settings > API Keys > Secret keys\n',
  );
  process.exit(1);
}

const db = createClient(url, key, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const { data: users, error } = await db.auth.admin.listUsers({ perPage: 200 });
if (error) throw error;

const anons = users.users
  .filter((u) => u.is_anonymous)
  .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

if (!anons.length) {
  console.log(
    '\nNo anonymous users exist at all.\n' +
      'The app has never completed a launch against this project. Run it in ' +
      'the Simulator and wait for a screen to appear, then re-run this.\n',
  );
  process.exit(0);
}

console.log(`\n${anons.length} anonymous user(s), newest first:\n`);

for (const [i, u] of anons.entries()) {
  const [{ data: sub }, { count: threads }] = await Promise.all([
    db
      .from('subscriptions')
      .select('expires_at, environment, rc_app_user_id')
      .eq('user_id', u.id)
      .maybeSingle(),
    db
      .from('topics')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', u.id),
  ]);

  const live = sub && (!sub.expires_at || new Date(sub.expires_at) > new Date());
  const seeded = String(sub?.rc_app_user_id ?? '').startsWith('screenshot-seed:');

  console.log(`${i === 0 ? '  TARGET  ' : '          '}${u.id}`);
  console.log(`            created  ${u.created_at}`);
  console.log(
    `            entitled ${
      !sub
        ? 'NO — no subscription row'
        : live
          ? `YES — ${sub.environment}${seeded ? ' (seeded)' : ''}, expires ${sub.expires_at}`
          : `NO — row exists but EXPIRED ${sub.expires_at}`
    }`,
  );
  console.log(`            threads  ${threads ?? 0}\n`);
}

const target = anons[0];
const { data: targetSub } = await db
  .from('subscriptions')
  .select('expires_at')
  .eq('user_id', target.id)
  .maybeSingle();

console.log('-'.repeat(64));

if (!targetSub) {
  console.log(
    '\nThe newest anonymous user has NO entitlement row.\n' +
      'The seed either did not run or errored. Run:\n\n' +
      '  node scripts/seed-screenshots.mjs --latest-anon\n\n' +
      'and read its output for an error.\n',
  );
} else if (anons.length > 1 && anons.some((u, i) => i > 0)) {
  console.log(
    '\nThe newest anonymous user IS entitled.\n\n' +
      'If the Simulator still shows the paywall, the app is signed in as one\n' +
      'of the OTHER users above — the seed wrote to the wrong one. Cleanest\n' +
      'fix is to start from one known user:\n\n' +
      '  Simulator > Device > Erase All Content and Settings\n' +
      '  then rerun the app, then rerun the seed.\n\n' +
      'That leaves the old anonymous users behind as junk rows, which is\n' +
      'harmless for now but worth cleaning up before launch.\n',
  );
} else {
  console.log(
    '\nThe only anonymous user is entitled. If the paywall is still showing,\n' +
      'the app has stale state — force-quit it in the Simulator (swipe up on\n' +
      'the app switcher, not just Home) and launch again.\n',
  );
}
