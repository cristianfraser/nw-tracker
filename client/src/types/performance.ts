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

export interface BenchmarkOption {
  slug: string;
  /** `portfolio_group`: one of the user's own groups (its time-weighted return). */
  kind: "equity_with_dividends" | "fund_unit" | "index_plus_rate" | "portfolio_group";
  /** A group row: its nav label key, or null (then `label`). */
  label_i18n_key: string | null;
  label?: string;
  /** `index_plus_rate` benchmarks: the yearly rate (for the label); null otherwise. */
  rate_pct: number | null;
}

export interface BenchmarkComparisonCell {
  period: PeriodReturnKey;
  benchmark_pct: number | null;
  benchmark_annualized_pct: number | null;
  /** P/L of the shadow portfolio (the same flows on the same days, in the benchmark). */
  shadow_pl: number | null;
  /** Real P/L − shadow P/L. */
  delta_pl: number | null;
  /** IRR of the real money and of its shadow: yearly when `irr_annualized`, else over the window. */
  real_irr_pct: number | null;
  shadow_irr_pct: number | null;
  irr_annualized: boolean;
  window_start_date: string | null;
}

export interface BenchmarkComparisonPayload {
  unit: "clp" | "usd" | "uf";
  benchmark: { slug: string };
  as_of_date: string;
  benchmark_first_date: string | null;
  periods: BenchmarkComparisonCell[];
}

export interface PrepaymentRow {
  date: string;
  /** The mortgage ledger's cuota label: a cuota number, or `prepago N`. */
  cuota: string;
  /** Paid above the minimum cuota. */
  extra: number;
  prepaid_value: number | null;
  invested_value: number | null;
  /** Invested − prepaid (positive: investing would have come out ahead). */
  delta: number | null;
}

export interface MortgagePrepaymentComparison {
  unit: "clp" | "usd" | "uf";
  account_id: number;
  benchmark: { slug: string };
  as_of_date: string;
  rows: PrepaymentRow[];
  totals: {
    /** Payments the totals include — those the benchmark's history reaches. */
    covered_payments: number;
    covered_from: string | null;
    extra: number;
    prepaid_value: number | null;
    invested_value: number | null;
    delta: number | null;
    /** Each side's IRR on the extra payments; yearly when `irr_annualized`. */
    prepaid_irr_pct: number | null;
    invested_irr_pct: number | null;
    irr_annualized: boolean;
  };
}

export interface PeriodReturnsPayload {
  unit: "clp" | "usd" | "uf";
  as_of_date: string;
  /** Series start month key (`YYYY-MM`). */
  first_month: string;
  /** Fixed order: d1, w1, mtd, ytd, y1, y3, y5, total. */
  periods: PeriodReturnCell[];
}
