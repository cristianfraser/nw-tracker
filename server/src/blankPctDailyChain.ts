import type { DashboardAccountStats } from "./brokerageAcciones.js";
import { priorPeriodEndYmd } from "./accountPeriodMarks.js";
import { chileCalendarAddDays, chileCalendarTodayYmd } from "./chileDate.js";
import type { ChainedGroupPct } from "./dashboardNavCardMetrics.js";
import { ZERO_CLOSE_EPS } from "./periodReturns.js";
import { getBucketDailySeriesCached, type BucketDailySeries } from "./dailySeries.js";
import { db } from "./db.js";
import { resolveAccountDailySeries, resolveGroupDailySeries } from "./groupDailySeries.js";
import { listAccountsForGroupTab, type TsUnit } from "./valuationTimeseries.js";

/**
 * A period % the one-step flow-adjusted rule leaves blank: a position bought and sold inside
 * the period starts and ends at zero, so there is no capital base to divide by (OILK and the
 * IPSA unit in 2026). Such a cell reads the period's time-weighted return instead, chained
 * from the daily series' flow-adjusted `pct` (the Rentabilidad tables' daily-chained rule,
 * `withDailyChainedReturns`): every day the money was held, a day without a return flat.
 * Only that case is filled — a blank cell with a material P/L whose position is empty at both
 * ends of the period (`emptyAtBothEnds`); a blank for any other reason stays blank, and a cell
 * the rule already answers is never touched.
 */

export type ChainPeriod = "day" | "month" | "year" | "total";

/** The last day before the period (exclusive start of the chain); null = since the first day. */
export function chainPeriodStartYmd(period: ChainPeriod, todayYmd: string): string | null {
  if (period === "total") return null;
  if (period === "day") return chileCalendarAddDays(todayYmd, -1);
  return priorPeriodEndYmd(period === "month" ? "mtd" : "ytd", todayYmd);
}

/** Π(1 + daily pct) − 1 over (startYmd, todayYmd]; null when no day in it has a return. */
export function chainDailyPct(
  points: readonly { as_of_date: string; pct: number | null }[],
  startYmd: string | null,
  todayYmd: string
): number | null {
  let prod = 1;
  let any = false;
  for (const p of points) {
    if (startYmd != null && p.as_of_date <= startYmd) continue;
    if (p.as_of_date > todayYmd) continue;
    if (p.pct == null || !Number.isFinite(p.pct)) continue;
    prod *= 1 + p.pct;
    any = true;
  }
  return any ? prod - 1 : null;
}

export function materialPl(v: number | null | undefined): boolean {
  return v != null && Number.isFinite(v) && Math.abs(v) >= 0.5;
}

/** No value at the period's close nor at its start (Total has no start): the unit's coin. */
export function emptyAtBothEnds(
  close: number | null | undefined,
  prior: number | null | undefined,
  period: ChainPeriod,
  unit: TsUnit
): boolean {
  const eps = ZERO_CLOSE_EPS[unit];
  const empty = (v: number | null | undefined) => v == null || !Number.isFinite(v) || Math.abs(v) <= eps;
  return empty(close) && (period === "total" || empty(prior));
}

/** Full-history daily series → chained % for one period, the input of the fillers below. */
export type DailySeriesFor = (unit: TsUnit) => BucketDailySeries | null;

export function chainedPctFromSeries(
  seriesFor: DailySeriesFor,
  period: ChainPeriod,
  unit: TsUnit,
  todayYmd: string = chileCalendarTodayYmd()
): number | null {
  const series = seriesFor(unit);
  if (!series) return null;
  return chainDailyPct(series.points, chainPeriodStartYmd(period, todayYmd), todayYmd);
}

