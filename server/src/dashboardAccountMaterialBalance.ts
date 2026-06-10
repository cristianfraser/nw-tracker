import type { DashboardAccountStats } from "./brokerageAcciones.js";

const BALANCE_EPS = 1e-9;

/** Single dashboard row has a nonzero live balance (shape endpoints only; excludes chart-inactive). */
export function dashboardAccountRowHasMaterialBalance(
  row: Pick<
    DashboardAccountStats,
    "current_value_clp" | "current_value_usd" | "chart_inactive"
  >,
  includeUsd: boolean
): boolean {
  if (row.chart_inactive) return false;
  if (includeUsd) {
    const v = row.current_value_usd;
    return v != null && Number.isFinite(v) && Math.abs(v) > BALANCE_EPS;
  }
  const clp = row.current_value_clp;
  return clp != null && Number.isFinite(clp) && Math.abs(clp) > BALANCE_EPS;
}

export function filterDashboardAccountRowsWithMaterialBalance<T extends DashboardAccountStats>(
  rows: T[],
  includeUsd: boolean
): T[] {
  return rows.filter((r) => dashboardAccountRowHasMaterialBalance(r, includeUsd));
}
