import { chileCalendarTodayYmd } from "./chileDate.js";
import { monthKeyFromYmd } from "./calendarMonth.js";

/** Minimal fields used when picking one row per calendar month. */
export type MonthlyPerfPickRow = {
  as_of_date: string;
  net_capital_flow: number;
  nominal_pl: number | null;
};

/** Ignore float noise when comparing money fields (CLP or converted USD). */
export const MONTH_ROW_EPS = 0.01;

/**
 * Pick one row per calendar month when multiple snapshots exist (e.g. mid-month “today” + month-end).
 * In-progress month: latest row on or before Chile today. Closed months: latest `as_of_date` in the month
 * (month-end cierre for MTD anchors — not max |P/L|).
 */
export function pickRepresentativeMonthlyPerfRow<T extends MonthlyPerfPickRow>(
  rows: T[],
  monthKey: string
): T {
  const asc = [...rows].sort((a, b) => String(a.as_of_date).localeCompare(String(b.as_of_date)));
  if (asc.length === 1) return asc[0]!;
  const today = chileCalendarTodayYmd();
  const currentMk = monthKeyFromYmd(today);
  if (monthKey === currentMk) {
    const onOrBeforeToday = asc.filter((r) => String(r.as_of_date) <= today);
    if (onOrBeforeToday.length > 0) return onOrBeforeToday[onOrBeforeToday.length - 1]!;
    return asc[asc.length - 1]!;
  }
  return asc[asc.length - 1]!;
}
