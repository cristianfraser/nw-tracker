import type { AccountMonthlyPerformanceRow } from "../types";

/** Last calendar day of month for `year`/`month` (1-based month). */
export function monthEndYmd(year: number, month: number): string {
  const d = new Date(year, month, 0);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Month-end dates from `monthsBack` months ago through the current month (inclusive). */
export function monthEndYmdsThroughToday(monthsBack = 24): string[] {
  const now = new Date();
  const endYear = now.getFullYear();
  const endMonth = now.getMonth() + 1;
  const start = new Date(endYear, endMonth - 1 - monthsBack, 1);
  const startYear = start.getFullYear();
  const startMonth = start.getMonth() + 1;

  const out: string[] = [];
  let y = startYear;
  let m = startMonth;
  while (y < endYear || (y === endYear && m <= endMonth)) {
    out.push(monthEndYmd(y, m));
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
  return out;
}

export function emptyAccountMonthlyPerfRows(
  _accountId: number,
  unit: "clp" | "usd" | "uf" = "clp"
): AccountMonthlyPerformanceRow[] {
  return monthEndYmdsThroughToday().map((as_of_date) => ({
    as_of_date,
    closing_value: 0,
    prior_closing: null,
    net_capital_flow: 0,
    stock_units_inflow: 0,
    nominal_pl: null,
    pct_month: null,
    ytd_nominal_pl: null,
    cumulative_nominal_pl: null,
    unit,
  }));
}
