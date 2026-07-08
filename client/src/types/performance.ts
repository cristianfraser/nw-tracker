/** Rentabilidad (chained period returns) DTOs — mirrors server/src/periodReturns.ts. */

export type PeriodReturnKey = "d1" | "w1" | "mtd" | "ytd" | "y1" | "y3" | "y5" | "total";

export interface PeriodReturnCell {
  period: PeriodReturnKey;
  /** Chained flow-adjusted return over the window (fraction); null = insufficient history / no data. */
  pct: number | null;
  /** Sum of nominal_pl over the window rows, in the payload unit; null when no row contributed. */
  nominal_pl: number | null;
  /** (1+pct)^(12/elapsed_months) − 1; only for windows spanning more than 12 months. */
  annualized_pct: number | null;
  /** Monthly rows chained inside the window. */
  months: number;
  /** Earliest contributing month key (YYYY-MM), or null for an empty/insufficient window. */
  window_start_month: string | null;
  /** Prior-anchor date (YYYY-MM-DD) for sub-monthly windows (d1/w1); null/absent for monthly windows. */
  window_start_date?: string | null;
}

export interface PeriodReturnsPayload {
  unit: "clp" | "usd" | "uf";
  as_of_date: string;
  /** A row exists for the current Chile calendar month (MTD is an in-progress month). */
  mtd_is_live: boolean;
  /** The 1D end leg is the live NYSE session (1D is an in-progress session). */
  d1_is_live: boolean;
  first_month: string;
  /** Fixed order: d1, w1, mtd, ytd, y1, y3, y5, total. */
  periods: PeriodReturnCell[];
}
