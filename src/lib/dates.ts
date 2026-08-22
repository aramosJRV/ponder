/** Local date (device timezone) as YYYY-MM-DD — matches server generation,
 * which uses the profile timezone. */
export function todayLocal(): string {
  return new Intl.DateTimeFormat("en-CA").format(new Date());
}

export function formatLongDate(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-AU", {
    weekday: "long",
    day: "numeric",
    month: "long",
  });
}

// ---------------------------------------------------------------- timezones
//
// Capacitor's calendar-match schedule (`on: { hour, minute }`) always fires in
// the DEVICE's timezone — there is no way to tell Android "8am in
// Australia/Melbourne". So when the profile timezone differs from the device
// timezone we convert: work out the real instant of the next 8am-in-Melbourne,
// then let the caller read the device-local hour/minute off that Date.

/**
 * Offset of `timeZone` from UTC at instant `at`, in milliseconds.
 * Positive east of Greenwich. Resolved per-instant, so DST is accounted for.
 */
export function timezoneOffsetMs(timeZone: string, at: Date): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(at);

  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? "0");
  // hour12:false yields "24" for midnight in some engines — normalise.
  const asUTC = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour") % 24,
    get("minute"),
    get("second"),
  );
  // Drop sub-second precision so the difference is a clean offset.
  return asUTC - Math.floor(at.getTime() / 1000) * 1000;
}

/**
 * The next instant at which the wall clock in `timeZone` reads `hour`:00.
 * Today if still upcoming there, otherwise tomorrow.
 *
 * Falls back to device-local time if `timeZone` is missing or unrecognised —
 * a bad profile value must not stop the reminder from being scheduled at all.
 */
export function nextOccurrenceInZone(hour: number, timeZone: string, now = new Date()): Date {
  let offset: number;
  try {
    offset = timezoneOffsetMs(timeZone, now);
  } catch {
    const local = new Date(now);
    local.setHours(hour, 0, 0, 0);
    if (local.getTime() <= now.getTime()) local.setDate(local.getDate() + 1);
    return local;
  }

  // Shift into "zone time pretending to be UTC" so UTC setters do zone maths.
  const zoneNow = new Date(now.getTime() + offset);
  const target = new Date(zoneNow);
  target.setUTCHours(hour, 0, 0, 0);
  if (target.getTime() <= zoneNow.getTime()) target.setUTCDate(target.getUTCDate() + 1);

  // Re-resolve the offset at the target instant: a DST change between now and
  // then would otherwise put the reminder an hour out.
  let instant = new Date(target.getTime() - offset);
  const targetOffset = timezoneOffsetMs(timeZone, instant);
  if (targetOffset !== offset) instant = new Date(target.getTime() - targetOffset);
  return instant;
}

/** The device's IANA timezone, or null when the runtime won't say. */
export function deviceTimezone(): string | null {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
}
