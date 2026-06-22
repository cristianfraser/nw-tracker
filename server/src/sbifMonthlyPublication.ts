import type { ChileWallClock } from "./chileDate.js";
import { monthEndUtcYmd } from "./calendarMonth.js";

export type YearMonthParts = { y: number; m: number };

export function nextCalendarMonthParts(y: number, m: number): YearMonthParts {
  return m === 12 ? { y: y + 1, m: 1 } : { y, m: m + 1 };
}

/**
 * After the 9th (Chile), SII / BCentral publish daily UF through the end of the **next**
 * calendar month (e.g. on 2026-06-09 → through 2026-07-31).
 */
export function sbifMonthlyPublicationEndYmd(cl: ChileWallClock): string {
  const next = nextCalendarMonthParts(cl.year, cl.month);
  const monthKey = `${next.y}-${String(next.m).padStart(2, "0")}`;
  return monthEndUtcYmd(monthKey);
}

/** UTM month that must be present after the day-9 publication (next calendar month). */
export function sbifMonthlyPublicationTargetMonth(cl: ChileWallClock): YearMonthParts {
  return nextCalendarMonthParts(cl.year, cl.month);
}

export function monthPartsToMonthKey(p: YearMonthParts): string {
  return `${p.y}-${String(p.m).padStart(2, "0")}`;
}

export function compareYearMonth(a: YearMonthParts, b: YearMonthParts): number {
  if (a.y !== b.y) return a.y - b.y;
  return a.m - b.m;
}

export function isSbifUfCoverageComplete(maxUfDate: string | null, cl: ChileWallClock): boolean {
  if (!maxUfDate) return false;
  return maxUfDate >= sbifMonthlyPublicationEndYmd(cl);
}

export function isSbifUtmCoverageComplete(
  maxUtm: YearMonthParts | null,
  cl: ChileWallClock
): boolean {
  if (!maxUtm) return false;
  return compareYearMonth(maxUtm, sbifMonthlyPublicationTargetMonth(cl)) >= 0;
}

export function isSbifUfStale(
  cl: ChileWallClock,
  opts?: { forceSbif?: boolean; maxUfDate?: string | null; lastSyncYmd?: string }
): boolean {
  void opts?.lastSyncYmd;
  if (opts?.forceSbif) return true;
  if (cl.day < 9) return false;
  const max = opts?.maxUfDate ?? null;
  if (!max) return true;
  const currentMonthEnd = monthEndUtcYmd(cl.monthKey);
  if (max < currentMonthEnd) return true;
  if (isSbifUfCoverageComplete(max, cl)) return false;
  // Day-9 publication only — partial forward horizon after the 9th is not a daily stale signal.
  return cl.day === 9;
}

export function isSbifUtmStale(
  cl: ChileWallClock,
  opts?: { forceSbif?: boolean; maxUtm?: YearMonthParts | null }
): boolean {
  if (opts?.forceSbif) return true;
  if (cl.day < 9) return false;
  return !isSbifUtmCoverageComplete(opts?.maxUtm ?? null, cl);
}