const PCT_FIELDS: readonly {
  period: ChainPeriod;
  unit: TsUnit;
  pct: keyof DashboardAccountStats;
  delta: keyof DashboardAccountStats;
  close: keyof DashboardAccountStats;
  prior: keyof DashboardAccountStats | null;
}[] = [
  { period: "day", unit: "clp", pct: "pct_day_clp", delta: "delta_day_clp", close: "current_value_clp", prior: "prior_day_close_clp" },
  { period: "month", unit: "clp", pct: "pct_month_clp", delta: "delta_month_clp", close: "current_value_clp", prior: "prior_month_close_clp" },
  { period: "year", unit: "clp", pct: "pct_year_clp", delta: "delta_year_clp", close: "current_value_clp", prior: "prior_year_close_clp" },
  { period: "total", unit: "clp", pct: "pct_total_clp", delta: "delta_total_clp", close: "current_value_clp", prior: null },
  { period: "day", unit: "usd", pct: "pct_day_usd", delta: "delta_day_usd", close: "current_value_usd", prior: "prior_day_close_usd" },
  { period: "month", unit: "usd", pct: "pct_month_usd", delta: "delta_month_usd", close: "current_value_usd", prior: "prior_month_close_usd" },
  { period: "year", unit: "usd", pct: "pct_year_usd", delta: "delta_year_usd", close: "current_value_usd", prior: "prior_year_close_usd" },
  { period: "total", unit: "usd", pct: "pct_total_usd", delta: "delta_total_usd", close: "current_value_usd", prior: null },
];

/**
 * Dashboard account rows with their blank period % filled from the account's own daily series
 * (the `account:<id>` build its page shares). Liability rows keep theirs: their P/L is a cost,
 * not a return on capital.
 */
export function fillBlankAccountRowPcts(
  rows: DashboardAccountStats[],
  includeUsd: boolean,
  isLiability: (accountId: number) => boolean
): DashboardAccountStats[] {
  const todayYmd = chileCalendarTodayYmd();
  const importKeyStmt = db.prepare(`SELECT import_key FROM accounts WHERE id = ?`);
  return rows.map((row) => {
    const blanks = PCT_FIELDS.filter(
      (f) =>
        (includeUsd || f.unit === "clp") &&
        row[f.pct] == null &&
        materialPl(row[f.delta] as number | null | undefined) &&
        emptyAtBothEnds(
          row[f.close] as number | null | undefined,
          f.prior ? (row[f.prior] as number | null | undefined) : null,
          f.period,
          f.unit
        )
    );
    if (blanks.length === 0 || isLiability(row.account_id)) return row;
    const importKey = (importKeyStmt.get(row.account_id) as { import_key: string | null } | undefined)
      ?.import_key ?? null;
    const ref = { account_id: row.account_id, name: row.name, bucket_slug: row.bucket_slug, import_key: importKey };
    const seriesFor: DailySeriesFor = (unit) => resolveAccountDailySeries(ref, unit, 0);
    const filled: Partial<DashboardAccountStats> = {};
    for (const f of blanks) {
      (filled as Record<string, number | null>)[f.pct] = chainedPctFromSeries(
        seriesFor,
        f.period,
        f.unit,
        todayYmd
      );
    }
    return { ...row, ...filled };
  });
}

/**
 * The `chainedGroupPct` input of `buildNavCardMetricsBySlug`: a group's own daily series
 * (`pg:<slug>`, shared with its page) or one over a page's liquidated rows. Groups holding a
 * liability are left blank, as liability rows are.
 */
export function chainedGroupPctResolver(
  rows: readonly DashboardAccountStats[],
  includeUsd: boolean,
  isLiability: (accountId: number) => boolean
): ChainedGroupPct {
  const todayYmd = chileCalendarTodayYmd();
  const rowById = new Map(rows.map((r) => [r.account_id, r]));
  const importKeyStmt = db.prepare(`SELECT import_key FROM accounts WHERE id = ?`);
  return (scope, period, unit) => {
    if (unit === "usd" && !includeUsd) return null;
    if (scope.kind === "group") {
      const members = listAccountsForGroupTab(scope.slug).filter((r) => r.account_id > 0);
      if (members.some((r) => isLiability(r.account_id))) return null;
      return chainedPctFromSeries((u) => resolveGroupDailySeries(scope.slug, u, 0), period, unit, todayYmd);
    }
    if (scope.accountIds.some(isLiability)) return null;
    const refs = scope.accountIds.map((id) => {
      const row = rowById.get(id);
      if (!row) throw new Error(`chained %: liquidated account ${id} has no dashboard row`);
      const importKey =
        (importKeyStmt.get(id) as { import_key: string | null } | undefined)?.import_key ?? null;
      return { account_id: id, name: row.name, bucket_slug: row.bucket_slug, import_key: importKey };
    });
    return chainedPctFromSeries(
      (u) => getBucketDailySeriesCached(`liquidated:${scope.parentSlug}`, refs, { unit: u, days: 0 }),
      period,
      unit,
      todayYmd
    );
  };
}
