/**
 * Labels for expensive server work (dashboard / group loads).
 * Use with {@link timeHeavy} / {@link timeHeavyAsync} when `DEBUG_PERF=1` or `profile-dashboard` script.
 */
import { logHeavyEnabled, logServer } from "./serverLog.js";

export const HeavyWork = {
  dashboardAccountRows: "dashboard.account_rows",
  dashboardPayload: "dashboard.payload",
  dashboardValuationTimeseries: "dashboard.valuation_timeseries",
  dashboardOverviewBlock: "dashboard.overview_block",
  dashboardPrimaryPortfolioGroups: "dashboard.primary_portfolio_groups",
  groupValuationTimeseries: "group.valuation_timeseries",
  accountMonthlyPerformance: "account.monthly_performance",
  groupMonthlyPerformance: "group.monthly_performance",
  flowsDepositsPayload: "flows.deposits_payload",
  navContext: "dashboard.nav_context",
  pageBundle: "dashboard.page_bundle",
} as const;

export type HeavyWorkLabel = (typeof HeavyWork)[keyof typeof HeavyWork];

export function timeHeavy<T>(label: HeavyWorkLabel | string, fn: () => T): T {
  if (!logHeavyEnabled()) return fn();
  const t0 = performance.now();
  try {
    return fn();
  } finally {
    logServer("heavy", `${label} ${(performance.now() - t0).toFixed(1)}ms`);
  }
}

export async function timeHeavyAsync<T>(
  label: HeavyWorkLabel | string,
  fn: () => Promise<T>
): Promise<T> {
  if (!logHeavyEnabled()) return fn();
  const t0 = performance.now();
  try {
    return await fn();
  } finally {
    logServer("heavy", `${label} ${(performance.now() - t0).toFixed(1)}ms`);
  }
}
