// Generate TOMORROW's entries now for one account, then report whether each
// got Meditate phrases. A dry run of the nightly path for a test account.
//
//   SUPABASE_SERVICE_ROLE_KEY=... node scripts/test-tomorrow.mjs [email] [date]
//
// Writes real daily_entries rows for that account and date; the nightly run
// then skips them. Touches no other account.

import { execFileSync } from "node:child_process";

const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!KEY) {
  console.error("Set SUPABASE_SERVICE_ROLE_KEY in this shell first.");
  process.exit(1);
}
const EMAIL = process.argv[2] ?? "gamerefine.test@gmail.com";
const DATE = process.argv[3] ?? new Date(Date.now() + 86400_000).toISOString().slice(0, 10);
const URL = "https://rkslrbcbncecekghwbap.supabase.co/functions/v1/generate-entry";

function sql(q) {
  const out = execFileSync("supabase", ["db", "query", "--linked", "--agent", "no", "-o", "json", q], {
    encoding: "utf8",
  });
  const parsed = JSON.parse(out.slice(out.indexOf("[")));
  return Array.isArray(parsed) ? parsed : parsed.rows ?? [];
}

const esc = (s) => s.replace(/'/g, "''");
const [user] = sql(`select id from auth.users where email = '${esc(EMAIL)}'`);
if (!user) {
  console.error(`No account for ${EMAIL}`);
  process.exit(1);
}
console.log(`Generating ${DATE} for ${EMAIL} ...`);

const res = await fetch(URL, {
  method: "POST",
  headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
  body: JSON.stringify({ user_ids: [user.id], force_date: DATE }),
});
const body = await res.json();
if (!res.ok) {
  console.error(`generate-entry ${res.status}:`, body);
  process.exit(1);
}
for (const r of body.results ?? []) {
  console.log(`  thread ${String(r.topic_id).slice(0, 8)}: ${r.status}${r.source ? ` (${r.source})` : ""}`);
}

console.log("Waiting 30s for background phrases ...");
await new Promise((r) => setTimeout(r, 30_000));

const rows = sql(
  `select t.title, d.verse_ref, d.meditation from daily_entries d join topics t on t.id = d.topic_id ` +
    `where d.user_id = '${user.id}' and d.date = '${DATE}' order by t.title`,
);
console.log("");
for (const r of rows) {
  const m = r.meditation ?? {};
  const counts = ["WEB", "BSB", "KJV"].map((t) => `${t} ${(m[t] ?? []).length}`).join(", ");
  console.log(`${r.title} — ${r.verse_ref}`);
  console.log(`  phrases: ${r.meditation ? counts : "NONE"}`);
  if (m.BSB) console.log(`  BSB: ${m.BSB.join(" | ")}`);
}
