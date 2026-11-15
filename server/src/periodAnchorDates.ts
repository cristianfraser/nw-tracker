import { monthEndUtcYmd } from "./calendarMonth.js";
import { chileCalendarAddDays, chileCalendarTodayYmd } from "./chileDate.js";

/**
 * Calendar arithmetic of the period anchors (MTD / YTD / DTD): pure dates, no account and no
 * value, so the deposit readers and the netting helpers can use it below the period marks.
 */
export type PeriodAnchor = "mtd" | "ytd" | "dtd";

export function priorCalendarMonthKeyFromToday(todayYmd: string): string {
  const y = Number(todayYmd.slice(0, 4));
  const m = Number(todayYmd.slice(5, 7));
  if (!Number.isFinite(y) || !Number.isFinite(m)) return todayYmd.slice(0, 7);
  if (m === 1) return `${y - 1}-12`;
  return `${y}-${String(m - 1).padStart(2, "0")}`;
}

/** Calendar month immediately before `monthKey` (`YYYY-MM`). */
export function priorCalendarMonthKey(monthKey: string): string {
  const y = Number(monthKey.slice(0, 4));
  const m = Number(monthKey.slice(5, 7));
  if (!Number.isFinite(y) || !Number.isFinite(m)) return monthKey;
  if (m === 1) return `${y - 1}-12`;
  return `${y}-${String(m - 1).padStart(2, "0")}`;
}

/** Prior period-end label date (Chile calendar) for MTD / YTD / DTD anchors. */
export function priorPeriodEndYmd(anchor: PeriodAnchor, todayYmd: string = chileCalendarTodayYmd()): string {
  if (anchor === "mtd") {
    return monthEndUtcYmd(priorCalendarMonthKeyFromToday(todayYmd));
  }
  if (anchor === "ytd") {
    const y = Number(todayYmd.slice(0, 4));
    if (!Number.isFinite(y)) return todayYmd;
    return `${y - 1}-12-31`;
  }
  return chileCalendarAddDays(todayYmd, -1);
}
