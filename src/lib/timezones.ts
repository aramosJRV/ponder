/**
 * Curated timezone picker list.
 *
 * `Intl.supportedValuesOf("timeZone")` returns ~420 IANA IDs — unusable as a
 * <select> on a phone. This is a short, city-labelled list covering the zones a
 * user of this app plausibly lives in, grouped by region.
 *
 * These are IANA zone IDs, not fixed UTC offsets, and that is deliberate: the
 * nightly generation cron (`now() at time zone p.timezone`) and the local
 * reminder both schedule a WALL-CLOCK hour. A fixed offset would drift by an
 * hour across DST for half the year.
 *
 * A zone not in this list is never lost — Settings pins the profile's current
 * zone and the device zone to the top of the picker.
 */

export type TimezoneOption = { id: string; label: string };
export type TimezoneGroup = { region: string; zones: TimezoneOption[] };

export const TIMEZONE_GROUPS: TimezoneGroup[] = [
  {
    region: "Australia & Pacific",
    zones: [
      { id: "Australia/Sydney", label: "Sydney, Melbourne, Canberra, Hobart" },
      { id: "Australia/Brisbane", label: "Brisbane" },
      { id: "Australia/Adelaide", label: "Adelaide" },
      { id: "Australia/Darwin", label: "Darwin" },
      { id: "Australia/Perth", label: "Perth" },
      { id: "Pacific/Auckland", label: "Auckland, Wellington" },
      { id: "Pacific/Fiji", label: "Fiji" },
      { id: "Pacific/Honolulu", label: "Honolulu" },
    ],
  },
  {
    region: "Americas",
    zones: [
      { id: "America/Los_Angeles", label: "Los Angeles, Vancouver, Seattle" },
      { id: "America/Denver", label: "Denver, Calgary" },
      { id: "America/Phoenix", label: "Phoenix" },
      { id: "America/Chicago", label: "Chicago, Winnipeg, Mexico City" },
      { id: "America/New_York", label: "New York, Toronto, Miami" },
      { id: "America/Halifax", label: "Halifax" },
      { id: "America/Bogota", label: "Bogotá, Lima" },
      { id: "America/Sao_Paulo", label: "São Paulo, Rio de Janeiro" },
      { id: "America/Argentina/Buenos_Aires", label: "Buenos Aires" },
      { id: "America/Anchorage", label: "Anchorage" },
    ],
  },
  {
    region: "Europe & Africa",
    zones: [
      { id: "Europe/London", label: "London, Dublin, Lisbon" },
      { id: "Europe/Paris", label: "Paris, Berlin, Madrid, Rome, Amsterdam" },
      { id: "Europe/Athens", label: "Athens, Helsinki, Kyiv" },
      { id: "Europe/Moscow", label: "Moscow" },
      { id: "Africa/Lagos", label: "Lagos, Kinshasa" },
      { id: "Africa/Cairo", label: "Cairo" },
      { id: "Africa/Johannesburg", label: "Johannesburg, Harare" },
      { id: "Africa/Nairobi", label: "Nairobi, Addis Ababa" },
    ],
  },
  {
    region: "Asia & Middle East",
    zones: [
      { id: "Asia/Jerusalem", label: "Jerusalem" },
      { id: "Asia/Dubai", label: "Dubai, Abu Dhabi" },
      { id: "Asia/Karachi", label: "Karachi" },
      { id: "Asia/Kolkata", label: "Mumbai, Delhi, Kolkata, Colombo" },
      { id: "Asia/Dhaka", label: "Dhaka" },
      { id: "Asia/Bangkok", label: "Bangkok, Jakarta, Hanoi" },
      { id: "Asia/Singapore", label: "Singapore, Kuala Lumpur" },
      { id: "Asia/Manila", label: "Manila" },
      { id: "Asia/Hong_Kong", label: "Hong Kong" },
      { id: "Asia/Shanghai", label: "Beijing, Shanghai" },
      { id: "Asia/Seoul", label: "Seoul" },
      { id: "Asia/Tokyo", label: "Tokyo" },
    ],
  },
  {
    region: "Other",
    zones: [{ id: "UTC", label: "UTC" }],
  },
];

const BY_ID = new Map<string, TimezoneOption>(
  TIMEZONE_GROUPS.flatMap((g) => g.zones).map((z) => [z.id, z]),
);

export function isCuratedZone(id: string): boolean {
  return BY_ID.has(id);
}

/** "Sydney, Melbourne…" for a curated zone, else the raw IANA id. */
export function zoneLabel(id: string): string {
  return BY_ID.get(id)?.label ?? id;
}

/** Current UTC offset of `id` as "+10:00" / "-05:30", or "" if unknown. */
export function zoneOffsetLabel(id: string, at = new Date()): string {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: id,
      timeZoneName: "longOffset",
    }).formatToParts(at);
    const name = parts.find((p) => p.type === "timeZoneName")?.value ?? "";
    // "GMT+10:00" → "+10:00"; bare "GMT" → "+00:00"
    const stripped = name.replace(/^(GMT|UTC)/, "");
    return stripped || "+00:00";
  } catch {
    return "";
  }
}

/** "Sydney, Melbourne… (UTC+10:00)" */
export function zoneOptionLabel(id: string): string {
  const offset = zoneOffsetLabel(id);
  return offset ? `${zoneLabel(id)} (UTC${offset})` : zoneLabel(id);
}
