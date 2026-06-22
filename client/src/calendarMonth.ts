/** Keep in sync with server/src/calendarMonth.ts */

/** Chile calendar today as YYYY-MM-DD (matches server `chileCalendarTodayYmd`). */
export function chileTodayYmd(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Santiago",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

export function monthEndUtcYmd(monthKey: string): string {
  const [ys, ms] = monthKey.split("-");
  const y = Number(ys);
  const mo = Number(ms);
  if (!Number.isFinite(y) || !Number.isFinite(mo) || mo < 1 || mo > 12) return `${monthKey}-28`;
  return new Date(Date.UTC(y, mo, 0)).toISOString().slice(0, 10);
}

export function ymCompare(a: string, b: string): number {
  return a.localeCompare(b);
}

export function addCalendarMonths(ym: string, delta: number): string {
  const m = /^(\d{4})-(\d{2})$/.exec(ym.trim());
  if (!m) return ym;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  if (!Number.isFinite(y) || mo < 1 || mo > 12) return ym;
  const d = new Date(Date.UTC(y, mo - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}
