/** Adjustable inputs for /projections (CLP amounts are today's money). */
export interface ProjectionParams {
  real_return_pct: number;
  monthly_aporte_clp: number;
  inflation_clp_pct: number;
  inflation_usd_pct: number;
  retire_return_pct: number;
  end_age: number;
  swr_pct: number;
  pct_balance_pct: number;
  monthly_income_clp: number;
  /** % of the non-invested remainder (RE, cash) liquidated into the drawdown pot at 65. */
  liquidate_other_pct: number;
  /** Passive real monthly income during retirement (rent), today's CLP. */
  monthly_rent_clp: number;
}

export interface ProjectionsResponse {
  unit: "clp" | "usd";
  fx_clp_per_usd: number;
  params: ProjectionParams;
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
