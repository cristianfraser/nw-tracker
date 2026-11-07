import {
  addCalendarMonths,
  expandYearMonthsInclusive,
  isLastCalendarDayOfMonth,
  monthEndUtcYmd,
  monthKeyFromYmd,
  ymCompare,
} from "nw-tracker-contracts";

/**
 * The generic month helpers live in `nw-tracker-contracts` (formats/months.ts); they are
 * re-exported here because about 85 server modules import them from this file. New code imports
 * them from `nw-tracker-contracts`; this file keeps the cartola period rules.
 */
export {
  expandYearMonthsInclusive,
  isLastCalendarDayOfMonth,
  monthEndUtcYmd,
  monthEndsBetweenInclusive,
  monthKeyFromYmd,
  ymCompare,
} from "nw-tracker-contracts";

/**
 * Effective first statement month for Santander cartola DESDE/HASTA.
 * Non-day-1 DESDE marks the prior period boundary (not a movement month).
 * Both bounds are required: a missing one throws rather than standing in for the other.
 */
export function effectiveCartolaStartYm(fromIso: string, toIso: string): string {
  const fromYm = monthKeyFromYmd(fromIso);
  const toYm = monthKeyFromYmd(toIso);
  if (!fromYm || !toYm) {
    throw new Error(
      `effectiveCartolaStartYm: cartola period ${!fromYm ? "start (DESDE)" : "end (HASTA)"} missing ` +
        `(${JSON.stringify(fromIso)}..${JSON.stringify(toIso)})`
    );
  }
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
