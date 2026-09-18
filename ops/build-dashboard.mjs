#!/usr/bin/env node
/**
 * Ponder ops dashboard — fetch + render.
 *
 * Reads SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY from ../.env, pulls the
 * admin_snapshot log, and bakes it into dashboard.html.
 *
 * The service-role key stays on this machine: it is used only for the fetch
 * and is never written into stats.json or dashboard.html.
 *
 *   node ops/build-dashboard.mjs            # render from whatever is stored
 *   node ops/build-dashboard.mjs --refresh  # re-capture today's row first
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

function loadEnv() {
  const out = {};
  for (const line of readFileSync(resolve(ROOT, '.env'), 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#') || !t.includes('=')) continue;
    const i = t.indexOf('=');
    out[t.slice(0, i).trim()] = t.slice(i + 1).trim().replace(/^["']|["']$/g, '');
  }
  return out;
}

const env = loadEnv();
const URL_ = env.SUPABASE_URL;
const KEY = env.SUPABASE_SERVICE_ROLE_KEY;
if (!URL_ || !KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env');
  process.exit(1);
}
/**
 * Node's fetch() ignores HTTPS_PROXY, and the Cowork VM reaches the internet
 * only through that proxy (DNS for supabase.co fails otherwise). curl honours
 * it automatically and behaves the same on real macOS, so it is the portable
 * choice here.
 *
 * Headers go in on stdin via `curl -K -` rather than argv, so the service-role
 * key never shows up in the process list.
 */
function req(url, { post = false } = {}) {
  const cfg = [
    `url = "${url}"`,
    `header = "apikey: ${KEY}"`,
    `header = "Authorization: Bearer ${KEY}"`,
    'silent', 'show-error', 'max-time = 60',
    'write-out = "\\n%{http_code}"',
    ...(post ? ['request = POST', 'header = "Content-Type: application/json"', 'data = "{}"'] : []),
  ].join('\n');
  const out = execFileSync('curl', ['-K', '-'], { input: cfg, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const i = out.lastIndexOf('\n');
  return { status: Number(out.slice(i + 1).trim()), body: out.slice(0, i) };
}

if (process.argv.includes('--refresh')) {
  const r = req(`${URL_}/rest/v1/rpc/capture_admin_snapshot`, { post: true });
  // Not fatal: the nightly cron is the real capture path. A failure here just
  // means the dashboard shows last night's numbers instead of this minute's.
  console.log(r.status < 300 ? "refreshed today's snapshot" : `refresh skipped (HTTP ${r.status})`);
}

const res = req(`${URL_}/rest/v1/admin_snapshot?select=captured_on,captured_at,payload&order=captured_on.desc&limit=60`);
if (res.status !== 200) {
  console.error(`Fetch failed: HTTP ${res.status} ${res.body.slice(0, 300)}`);
  process.exit(1);
}
const rows = JSON.parse(res.body);

const generatedAt = new Date().toISOString();
writeFileSync(resolve(HERE, 'stats.json'),
  JSON.stringify({ generatedAt, rows }, null, 2));

const tpl = readFileSync(resolve(HERE, 'dashboard-template.html'), 'utf8');
const html = tpl
  .replace('/*__DATA__*/[]/*__END__*/', JSON.stringify(rows))
  .replace('/*__GENAT__*/', generatedAt);
writeFileSync(resolve(HERE, 'dashboard.html'), html);

const latest = rows[0];
console.log(`rendered ${rows.length} snapshot(s) -> ops/dashboard.html`);
if (latest) {
  const u = latest.payload.users || {}, c = latest.payload.cost || {};
  console.log(`  latest ${latest.captured_on}: WAU ${u.wau}, DAU ${u.dau}, installs ${u.total}, 7d spend $${c.d7_usd}`);
}
