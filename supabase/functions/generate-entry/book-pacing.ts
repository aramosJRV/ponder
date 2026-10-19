// ------------------------------------------------------------------
// Book-thread pacing. Pure: no env, no network. book-pacing.test.ts.
//
// The reader moves on only by opening what is in front of them. The next
// section appears on a later local date than the one they opened the
// current section on; until then nothing moves, however long they are
// away. An unopened (or finished) entry is carried forward to today's
// date rather than copied, so history keeps one entry per section and
// every app version finds it on Today.
//
// Dates are the reader's local calendar dates ("YYYY-MM-DD", profile
// timezone), so plain string comparison orders them.
// ------------------------------------------------------------------

export type LatestBookEntry = {
  id: string;
  date: string;
  opened_on: string | null;
  /** 1-based position of this entry's section, and the book's section count. */
  index: number;
  count: number;
};

export type BookStep =
  | { kind: "first" }
  | { kind: "next"; after: LatestBookEntry }
  | { kind: "roll"; id: string }
  | { kind: "none" };

export function nextBookStep(latest: LatestBookEntry | null, today: string): BookStep {
  if (!latest) return { kind: "first" };
  if (latest.date === today) return { kind: "none" };
  if (latest.opened_on && latest.opened_on < today && latest.index < latest.count) {
    return { kind: "next", after: latest };
  }
  return { kind: "roll", id: latest.id };
}

/** The calendar date at `at` in time zone `tz`; UTC when the zone is unknown. */
export function localDateAt(tz: string, at: Date): string {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(at);
  } catch {
    return new Intl.DateTimeFormat("en-CA", { timeZone: "UTC" }).format(at);
  }
}
