/**
 * Canonical Patrimonio neto consolidated monthly series: Σ of the net-worth buckets
 * (cash_eqs CC-adjusted via per-bucket consolidation).
 */

import { monthKeyFromYmd } from "./calendarMonth.js";
import { chileCalendarTodayYmd } from "./chileDate.js";
import { flowAdjustedPct, groupStartFrameFlow } from "./periodReturns.js";
import { withRunningPlTotals } from "./monthlyPerfRollup.js";
import {
  getGroupConsolidatedMonthlyPerfForRows,
  type ConsolidatedMonthlyPerfRow,
  type TsUnit,
} from "./groupMonthlyPerfConsolidation.js";
import { investmentRootSlugs, nwBucketSlugs } from "./navTreeModel.js";
import { listAccountsForGroupTab } from "./valuationTimeseries.js";

function sumBucketConsolidatedRows(
  bucketRows: readonly ConsolidatedMonthlyPerfRow[][],
  unit: TsUnit
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
          end_charged_flow: 0,
        } satisfies ConsolidatedMonthlyPerfRow);

      if (mk === monthKeyFromYmd(chileCalendarTodayYmd())) {
        existing.as_of_date = row.as_of_date;
      } else if (row.as_of_date > existing.as_of_date) {
        existing.as_of_date = row.as_of_date;
      }

      existing.closing_value += row.closing_value;
      existing.net_capital_flow += row.net_capital_flow;
      existing.stock_units_inflow += row.stock_units_inflow;
      existing.end_charged_flow += row.end_charged_flow;

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
      // Members that emptied inside a bucket keep their withdrawal charged at the month end.
      const pct = flowAdjustedPct(
        nominal,
        prior ?? null,
        groupStartFrameFlow(net, row.end_charged_flow),
        row.closing_value,
        unit
      );
      return { ...row, pct_month: pct };
    });

  return withRunningPlTotals(asc).reverse();
}

function loadBucketConsolidatedMonthly(bucket: string, unit: TsUnit): ConsolidatedMonthlyPerfRow[] {
  const tabRows = listAccountsForGroupTab(bucket);
  if (!tabRows.length) return [];
  return getGroupConsolidatedMonthlyPerfForRows(tabRows, bucket, unit);
}

/** Patrimonio neto consolidated monthly (newest first). Single source for card, chart, detalle. */
export function buildNetWorthConsolidatedMonthly(unit: TsUnit = "clp"): ConsolidatedMonthlyPerfRow[] {
  const bucketRows = nwBucketSlugs().map((slug) =>
    loadBucketConsolidatedMonthly(slug, unit)
  );
  return sumBucketConsolidatedRows(bucketRows, unit);
}

/** Inversiones nav hub: Σ of the investment roots' consolidations (same path as child group pages). */
export function buildInversionesConsolidatedMonthly(
  unit: TsUnit = "clp"
): ConsolidatedMonthlyPerfRow[] {
  const bucketRows = investmentRootSlugs().map((slug) =>
    loadBucketConsolidatedMonthly(slug, unit)
  );
  return sumBucketConsolidatedRows(bucketRows, unit);
}

