import { getAggregationCached } from "./aggregationCache.js";
import { accountMarkClpSeriesOnGrid } from "./accountMarkDailyCache.js";
import { chileCalendarAddDays, chileCalendarTodayYmd } from "./chileDate.js";
import { DAILY_SERIES_MAX_DAYS, getBucketDailySeriesCached, totalRangeDays } from "./dailySeries.js";
import { clpToUsdForBalanceAt } from "./fxRates.js";
import { buildDashboardBucketDailySeriesClp } from "./portfolioGroupValueAtDate.js";
import {
  DASHBOARD_NW_CASH_PORTFOLIO_SLUG,
  listAccountsForGroupTab,
  listDashboardPrimaryPortfolioGroupSpecs,
  milestoneClpFieldsForDate,
} from "./valuationTimeseries.js";

/**
 * Daily net-worth overview: one point per **calendar day** ending at Chile today (same grid
 * as `dailySeries.ts` — weekends/holidays included, each account flat on its own closed
 * days), each valued by summing per-account marks per bucket
 * (`buildDashboardBucketDailySeriesClp` — the consolidated monthly closing would flatten
 * every day of a month to one value). The last point uses the live mark stack, matching
 * the headline the same way the Rentabilidad strip's live leg does. Served by
 * `GET /api/dashboard/overview-daily`; cached under `daily.overview|…` and dropped with the
 * daily-series namespace.
 */

export type OverviewDailyPoint = {
  as_of_date: string;
  net_worth: number | null;
  real_estate: number | null;
  retirement: number | null;
  brokerage: number | null;
  cash_eqs: number | null;
  /** Retirement + brokerage level (the monthly overview's dashed reference line). */
  invested: number | null;
  /** Pasivos: Σ liability-account marks (mortgage balance + CC owed-on-date). */
  liabilities: number | null;
};

/**
 * One day of the «Patrimonio neto vs invested (referencia US$)» chart — always CLP (the
 * chart is CLP regardless of display unit): net worth + invested levels plus the USD
 * milestone reference levels (US$ × that day's fx). Same field set as the monthly
 * `patrimonio_usd_milestones_chart` points, so the client reuses that block's line metadata.
 */
export type PatrimonioDailyPoint = Record<string, string | number | null>;

/** A «Cuentas principales» child-group line: values in the request unit, aligned to `points`. */
export type PrimaryDailyLine = { dataKey: string; values: (number | null)[] };

export type OverviewDailyPayload = {
  unit: "clp" | "usd";
  days: number;
  end_ymd: string;
  points: OverviewDailyPoint[];
  /** «Patrimonio neto vs invested» daily points (CLP). */
  patrimonio: PatrimonioDailyPoint[];
  /** «Cuentas principales» per-child-group daily lines (request unit), keyed by the same
   * synthetic dataKeys as the monthly `accounts_ex_property` accounts. */
  primary_lines: PrimaryDailyLine[];
};

/**
 * Per-child-group daily lines for «Cuentas principales», in the request unit. Each line sums
 * the same marks the group page's daily series sums (`getBucketDailySeriesCached` under the
 * shared `pg:<slug>` key), so a line here equals that group's day-mode chart point-for-point.
 * The cash child reuses the CC-netted `cash_eqs` bucket from `byDate` — the netting the
 * net-worth cash line always applies — so it matches the overview cash line, not the raw group.
 */
function buildPrimaryDailyLines(
  unit: "clp" | "usd",
  days: number,
  grid: readonly string[],
  cashNettedClpByDate: Map<string, number>
): PrimaryDailyLine[] {
  const lines: PrimaryDailyLine[] = [];
  for (const spec of listDashboardPrimaryPortfolioGroupSpecs()) {
    const dataKey = String(spec.chartAccountId);
    if (spec.slug === DASHBOARD_NW_CASH_PORTFOLIO_SLUG) {
      // Netted cash, converted per day like the overview cash line.
      lines.push({
        dataKey,
        values: grid.map((ymd) => {
          const clp = cashNettedClpByDate.get(ymd);
          if (clp == null || !Number.isFinite(clp)) return null;
          if (unit === "clp") return clp;
          const usd = clpToUsdForBalanceAt(clp, ymd);
          return usd != null && Number.isFinite(usd) ? usd : null;
        }),
      });
      continue;
    }
    const rows = listAccountsForGroupTab(spec.slug).filter((r) => r.account_id > 0);
    if (!rows.length) continue;
    const series = getBucketDailySeriesCached(`pg:${spec.slug}`, rows, {
      unit,
      days,
      includeAccounts: true,
    });
    const byDate = new Map(series.points.map((p) => [p.as_of_date, p.value]));
    lines.push({ dataKey, values: grid.map((ymd) => byDate.get(ymd) ?? null) });
  }
  return lines;
}

