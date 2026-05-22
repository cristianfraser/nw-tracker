import { chileCalendarTodayYmd } from "./chileDate.js";
import { monthKeyFromYmd } from "./calendarMonth.js";

/** Minimal fields used when picking one row per calendar month. */
export type MonthlyPerfPickRow = {
  as_of_date: string;
  net_capital_flow: number;
  nominal_pl: number | null;
};

const MONTH_ROW_EPS = 0.01;

/**
 * Chart series can include two snapshots in the same calendar month (e.g. Chile “today” mid-month and
 * month-end). Pick one row per month for tables / bars — prefer the row with the largest |P/L| or flow.
 */
export function pickRepresentativeMonthlyPerfRow<T extends MonthlyPerfPickRow>(
  rows: T[],
  monthKey: string
): T {
  const asc = [...rows].sort((a, b) => String(a.as_of_date).localeCompare(String(b.as_of_date)));
  if (asc.length === 1) return asc[0]!;
  const currentMk = monthKeyFromYmd(chileCalendarTodayYmd());
  if (monthKey === currentMk) {
    return asc[asc.length - 1]!;
  }
  let best = asc[asc.length - 1]!;
  let bestScore = -1;
  for (const r of asc) {
    const pl = r.nominal_pl != null && Number.isFinite(r.nominal_pl) ? Math.abs(r.nominal_pl) : 0;
    const flow = Math.abs(r.net_capital_flow);
    const score = Math.max(pl, flow);
    if (score > bestScore + MONTH_ROW_EPS) {
      bestScore = score;
      best = r;
    }
  }
  return best;
}
