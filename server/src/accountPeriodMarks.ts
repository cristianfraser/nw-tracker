import type { AccountMonthlyPerformanceRow } from "./accountPerformance.js";
import { accountMarkClpAtYmd } from "./accountMarkClpAtYmd.js";
import { monthEndUtcYmd, monthKeyFromYmd } from "./calendarMonth.js";
import { chileCalendarAddDays, chileCalendarTodayYmd } from "./chileDate.js";

export type MonthEndCloseForAccountOpts = {
  notes?: string | null;
  name?: string | null;
};

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

/**
 * Latest `closing_value` on or before period-end for `monthKey`.
 * Prefers an exact month-end row when present.
 */
export function monthEndCloseFromPerfRows(
  monthly: readonly AccountMonthlyPerformanceRow[],
  monthKey: string
): number | null {
  const monthEnd = monthEndUtcYmd(monthKey);
  let bestOnOrBefore: AccountMonthlyPerformanceRow | null = null;
  for (const row of monthly) {
    if (monthKeyFromYmd(row.as_of_date) !== monthKey) continue;
    if (row.as_of_date > monthEnd) continue;
    if (row.closing_value == null || !Number.isFinite(row.closing_value)) continue;
    if (!bestOnOrBefore || row.as_of_date >= bestOnOrBefore.as_of_date) {
      bestOnOrBefore = row;
    }
  }
  if (bestOnOrBefore) return bestOnOrBefore.closing_value;

  const exact = monthly.find((r) => r.as_of_date === monthEnd);
  const v = exact?.closing_value;
  return v != null && Number.isFinite(v) ? v : null;
}

/**
 * Calendar month-end close for one account: live/historical mark at `monthEndUtcYmd(monthKey)`
 * (same priority as dashboard cards), then perf rows.
 *
 * The current month is marked as of Chile-today, never the future month-end: ledger-based
 * cash accounts sum movements through the mark date, so a future-dated movement inside the
 * month (e.g. a stock_buy settling tomorrow) must not count until its date arrives — equity
 * MTM only counts units through today, and mixing the two skews consolidated bucket totals.
 */
export function monthEndCloseClpForAccount(
  accountId: number,
  bucketSlug: string,
  monthlyRows: readonly AccountMonthlyPerformanceRow[],
  monthKey: string,
  opts?: MonthEndCloseForAccountOpts
): number | null {
  const monthEnd = monthEndUtcYmd(monthKey);
  const today = chileCalendarTodayYmd();
  const ymd = monthEnd > today ? today : monthEnd;
  const mark = accountMarkClpAtYmd(accountId, ymd, bucketSlug, {
    notes: opts?.notes ?? null,
    name: opts?.name ?? null,
  });
  if (mark?.value_clp != null && Number.isFinite(mark.value_clp)) return mark.value_clp;
  return monthEndCloseFromPerfRows(monthlyRows, monthKey);
}

/** True when the perf series' earliest row is after `boundaryYmd` — the account had no value then. */
function perfSeriesStartsAfter(
  monthly: readonly AccountMonthlyPerformanceRow[],
  boundaryYmd: string
): boolean {
  let earliest: string | null = null;
  for (const row of monthly) {
    if (earliest == null || row.as_of_date < earliest) earliest = row.as_of_date;
  }
  return earliest != null && earliest > boundaryYmd;
}

/**
 * Latest perf close on or before the prior period-end for MTD / YTD / DTD.
 * A series that starts after the prior period-end (position opened this period)
 * closes at **0** — the account verifiably held nothing then, so the period
 * balance Δ is the whole current value. `null` stays reserved for genuine gaps
 * (older rows exist but no valid close inside the prior-period window).
 */
export function priorCloseFromPerfRows(
  monthly: readonly AccountMonthlyPerformanceRow[],
  anchor: PeriodAnchor,
  todayYmd: string = chileCalendarTodayYmd()
): number | null {
  if (!monthly.length) return null;

  let close: number | null = null;
  if (anchor === "mtd") {
    const priorMk = priorCalendarMonthKeyFromToday(todayYmd);
    close = monthEndCloseFromPerfRows(monthly, priorMk);
  } else if (anchor === "ytd") {
    const priorYear = String(Number(todayYmd.slice(0, 4)) - 1);
    const yearEnd = `${priorYear}-12-31`;
    let best: AccountMonthlyPerformanceRow | null = null;
    for (const row of monthly) {
      if (row.as_of_date.slice(0, 4) !== priorYear) continue;
      if (row.as_of_date > yearEnd) continue;
      if (row.closing_value == null || !Number.isFinite(row.closing_value)) continue;
      if (!best || row.as_of_date >= best.as_of_date) best = row;
    }
    const v = best?.closing_value;
    close = v != null && Number.isFinite(v) ? v : null;
  } else {
    const priorDay = chileCalendarAddDays(todayYmd, -1);
    let best: AccountMonthlyPerformanceRow | null = null;
    for (const row of monthly) {
      if (row.as_of_date > priorDay) continue;
      if (row.closing_value == null || !Number.isFinite(row.closing_value)) continue;
      if (!best || row.as_of_date >= best.as_of_date) best = row;
    }
    const v = best?.closing_value;
    close = v != null && Number.isFinite(v) ? v : null;
  }
  if (close != null) return close;

  return perfSeriesStartsAfter(monthly, priorPeriodEndYmd(anchor, todayYmd)) ? 0 : null;
}
