/**
 * The group pages' monthly P/L combo (per-account bars, the YTD area, the Σ Δ line and the
 * all-time «Total acumulado» line), built from the consolidation's own per-account rows.
 *
 * Every per-account bar is the row `pickMonthlyPerfRowsByMonth` picks for the month out of
 * `monthlyPerfRowsForAccount` — the row the group consolidation sums — and the three totals are
 * the consolidated row of the month (`nominal_pl`, `ytd_nominal_pl`, `cumulative_nominal_pl`),
 * so the chart and the «Detalle por mes» table of a scope read the same numbers by construction.
 * The linked-card netting of a cash scope (`netLinkedCreditCardFromCashConsolidated`) moves the
 * closes only, never `nominal_pl`, so Σ bars = `delta_total` on cash scopes too.
 */

import { monthKeyFromYmd } from "./calendarMonth.js";
import { pickMonthlyPerfRowsByMonth } from "./accountPeriodMetrics.js";
import { withAccountValuationTsCache } from "./accountPerformanceContext.js";
import {
  averageRgbTriplets,
  colorRgbForSyntheticAccountLine,
  colorRgbForTimeseriesAccountLine,
  getAccountColorRgb,
} from "./chartColorRgb.js";
import {
  buildLiabilitiesChartBucketPlan,
  buildNavChartBucketPlan,
  isLiabilitiesChartNavNode,
  shouldAggregateLiabilitiesCharts,
  shouldAggregateNavCharts,
  type ChartBucketPlan,
} from "./groupChartBuckets.js";
import {
  getGroupConsolidationAccountMonthly,
  type ConsolidatedMonthlyPerfRow,
} from "./groupMonthlyPerfConsolidation.js";
import { getGroupConsolidatedMonthlyRows } from "./groupConsolidatedTables.js";
import { getNavChartGroupNodeBySlug } from "./navTree.js";
import { listAccountsForGroupTab, type TsUnit } from "./valuationTimeseries.js";

export type GroupMonthlyPerformanceBarAccount = {
  account_id: number;
  name: string;
  /** i18n key for grouped bucket bars (nav node `label_i18n_key`); client resolves at render. */
  name_i18n_key?: string | null;
  /** Point field for this account’s monthly nominal P/L (e.g. `pl_12`). */
  bar_data_key: string;
  /** Portfolio group / account color (`r,g,b`), same as valuation lines. */
  color_rgb?: string;
};

export type GroupMonthlyPlPoint = Record<string, string | number | null>;

export type GroupMonthlyPlBars = {
  bar_accounts: GroupMonthlyPerformanceBarAccount[];
  points: GroupMonthlyPlPoint[];
};

export type GroupMonthlyPlSeriesResponse = {
  unit: TsUnit;
  group_slug: string;
  bar_accounts: GroupMonthlyPerformanceBarAccount[];
  /**
   * One point per consolidated month, oldest first: `as_of_date` (the consolidated row's date —
   * today for the month in progress), `pl_<id>` per bar account (0 for a month the account has
   * no P/L), `delta_total` / `ytd_group` / `accumulated_earnings` = the consolidated row's
   * `nominal_pl` / `ytd_nominal_pl` / `cumulative_nominal_pl`.
   */
  points: GroupMonthlyPlPoint[];
  nav_grouped_bars?: { grouped?: GroupMonthlyPlBars; ungrouped?: GroupMonthlyPlBars };
  liab_grouped_bars?: GroupMonthlyPlBars;
};

const finiteOr0 = (v: number | null | undefined): number =>
  v != null && Number.isFinite(v) ? v : 0;

/**
 * Grouped P/L bars per bucket: `bar_accounts` with `pl_nav_<slug>` / `pl_liab_<slug>` keys +
 * those per-point sums of member `pl_<id>` (the totals pass through untouched). An account the
 * plan puts in no bucket keeps its own bar, as `groupDailySeriesAccounts` keeps its line, so the
 * grouped bars still add up to `delta_total` (the retired CMR card on Pasivos had dropped out).
 */
