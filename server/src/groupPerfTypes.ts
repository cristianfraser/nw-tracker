/** Row shapes of the group pages: a tab's account row and a consolidated month. */
export type GroupTabAccountRow = {
  account_id: number;
  name: string;
  bucket_slug: string;
  notes?: string | null;
  import_key?: string | null;
  exclude_from_group_totals: number;
  /** Long trailing-zero tail; omit from nav child cards only (charts/tables keep the series). */
  chart_inactive?: boolean;
};

export type ConsolidatedMonthlyPerfRow = {
  as_of_date: string;
  closing_value: number;
  prior_closing: number | null;
  net_capital_flow: number;
  stock_units_inflow: number;
  nominal_pl: number | null;
  pct_month: number | null;
  ytd_nominal_pl: number | null;
  cumulative_nominal_pl: number | null;
  /**
   * The YTD % at this row's date: the scope's daily returns of the row's calendar year compounded
   * through its date — the Rentabilidad YTD rule (`periodPctDailyChain.ts`). Absent where the
   * scope keeps the one-step % (liability-only scopes, a legacy group sub-tab) — those % are a
   * cost, not a return; null when no day of the year has a return. On a yearly row it is the
   * latest month's (= the year's YTD through its last month).
   */
  ytd_pct?: number | null;
  /**
   * Σ of the net withdrawals of the members that ended the month at zero (`endChargedFlow`),
   * uncapped — `pct_month` charges them at the month end up to the group's own net withdrawal
   * (`groupStartFrameFlow`). Summed again by the net-worth / inversiones consolidation,
   * which caps the sum with its own net flow (transfers between buckets cancel there).
   */
  end_charged_flow: number;
};
