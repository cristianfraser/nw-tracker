import { addCalendarMonths, chileTodayYmd } from "./calendarMonth";
import { timeRangeCutoffYmd, timeRangeToDays, type TimeRange } from "./timeRange";

/** Fraction of the range span kept as an empty lead before the first data as a truncation cue. */
const LEADING_GAP_FRACTION = 0.2;

function shiftYmd(ymd: string, deltaDays: number): string | null {
  const t = Date.parse(`${ymd}T00:00:00Z`);
  if (!Number.isFinite(t)) return null;
  return new Date(t + deltaDays * 86_400_000).toISOString().slice(0, 10);
}

/**
 * Left edge of the unified CC-chart window (shared across the D/M/Y toggle):
 * `max(range cutoff, first-data − 20% of the range span)`. The 20 % lead is an empty
 * truncation indicator kept only when the range reaches further back than the data — it never
 * extends past the range itself. `total` (no cutoff) starts flush at the data (no gap).
 * Returns null only when there is no cutoff AND no data to anchor on (⇒ no clip).
 */
export function rangeWindowStartYmd(
  range: TimeRange,
  firstDataYmd: string | null,
  todayYmd: string = chileTodayYmd()
): string | null {
  const cutoff = timeRangeCutoffYmd(range, todayYmd);
  if (cutoff == null) return firstDataYmd; // total: flush at first data (no truncation ⇒ no gap)
  if (firstDataYmd == null) return cutoff;
  const span = timeRangeToDays(range);
  const lead = shiftYmd(firstDataYmd, -Math.round(LEADING_GAP_FRACTION * span));
  if (lead == null) return cutoff;
  // Keep the later of the two: never reach past the range, but don't draw dead space beyond
  // the 20 % lead when the data starts well inside the range.
  return lead > cutoff ? lead : cutoff;
}

/**
 * Apply the shared window to month-keyed CC chart rows: left-clip to `rangeWindowStartYmd` and
 * pad empty leading months back to the window start, so the monthly/yearly charts show the same
 * 20 % truncation lead as the dense daily grid (aligned left edge across the D/M/Y toggle). The
 * right edge is untouched (the historial keeps its projected plan tail). `makeEmpty(month)` builds
 * a null-valued row for the lead.
 */
export function windowMonthRows<T>(
  rows: readonly T[],
  range: TimeRange,
  monthOf: (row: T) => string,
  hasData: (row: T) => boolean,
  makeEmpty: (month: string) => T,
  todayYmd?: string
): T[] {
  const firstDataRow = rows.find(hasData);
  const firstDataMonth = firstDataRow ? monthOf(firstDataRow) : null;
  const start = rangeWindowStartYmd(range, firstDataMonth ? `${firstDataMonth}-01` : null, todayYmd);
  if (start == null) return [...rows];
  const startMonth = start.slice(0, 7);
  const clipped = rows.filter((r) => monthOf(r) >= startMonth);
  const firstMonth = clipped.length > 0 ? monthOf(clipped[0]!) : firstDataMonth;
  const lead: T[] = [];
  if (firstMonth != null && startMonth < firstMonth) {
    for (let m = startMonth; m < firstMonth; m = addCalendarMonths(m, 1)) lead.push(makeEmpty(m));
  }
  return [...lead, ...clipped];
}
