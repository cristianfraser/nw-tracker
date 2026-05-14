/** `YYYY-MM` from `YYYY-MM-DD`. */
export function monthKeyFromYmd(ymd: string): string {
  return ymd.slice(0, 7);
}

/** Last UTC calendar day of month for `YYYY-MM`. */
export function monthEndUtcYmd(monthKey: string): string {
  const [ys, ms] = monthKey.split("-");
  const y = Number(ys);
  const mo = Number(ms);
  if (!Number.isFinite(y) || !Number.isFinite(mo) || mo < 1 || mo > 12) return `${monthKey}-28`;
  return new Date(Date.UTC(y, mo, 0)).toISOString().slice(0, 10);
}

/** Every month-end from first month containing `minYmd` through month of `maxYmd`, inclusive. */
export function monthEndsBetweenInclusive(minYmd: string, maxYmd: string): string[] {
  const out: string[] = [];
  let y = Number(minYmd.slice(0, 4));
  let m = Number(minYmd.slice(5, 7));
  const yEnd = Number(maxYmd.slice(0, 4));
  const mEnd = Number(maxYmd.slice(5, 7));
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(yEnd) || !Number.isFinite(mEnd)) return out;
  while (y < yEnd || (y === yEnd && m <= mEnd)) {
    const mk = `${y}-${String(m).padStart(2, "0")}`;
    out.push(monthEndUtcYmd(mk));
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
  return out;
}
