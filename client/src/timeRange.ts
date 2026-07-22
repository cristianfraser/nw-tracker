import { chileTodayYmd } from "./calendarMonth";

/**
 * Global chart range ("from now back"): governs how far back charts and the daily detalle
 * reach, independent of the D/M/Y granularity toggle (which keeps governing card metric
 * windows). `total` = full history (the pre-range behavior for monthly/yearly charts).
 */
export const TIME_RANGE_OPTIONS = ["30d", "60d", "90d", "6m", "1y", "5y", "10y", "total"] as const;
export type TimeRange = (typeof TIME_RANGE_OPTIONS)[number];

export function parseTimeRange(raw: string | null): TimeRange | null {
  return (TIME_RANGE_OPTIONS as readonly string[]).includes(raw ?? "")
    ? (raw as TimeRange)
    : null;
}

const RANGE_DAYS: Record<TimeRange, number> = {
  "30d": 30,
  "60d": 60,
  "90d": 90,
  "6m": 183,
  "1y": 366,
  "5y": 1827,
  "10y": 3653,
  // Server sentinel: 0 = since portfolio start.
  total: 0,
};

/** Calendar days for the daily endpoints (`0` = server-side "since portfolio start"). */
export function timeRangeToDays(range: TimeRange): number {
  return RANGE_DAYS[range];
}

/** Inclusive left cutoff for client-side monthly/yearly chart clipping; null = no clip. */
export function timeRangeCutoffYmd(range: TimeRange, todayYmd: string = chileTodayYmd()): string | null {
  const days = RANGE_DAYS[range];
  if (days === 0) return null;
  const t = Date.parse(`${todayYmd}T00:00:00Z`);
  if (!Number.isFinite(t)) return null;
  return new Date(t - days * 86_400_000).toISOString().slice(0, 10);
}

/** Filter chart rows to the range window (levels clip safely; aportes lines are levels too). */
export function clipPointsToTimeRange<T extends { as_of_date?: string | number | null }>(
  points: readonly T[],
  range: TimeRange,
  todayYmd?: string
): T[] {
  const cutoff = timeRangeCutoffYmd(range, todayYmd);
  if (cutoff == null) return [...points];
  return points.filter((p) => String(p.as_of_date ?? "") >= cutoff);
}
