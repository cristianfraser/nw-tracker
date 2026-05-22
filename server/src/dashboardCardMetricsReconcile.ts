import type { AccountPeriodClosePeriod } from "./dashboardAccountCardMetrics.js";

/** Fields the dashboard account mapper can reconcile for card UI math. */
export type DashboardCardMetricsInput = {
  deposits_clp: number;
  deposits_usd?: number | null;
  delta_total_clp?: number | null;
  delta_total_usd?: number | null;
  deposits_month_clp?: number;
  deposits_month_usd?: number | null;
  deposits_year_clp?: number;
  deposits_year_usd?: number | null;
  delta_month_clp?: number | null;
  delta_month_usd?: number | null;
  delta_year_clp?: number | null;
  delta_year_usd?: number | null;
  prior_month_close_clp?: number | null;
  prior_month_close_usd?: number | null;
  prior_year_close_clp?: number | null;
  prior_year_close_usd?: number | null;
  current_value_clp: number | null;
  current_value_usd?: number | null;
};

export type DashboardCardMetricsReconciled = Pick<
  DashboardCardMetricsInput,
  | "delta_total_clp"
  | "delta_total_usd"
  | "delta_month_clp"
  | "delta_month_usd"
  | "delta_year_clp"
  | "delta_year_usd"
>;

function finite(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n);
}

function reconcilePeriodDelta(
  current: number,
  prior: number,
  periodDeposits: number
): number {
  return current - prior - periodDeposits;
}

function reconcilePeriodForUnit(
  row: DashboardCardMetricsInput,
  period: AccountPeriodClosePeriod,
  unit: "clp" | "usd"
): number | null | undefined {
  const current = unit === "usd" ? row.current_value_usd : row.current_value_clp;
  if (!finite(current)) return undefined;

  const prior =
    period === "year"
      ? unit === "usd"
        ? row.prior_year_close_usd
        : row.prior_year_close_clp
      : unit === "usd"
        ? row.prior_month_close_usd
        : row.prior_month_close_clp;
  if (!finite(prior)) return undefined;

  const periodDeposits =
    period === "year"
      ? unit === "usd"
        ? row.deposits_year_usd
        : row.deposits_year_clp
      : unit === "usd"
        ? row.deposits_month_usd
        : row.deposits_month_clp;
  const dep = finite(periodDeposits) ? periodDeposits : 0;
  return reconcilePeriodDelta(current, prior, dep);
}

/**
 * Display deltas for dashboard cards: lifetime Δ = current − deposits; period Δ = current − prior − period deposits.
 * Chart/performance APIs are unchanged; only `/api/dashboard` account rows use this.
 */
export function reconcileDashboardCardMetrics(
  row: DashboardCardMetricsInput,
  opts?: { includeUsd?: boolean }
): DashboardCardMetricsReconciled {
  const out: DashboardCardMetricsReconciled = {};

  if (finite(row.current_value_clp) && finite(row.deposits_clp)) {
    out.delta_total_clp = row.current_value_clp - row.deposits_clp;
  }

  if (opts?.includeUsd && finite(row.current_value_usd) && finite(row.deposits_usd)) {
    out.delta_total_usd = row.current_value_usd - row.deposits_usd;
  }

  const monthClp = reconcilePeriodForUnit(row, "month", "clp");
  if (monthClp !== undefined) out.delta_month_clp = monthClp;

  const yearClp = reconcilePeriodForUnit(row, "year", "clp");
  if (yearClp !== undefined) out.delta_year_clp = yearClp;

  if (opts?.includeUsd) {
    const monthUsd = reconcilePeriodForUnit(row, "month", "usd");
    if (monthUsd !== undefined) out.delta_month_usd = monthUsd;

    const yearUsd = reconcilePeriodForUnit(row, "year", "usd");
    if (yearUsd !== undefined) out.delta_year_usd = yearUsd;
  }

  return out;
}
