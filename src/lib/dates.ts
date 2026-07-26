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