function aggregatePerfByBuckets(
  bar_accounts: readonly GroupMonthlyPerformanceBarAccount[],
  points: readonly GroupMonthlyPlPoint[],
  plan: ChartBucketPlan
): GroupMonthlyPlBars {
  const { orderedKeys, meta, idToBucket } = plan;
  const used = new Set<string>();
  for (const ba of bar_accounts) {
    const b = idToBucket(ba.account_id);
    if (b) used.add(b);
  }
  const ordered = orderedKeys.filter((k) => used.has(k));
  const unbucketed = bar_accounts.filter((ba) => {
    const b = idToBucket(ba.account_id);
    return b == null || !meta[b];
  });

  const grouped_bar_accounts: GroupMonthlyPerformanceBarAccount[] = ordered.map((k) => {
    const m = meta[k]!;
    const members = bar_accounts.filter((ba) => idToBucket(ba.account_id) === k);
    const color_rgb =
      m.color_rgb ??
      averageRgbTriplets(members.map((ba) => getAccountColorRgb(ba.account_id))) ??
      undefined;
    return {
      account_id: m.accountId,
      name: m.name,
      bar_data_key: m.barDataKey,
      ...(m.name_i18n_key ? { name_i18n_key: m.name_i18n_key } : {}),
      ...(color_rgb ? { color_rgb } : {}),
    };
  });

  const outPoints = points.map((row) => {
    const out: GroupMonthlyPlPoint = { ...row };
    for (const k of ordered) {
      const m = meta[k]!;
      let acc = 0;
      let any = false;
      for (const ba of bar_accounts) {
        if (idToBucket(ba.account_id) !== k) continue;
        const v = row[ba.bar_data_key];
        if (typeof v === "number" && Number.isFinite(v)) {
          acc += v;
          any = true;
        }
      }
      out[m.barDataKey] = any ? acc : null;
    }
    return out;
  });

  return { bar_accounts: [...grouped_bar_accounts, ...unbucketed], points: outPoints };
}

/**
 * The consolidated rows of a scope from payloads already built: the branch of
 * `getGroupConsolidatedMonthlyRows` for every slug but `net_worth` / `inversiones` (which sum
 * the bucket consolidations), reusing the payloads so the ledger walks run once.
 */
function consolidatedRowsForScope(groupSlug: string, unit: TsUnit): ConsolidatedMonthlyPerfRow[] {
  // The rows the group's detalle por mes shows (the same cached consolidation).
  return getGroupConsolidatedMonthlyRows(groupSlug, unit);
}

/** @heavy The group consolidation's per-account rows (one ledger walk / perf build per account). */
export function getGroupMonthlyPlSeries(
  groupSlug: string,
  unit: TsUnit = "clp",
  opts?: { groupedBlocks?: boolean }
): GroupMonthlyPlSeriesResponse {
  return withAccountValuationTsCache(() => buildGroupMonthlyPlSeries(groupSlug, unit, opts));
}

function buildGroupMonthlyPlSeries(
  groupSlug: string,
  unit: TsUnit,
  opts?: { groupedBlocks?: boolean }
): GroupMonthlyPlSeriesResponse {
  const payloads = getGroupConsolidationAccountMonthly(listAccountsForGroupTab(groupSlug), groupSlug, unit);
  const consolidatedAsc = [...consolidatedRowsForScope(groupSlug, unit)].reverse();

  const bar_accounts: GroupMonthlyPerformanceBarAccount[] = [];
  const pickedByAccount: Map<string, { nominal_pl: number | null }>[] = [];
  for (const p of payloads) {
    const color_rgb =
      p.account_id > 0
        ? colorRgbForTimeseriesAccountLine(p.account_id)
        : colorRgbForSyntheticAccountLine(p.account_id);
    bar_accounts.push({
      account_id: p.account_id,
      name: p.name,
      bar_data_key: `pl_${p.account_id}`,
      ...(color_rgb ? { color_rgb } : {}),
    });
    pickedByAccount.push(pickMonthlyPerfRowsByMonth(p.monthly));
  }

  const points: GroupMonthlyPlPoint[] = consolidatedAsc.map((row) => {
    const mk = monthKeyFromYmd(row.as_of_date);
    const pt: GroupMonthlyPlPoint = { as_of_date: row.as_of_date };
    bar_accounts.forEach((ba, i) => {
      pt[ba.bar_data_key] = finiteOr0(pickedByAccount[i]!.get(mk)?.nominal_pl);
    });
    pt.delta_total = finiteOr0(row.nominal_pl);
    pt.ytd_group = finiteOr0(row.ytd_nominal_pl);
    pt.accumulated_earnings = finiteOr0(row.cumulative_nominal_pl);
    return pt;
  });

  let navGrouped: { grouped?: GroupMonthlyPlBars; ungrouped?: GroupMonthlyPlBars } | undefined;
  let liabGrouped: GroupMonthlyPlBars | undefined;
  if (opts?.groupedBlocks) {
    const navNode = getNavChartGroupNodeBySlug(groupSlug);
    if (navNode && isLiabilitiesChartNavNode(navNode)) {
      if (shouldAggregateLiabilitiesCharts(navNode)) {
        liabGrouped = aggregatePerfByBuckets(bar_accounts, points, buildLiabilitiesChartBucketPlan(navNode));
      }
    } else if (navNode) {
      for (const grouped of [true, false] as const) {
        if (!shouldAggregateNavCharts(navNode, grouped)) continue;
        const agg = aggregatePerfByBuckets(bar_accounts, points, buildNavChartBucketPlan(navNode, grouped));
        (navGrouped ??= {})[grouped ? "grouped" : "ungrouped"] = agg;
      }
    }
  }

  return {
    unit,
    group_slug: groupSlug,
    bar_accounts,
    points,
    ...(navGrouped ? { nav_grouped_bars: navGrouped } : {}),
    ...(liabGrouped ? { liab_grouped_bars: liabGrouped } : {}),
  };
}
