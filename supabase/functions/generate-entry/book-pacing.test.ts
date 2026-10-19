// Pacing for book threads. No network.
//   deno test --no-lock --node-modules-dir=none supabase/functions/generate-entry/book-pacing.test.ts

import { type LatestBookEntry, localDateAt, nextBookStep } from "./book-pacing.ts";

const eq = (a: unknown, b: unknown, what: string) => {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${what}: got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`);
};
const entry = (p: Partial<LatestBookEntry>): LatestBookEntry => ({
  id: "e1", date: "2026-10-20", opened_on: null, index: 9, count: 48, ...p,
});

Deno.test("new thread starts at section 1", () => {
  eq(nextBookStep(null, "2026-10-20"), { kind: "first" }, "first");
});

Deno.test("opened today -> nothing new until tomorrow", () => {
  eq(nextBookStep(entry({ opened_on: "2026-10-20" }), "2026-10-20"), { kind: "none" }, "same day");
});

Deno.test("opened yesterday -> next section today", () => {
  const e = entry({ date: "2026-10-20", opened_on: "2026-10-20" });
  eq(nextBookStep(e, "2026-10-21"), { kind: "next", after: e }, "next day");
});

Deno.test("not opened -> stays put, carried to today", () => {
  eq(nextBookStep(entry({ date: "2026-10-20" }), "2026-10-21"), { kind: "roll", id: "e1" }, "not opened");
});

Deno.test("away a week -> same section, carried to today", () => {
  eq(nextBookStep(entry({ date: "2026-10-20" }), "2026-10-27"), { kind: "roll", id: "e1" }, "a week unopened");
});

Deno.test("opened, then away a week -> exactly one section on", () => {
  const e = entry({ date: "2026-10-20", opened_on: "2026-10-20" });
  eq(nextBookStep(e, "2026-10-27"), { kind: "next", after: e }, "a week after opening");
});

Deno.test("an entry carried forward and opened today does not advance today", () => {
  eq(nextBookStep(entry({ date: "2026-10-18", opened_on: "2026-10-21" }), "2026-10-21"), { kind: "roll", id: "e1" }, "carried");
});

Deno.test("last section opened -> finished: no new section, last one stays on today", () => {
  const e = entry({ index: 48, count: 48, date: "2026-10-20", opened_on: "2026-10-20" });
  eq(nextBookStep(e, "2026-10-21"), { kind: "roll", id: "e1" }, "finished");
  eq(nextBookStep({ ...e, date: "2026-10-21" }, "2026-10-21"), { kind: "none" }, "finished today");
});

Deno.test("entry dated after today (time zone moved west) is brought back to today", () => {
  eq(nextBookStep(entry({ date: "2026-10-22" }), "2026-10-21"), { kind: "roll", id: "e1" }, "future date");
});

Deno.test("local date around midnight, three time zones", () => {
  // 20 Oct 23:59 and 21 Oct 00:01 in each zone (Sydney is UTC+11 in October,
  // London UTC+1, Los Angeles UTC-7).
  const cases: [string, string, string][] = [
    ["Australia/Sydney", "2026-10-20T12:59:00Z", "2026-10-20T13:01:00Z"],
    ["Europe/London", "2026-10-20T22:59:00Z", "2026-10-20T23:01:00Z"],
    ["America/Los_Angeles", "2026-10-21T06:59:00Z", "2026-10-21T07:01:00Z"],
  ];
  for (const [tz, before, after] of cases) {
    const opened = localDateAt(tz, new Date(before));
    const today = localDateAt(tz, new Date(after));
    eq([opened, today], ["2026-10-20", "2026-10-21"], tz);
    const e = entry({ date: opened, opened_on: opened });
    eq(nextBookStep(e, opened).kind, "none", `${tz} opened at 23:59, still same day`);
    eq(nextBookStep(e, today).kind, "next", `${tz} two minutes later is the next day`);
  }
});

Deno.test("an unknown time zone falls back to UTC instead of failing", () => {
  eq(localDateAt("Not/AZone", new Date("2026-10-20T12:00:00Z")), "2026-10-20", "fallback");
});