/** Σ liability-account marks per grid day (same accounts as the Pasivos group daily view). */
function liabilitiesClpByDate(grid: readonly string[]): Map<string, number> {
  const rows = listAccountsForGroupTab("liabilities").filter(
    (r) => r.account_id > 0 && r.exclude_from_group_totals !== 1
  );
  const marksByAccount = rows.map((a) =>
    accountMarkClpSeriesOnGrid(
      {
        account_id: a.account_id,
        bucket_slug: a.bucket_slug,
        import_key: a.import_key ?? null,
        name: a.name ?? null,
      },
      grid
    )
  );
  const out = new Map<string, number>();
  grid.forEach((ymd, gi) => {
    let raw = 0;
    for (const marks of marksByAccount) {
      const clp = marks[gi];
      if (clp != null && Number.isFinite(clp)) raw += clp;
    }
    out.set(ymd, Math.round(raw));
  });
  return out;
}

function buildOverviewDaily(unit: "clp" | "usd", days: number): OverviewDailyPayload {
  const endYmd = chileCalendarTodayYmd();
  const count = days === 0 ? totalRangeDays(endYmd) : days;
  const grid: string[] = new Array(count);
  for (let i = 0; i < count; i++) {
    grid[count - 1 - i] = i === 0 ? endYmd : chileCalendarAddDays(endYmd, -i);
  }
  const byDate = buildDashboardBucketDailySeriesClp(grid);
  const liabByDate = liabilitiesClpByDate(grid);

  // Same leading-null convention as the monthly overview: real_estate and liabilities stay
  // null (line not drawn) until their first non-zero value — a flat 0 pre-ownership reads
  // as data, not absence.
  let reStarted = false;
  let liabStarted = false;
  const points: OverviewDailyPoint[] = grid.map((ymd) => {
    const row = byDate.get(ymd)!;
    const pick = (clp: number): number | null => {
      if (unit === "clp") return clp;
      const usd = clpToUsdForBalanceAt(clp, ymd);
      return usd != null && Number.isFinite(usd) ? usd : null;
    };
    if (!reStarted && Math.abs(row.real_estate) >= 0.5) reStarted = true;
    const liabClp = liabByDate.get(ymd)!;
    if (!liabStarted && Math.abs(liabClp) >= 0.5) liabStarted = true;
    return {
      as_of_date: ymd,
      net_worth: pick(row.net_worth),
      real_estate: reStarted ? pick(row.real_estate) : null,
      retirement: pick(row.retirement),
      brokerage: pick(row.brokerage),
      cash_eqs: pick(row.cash_eqs),
      invested: pick(row.retirement + row.brokerage),
      liabilities: liabStarted ? pick(liabClp) : null,
    };
  });

  // «Patrimonio neto vs invested» — always CLP: net worth + invested levels plus the per-day
  // USD milestone reference levels (US$ × that day's fx). Reuses the CLP bucket values.
  const patrimonio: PatrimonioDailyPoint[] = grid.map((ymd) => {
    const row = byDate.get(ymd)!;
    return {
      as_of_date: ymd,
      total_nw: row.net_worth,
      invested: row.retirement + row.brokerage,
      ...milestoneClpFieldsForDate(ymd),
    };
  });

  const cashNettedClpByDate = new Map(grid.map((ymd) => [ymd, byDate.get(ymd)!.cash_eqs]));
  const primary_lines = buildPrimaryDailyLines(unit, days, grid, cashNettedClpByDate);

  return {
    unit,
    days,
    end_ymd: endYmd,
    points,
    patrimonio,
    primary_lines,
  };
}

export const OVERVIEW_DAILY_DEFAULT_DAYS = 90;

/** Validated + aggregation-cached overview series. Throws on an out-of-bounds window. */
export function getDashboardOverviewDaily(
  unit: "clp" | "usd",
  days: number
): OverviewDailyPayload {
  if (!Number.isInteger(days) || days < 0 || days > DAILY_SERIES_MAX_DAYS) {
    throw new Error(`overview-daily: days must be 0..${DAILY_SERIES_MAX_DAYS}, got ${days}`);
  }
  return getAggregationCached(`daily.overview|${unit}|${days}`, () =>
    buildOverviewDaily(unit, days)
  );
}
