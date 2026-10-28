/**
 * Visibility filters for dashboard rows (which accounts a list shows). Never a figure: a
 * group's balance and metrics are the server's (`card_metrics_by_slug`).
 */

/**
 * The server's `accountCountsTowardGroupTotals` rule (server/src/dashboardNavCardMetrics.ts),
 * pinned by `accountGroupTotals.test.ts`: only a stored 1 excludes an account.
 */
export function accountCountsTowardGroupTotals(row: {
  exclude_from_group_totals?: number | null;
}): boolean {
  return row.exclude_from_group_totals !== 1;
}

/** Dashboard / nav: exclude accounts with a long trailing-zero monthly tail (`chart_inactive`). */
export function isChartActiveAccount(row: { chart_inactive?: boolean | null }): boolean {
  return row.chart_inactive !== true;
}

const DASHBOARD_BALANCE_EPS = 1e-9;

/** Non-null finite live CLP balance above zero (summary card breakdown lines). */
export function hasMaterialDashboardBalance(row: { current_value_clp?: number | null }): boolean {
  const v = row.current_value_clp;
  return v != null && Number.isFinite(v) && Math.abs(v) > DASHBOARD_BALANCE_EPS;
}
