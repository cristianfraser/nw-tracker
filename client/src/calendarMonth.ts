/** Keep in sync with server/src/calendarMonth.ts */

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
