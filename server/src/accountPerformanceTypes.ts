import type { TsUnit } from "./rates.js";

/** One month (or snapshot) of an account's performance series, in the request unit. */
export type AccountMonthlyPerformanceRow = {
  as_of_date: string;
  /** Closing value at month-end (same unit as request: CLP or USD). */
  closing_value: number;
  prior_closing: number | null;
  /** Net capital flow in the month (Δ cumulative aportes vs prior month-end). */
  net_capital_flow: number;
  /** Sum of positive `movements.units_delta` in the calendar month (brokerage buys + DRIP, or AFP certificate cuotas). */
  stock_units_inflow: number;
  /** Coin units held at month-end snapshot (bitcoin / eth only). */
  coin_units_eom?: number | null;
  /**
   * Gain/loss beyond explained flows. Investments: `closing − prior − net_capital_flow`.
   * Mortgage: financing cost in the month = payments − CLP principal reduction (`net_capital_flow + Δ closing`).
   */
  nominal_pl: number | null;
  /** Investments: vs `prior + net_flow`. Mortgage: vs opening balance (`prior_closing`). */
  pct_month: number | null;
  /** Sum of nominal_pl from January of this row’s calendar year through this month (same unit). */
  ytd_nominal_pl: number | null;
  /** Running sum of nominal_pl from first month with a row through this month. */
  cumulative_nominal_pl: number | null;
  /** Mortgage: remaining principal in UF from `depto-dividendos.csv` (crédito restante), aligned to month-end. */
  closing_balance_uf?: number | null;
  /** Mortgage: UF value in CLP from `uf_daily` on or before month-end (not from the dividendos sheet). */
  uf_clp_day?: number | null;
  unit: TsUnit;
};
