import { addCalendarMonths } from "./ccYearMonth.js";

/** `YYYY-MM` from `YYYY-MM-DD`. */
export function monthKeyFromYmd(ymd: string): string {
  return ymd.slice(0, 7);
}

/** True when `ymd` is the last UTC calendar day of its month. */
export function isLastCalendarDayOfMonth(ymd: string): boolean {
  const t = String(ymd ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(t)) return false;
  return t === monthEndUtcYmd(monthKeyFromYmd(t));
}

/**
 * Effective first statement month for Santander cartola DESDE/HASTA.
 * Non-day-1 DESDE marks the prior period boundary (not a movement month).
 */
export function effectiveCartolaStartYm(fromIso: string, toIso: string): string | null {
  const fromYm = monthKeyFromYmd(fromIso);
  const toYm = monthKeyFromYmd(toIso);
  if (!fromYm || !toYm) return fromYm || toYm || null;
  if (fromYm === toYm) return fromYm;
  if (isLastCalendarDayOfMonth(fromIso)) return addCalendarMonths(fromYm, 1);
  const fromDay = Number(fromIso.slice(8, 10));
  if (fromDay === 1) return fromYm;
  const span = expandYearMonthsInclusive(fromYm, toYm).length;
  if (span <= 2) return toYm;
  return addCalendarMonths(fromYm, 1);
}

/**
 * Zero-movement registry month keyed to cartola DESDE's calendar month on a multi-month
 * span (legacy split artifact). Ledger anchor handles the pre-history gap instead.
 */
export function isCartolaDesdeBoundaryPhantomMonth(opts: {
  period_month: string;
  period_from?: string | null;
  period_to?: string | null;
  movement_count: number;
}): boolean {
  if (Number(opts.movement_count) > 0) return false;
  const from = String(opts.period_from ?? "").trim();
  const to = String(opts.period_to ?? "").trim();
  if (!from || !to) return false;
  const fromYm = monthKeyFromYmd(from);
  if (opts.period_month !== fromYm) return false;
  if (fromYm === monthKeyFromYmd(to)) return false;
  const fromDay = Number(from.slice(8, 10));
  if (fromDay === 1) return false;
  return true;
}

/** Calendar months this cartola actually covers (movements + sin-mov statement month). */
export function cartolaStatementMonths(opts: {
  period_from?: string | null;
  period_to?: string | null;
  period_month?: string | null;
  movements?: { occurred_on?: string }[];
}): string[] {
  const movMonths: string[] = [];
  const seen = new Set<string>();
  for (const mv of opts.movements ?? []) {
    const ym = monthKeyFromYmd(String(mv.occurred_on ?? ""));
    if (!ym || seen.has(ym)) continue;
    seen.add(ym);
    movMonths.push(ym);
  }
  movMonths.sort();

  const toYm = monthKeyFromYmd(String(opts.period_to ?? ""));
  const pm = String(opts.period_month ?? "").trim();
  const periodMonth = /^\d{4}-\d{2}$/.test(pm) ? pm : toYm || null;

  if (movMonths.length >= 2) {
    let startYm = movMonths[0]!;
    const from = String(opts.period_from ?? "").trim();
    const to = String(opts.period_to ?? "").trim();
    if (from && to) {
      const effectiveStart = effectiveCartolaStartYm(from, to);
      if (effectiveStart && ymCompare(effectiveStart, startYm) > 0) {
        startYm = effectiveStart;
      }
    }
    const endYm = movMonths[movMonths.length - 1]!;
    const toBound = toYm && toYm > endYm ? toYm : endYm;
    return expandYearMonthsInclusive(startYm, toBound);
  }
  if (movMonths.length === 1) {
    return [movMonths[0]!];
  }
  if (periodMonth) return [periodMonth];
  return cartolaCalendarMonthsFromPeriod(opts.period_from, opts.period_to, opts.period_month);
}

/** Calendar months covered by cartola DESDE/HASTA (inclusive), with boundary adjustment. */
export function cartolaCalendarMonthsFromPeriod(
  fromIso: string | null | undefined,
  toIso: string | null | undefined,
  fallbackPeriodMonth?: string | null
): string[] {
  const from = String(fromIso ?? "").trim();
  const to = String(toIso ?? "").trim();
  const toYm = monthKeyFromYmd(to);
  const startYm = from && to ? effectiveCartolaStartYm(from, to) : null;
  if (startYm && toYm) return expandYearMonthsInclusive(startYm, toYm);
  const fb = String(fallbackPeriodMonth ?? "").trim();
  return /^\d{4}-\d{2}$/.test(fb) ? [fb] : [];
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

/**
 * Fill every month between the first and last point in `points` (interior gaps only).
 * Missing months are inserted using `makeEmpty(lastDayOfMonth)`.
 * Points are keyed by the `YYYY-MM` of their `as_of_date`; when two points share a
 * month the later `as_of_date` wins.
 */
export function densifyMonthlyPoints<T extends { as_of_date: string }>(
  points: readonly T[],
  makeEmpty: (asOfDate: string) => T
): T[] {
  if (points.length === 0) return [];
  const byYm = new Map<string, T>();
  for (const p of points) {
    const ym = p.as_of_date.slice(0, 7);
    const prev = byYm.get(ym);
    if (!prev || p.as_of_date > prev.as_of_date) byYm.set(ym, p);
  }
  const yms = [...byYm.keys()].sort();
  const minYm = yms[0]!;
  const maxYm = yms[yms.length - 1]!;
  const allYms = expandYearMonthsInclusive(minYm, maxYm);
  return allYms.map((ym) => byYm.get(ym) ?? makeEmpty(monthEndUtcYmd(ym)));
}

/**
 * Fill every year between first and last point.
 * `makeEmpty` receives a `YYYY-12-31` date string for the missing year.
 */
export function densifyYearlyPoints<T extends { as_of_date: string }>(
  points: readonly T[],
  makeEmpty: (asOfDate: string) => T
): T[] {
  if (points.length === 0) return [];
  const byYear = new Map<number, T>();
  for (const p of points) {
    const y = Number(p.as_of_date.slice(0, 4));
    if (!Number.isFinite(y)) continue;
    const prev = byYear.get(y);
    if (!prev || p.as_of_date > prev.as_of_date) byYear.set(y, p);
  }
  const years = [...byYear.keys()].sort((a, b) => a - b);
  if (years.length === 0) return [...points];
  const out: T[] = [];
  for (let y = years[0]!; y <= years[years.length - 1]!; y++) {
    out.push(byYear.get(y) ?? makeEmpty(`${y}-12-31`));
  }
  return out;
}

/** Every `YYYY-MM` from `minYm` through `maxYm` inclusive. */
export function expandYearMonthsInclusive(minYm: string, maxYm: string): string[] {
  const out: string[] = [];
  let y = Number(minYm.slice(0, 4));
  let m = Number(minYm.slice(5, 7));
  const yEnd = Number(maxYm.slice(0, 4));
  const mEnd = Number(maxYm.slice(5, 7));
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(yEnd) || !Number.isFinite(mEnd)) {
    return out;
  }
  while (y < yEnd || (y === yEnd && m <= mEnd)) {
    out.push(`${y}-${String(m).padStart(2, "0")}`);
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
  return out;
}

export function ymCompare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
