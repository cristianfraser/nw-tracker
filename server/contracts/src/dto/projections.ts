import type { DisplayUnitCode } from "./core.js";
/**
 * Adjustable inputs for /projections. Money inputs are today's money in the response's `unit`
 * (a request may type one in another currency: `<key>=<amount>&<key>_currency=<code>`).
 */
export interface ProjectionParams {
  real_return_pct: number;
  monthly_aporte: number;
  /** Annual inflation % per core currency (request keys `inflation_<code>_pct`). */
  inflation_pct: Record<string, number>;
  retire_return_pct: number;
  end_age: number;
  swr_pct: number;
  pct_balance_pct: number;
  monthly_income: number;
  /** % of the non-invested remainder (RE, cash) liquidated into the drawdown pot at 65. */
  liquidate_other_pct: number;
  /** Passive real monthly income during retirement (rent), today's money. */
  monthly_rent: number;
}

export interface ProjectionsResponse {
  unit: DisplayUnitCode;
  params: ProjectionParams;
  /** The default inflation per core currency: assumptions, not forecasts. */
  inflation_default_pct: Record<string, number>;
  retire_month: string;
  retire_age: number;
  summary: {
    /** The drawdown base at retirement (invested or total per `drawdown_base`). */
    balance_at_retire: number;
    invested_at_retire: number;
    total_at_retire: number;
    monthly_rent: number;
    swr_monthly_income: number;
    pct_balance_initial_monthly_income: number;
    fixed_monthly_income: number;
    swr_depletion_age: number | null;
    fixed_income_depletion_age: number | null;
  };
  chart: {
    points: Record<string, string | number | null>[];
    lines: { dataKey: string; name: string; valueSeriesType: "data" | "reference" }[];
  };
}
