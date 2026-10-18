// The preview script must never write to the database.
//   deno test --no-lock --node-modules-dir=none --allow-env --allow-read scripts/book-day-preview.test.ts
import { assertReadOnly } from "./book-day-preview.ts";

Deno.test("sql() refuses anything but a single SELECT", () => {
  assertReadOnly("select 1");
  assertReadOnly("  with p as (select 1) select * from p");
  for (const q of ["insert into x values (1)", "update x set a=1", "delete from x", "select 1; delete from x", "drop table x"]) {
    let threw = false;
    try { assertReadOnly(q); } catch { threw = true; }
    if (!threw) throw new Error(`allowed: ${q}`);
  }
});

Deno.test("the script contains no write calls", async () => {
  const src = await Deno.readTextFile(new URL("./book-day-preview.ts", import.meta.url));
  const hit = src.match(/\b(insert\s+into|update\s+\w+\s+set|delete\s+from|upsert|\.rpc\(|\.from\(|createClient)/i);
  if (hit) throw new Error(`write-capable call found: ${hit[0]}`);
});
