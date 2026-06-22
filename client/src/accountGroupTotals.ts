/** Mirror of server `accountCountsTowardGroupTotals` for dashboard rows. */
export function accountCountsTowardGroupTotals(row: {
  exclude_from_group_totals?: number | boolean | null;
}): boolean {
  return row.exclude_from_group_totals !== 1 && row.exclude_from_group_totals !== true;
}

/** Dashboard / nav: exclude accounts with a long trailing-zero monthly tail (`chart_inactive`). */
export function isChartActiveAccount(row: { chart_inactive?: boolean | null }): boolean {
  return row.chart_inactive !== true;
}

/** Live CLP balance for totals (sold-out / flat equity MTM → 0, not omitted). */
export function dashboardAccountCurrentValueClp(row: { current_value_clp?: number | null }): number {
  const v = row.current_value_clp;
  return v != null && Number.isFinite(v) ? v : 0;
}
