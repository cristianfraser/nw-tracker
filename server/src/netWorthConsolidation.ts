/**
 * Canonical Patrimonio neto consolidated monthly series: Σ four dashboard buckets
 * (cash_eqs CC-adjusted via per-bucket consolidation).
 */

import { monthKeyFromYmd } from "./calendarMonth.js";
import { chileCalendarTodayYmd } from "./chileDate.js";
import {
  getGroupConsolidatedMonthlyPerfForRows,
  type ConsolidatedMonthlyPerfRow,
  type TsUnit,
} from "./groupMonthlyPerfConsolidation.js";
import {
  NW_DASHBOARD_BUCKET_SLUGS,
  portfolioGroupSlugForDashboardBucket,
  type NwDashboardBucketSlug,
} from "./portfolioGroupValueAtDate.js";
import { listAccountsForGroupTab } from "./valuationTimeseries.js";

function sumBucketConsolidatedRows(
  bucketRows: readonly ConsolidatedMonthlyPerfRow[][]
): ConsolidatedMonthlyPerfRow[] {
  const byMonth = new Map<string, ConsolidatedMonthlyPerfRow>();

  for (const rows of bucketRows) {
    for (const row of rows) {
      const mk = monthKeyFromYmd(row.as_of_date);
      const existing =
        byMonth.get(mk) ??
        ({
          as_of_date: row.as_of_date,
          closing_value: 0,
          prior_closing: null as number | null,
          net_capital_flow: 0,
          stock_units_inflow: 0,
          nominal_pl: null as number | null,
          pct_month: null,
          ytd_nominal_pl: null,
          cumulative_nominal_pl: null,
        } satisfies ConsolidatedMonthlyPerfRow);

      if (mk === monthKeyFromYmd(chileCalendarTodayYmd())) {
        existing.as_of_date = row.as_of_date;
      } else if (row.as_of_date > existing.as_of_date) {
        existing.as_of_date = row.as_of_date;
      }

      existing.closing_value += row.closing_value;
      existing.net_capital_flow += row.net_capital_flow;
      existing.stock_units_inflow += row.stock_units_inflow;

      if (row.prior_closing != null && Number.isFinite(row.prior_closing)) {
        existing.prior_closing = (existing.prior_closing ?? 0) + row.prior_closing;
      }
      if (row.nominal_pl != null && Number.isFinite(row.nominal_pl)) {
        existing.nominal_pl = (existing.nominal_pl ?? 0) + row.nominal_pl;
      }

      byMonth.set(mk, existing);
    }
  }

  const asc = [...byMonth.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, row]) => {
      const prior = row.prior_closing;
      const net = row.net_capital_flow;
      const nominal = row.nominal_pl;
      const denom = (prior ?? 0) + net;
      const pct =
        nominal != null &&
        Number.isFinite(nominal) &&
        Math.abs(denom) > 0.01 &&
        Number.isFinite(nominal / denom)
          ? nominal / denom
          : null;
      return { ...row, pct_month: pct };
    });

  let ytdYear = 0;
  let ytdRun = 0;
  let cumPl = 0;
  const withYtd = asc.map((row) => {
    const y = Number(row.as_of_date.slice(0, 4));
    if (Number.isFinite(y) && y !== ytdYear) {
      ytdYear = y;
      ytdRun = 0;
    }
    const nominal = row.nominal_pl ?? 0;
    ytdRun += nominal;
    cumPl += nominal;
    return { ...row, ytd_nominal_pl: ytdRun, cumulative_nominal_pl: cumPl };
  });

  return withYtd.reverse();
}

function loadBucketConsolidatedMonthly(
  bucket: NwDashboardBucketSlug,
  unit: TsUnit
): ConsolidatedMonthlyPerfRow[] {
  const pgSlug = portfolioGroupSlugForDashboardBucket(bucket);
  const tabRows = listAccountsForGroupTab(pgSlug);
  if (!tabRows.length) return [];
  return getGroupConsolidatedMonthlyPerfForRows(tabRows, pgSlug, unit);
}

/** Patrimonio neto consolidated monthly (newest first). Single source for card, chart, detalle. */
export function buildNetWorthConsolidatedMonthly(unit: TsUnit = "clp"): ConsolidatedMonthlyPerfRow[] {
  const bucketRows = NW_DASHBOARD_BUCKET_SLUGS.map((slug) =>
    loadBucketConsolidatedMonthly(slug, unit)
  );
  return sumBucketConsolidatedRows(bucketRows);
}

export type NetWorthPeriodMetrics = {
  closing_clp: number;
  prior_closing_clp: number | null;
  net_capital_flow_clp: number;
  nominal_pl_clp: number | null;
  balance_delta_clp: number | null;
};

/** Current calendar month slice from the canonical NW consolidated series. */
export function netWorthCurrentMonthMetrics(unit: TsUnit = "clp"): NetWorthPeriodMetrics | null {
  const rows = buildNetWorthConsolidatedMonthly(unit);
  const mk = monthKeyFromYmd(chileCalendarTodayYmd());
  const row = rows.find((r) => monthKeyFromYmd(r.as_of_date) === mk);
  if (!row) return null;

  const prior = row.prior_closing;
  const balance_delta =
    prior != null && Number.isFinite(prior) ? row.closing_value - prior : null;

  return {
    closing_clp: Math.round(row.closing_value),
    prior_closing_clp: prior != null && Number.isFinite(prior) ? Math.round(prior) : null,
    net_capital_flow_clp: Math.round(row.net_capital_flow),
    nominal_pl_clp:
      row.nominal_pl != null && Number.isFinite(row.nominal_pl)
        ? Math.round(row.nominal_pl)
        : null,
    balance_delta_clp:
      balance_delta != null && Number.isFinite(balance_delta) ? Math.round(balance_delta) : null,
  };
}

/** Per-bucket closing at a date from the same consolidated path as NW series. */
export function dashboardBucketClosingFromConsolidated(
  bucket: NwDashboardBucketSlug,
  unit: TsUnit = "clp"
): ConsolidatedMonthlyPerfRow[] {
  return loadBucketConsolidatedMonthly(bucket, unit);
}
