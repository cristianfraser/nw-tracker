import {
  type ProportionalSeriesBlock,
} from "./proportionalSeries.js";
import {
  buildCompositionBlock,
  compositionLineSpecsFromNavTree,
  compositionValuesOnGridClp,
} from "./dashboardComposition.js";
import { getAggregationCached } from "./aggregationCache.js";
import { accountMarkClpSeriesOnGrid } from "./accountMarkDailyCache.js";
import { chileCalendarTodayYmd } from "./chileDate.js";
import {
  chileCalendarDaysListEndingAt,
  DAILY_SERIES_MAX_DAYS,
  getBucketDailySeriesCached,
  totalRangeDays,
} from "./dailySeries.js";
import { nullLeadingZeroRun, trailingZeroRunClipStartIndex } from "./timeseriesTailClip.js";
import { clpToUnitAt } from "./clpToUnitAt.js";
import { getNetWorthAllTimeHigh, type NetWorthAthDto } from "./netWorthAllTimeHigh.js";
import { buildDashboardBucketDailySeriesClp, dashboardBucketsUsdToday } from "./portfolioGroupValueAtDate.js";
import {
  DASHBOARD_NW_CASH_PORTFOLIO_SLUG,
  listAccountsForGroupTab,
  listDashboardPrimaryPortfolioGroupSpecs,
  milestoneFieldsForDate,
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
} & {
  /** USD milestone reference levels (`usd_50k`, …): the US$ amount in the request unit on that
   * day (flat in USD), same keys as the monthly overview's reference lines. */
  [usdMilestoneKey: `usd_${string}`]: number | null;
};

/** A «Cuentas principales» child-group line: values in the request unit, aligned to `points`. */
export type PrimaryDailyLine = { dataKey: string; values: (number | null)[] };

export type OverviewDailyPayload = {
  unit: "clp" | "usd";
  days: number;
  end_ymd: string;
  points: OverviewDailyPoint[];
  /** Composition shares for the home pie-replacement chart (same dataKeys as the monthly block). */
  allocation_proportional: ProportionalSeriesBlock;
  /** «Cuentas principales» per-child-group daily lines (request unit), keyed by the same
   * synthetic dataKeys as the monthly `accounts_ex_property` accounts. */
  primary_lines: PrimaryDailyLine[];
  /** All-time high of the net-worth line in the request unit (full-history daily walk, see `netWorthAllTimeHigh.ts`). */
  ath: NetWorthAthDto | null;
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
  cashNettedClpByDate: Map<string, number>,
  /** Today's cash card in USD (the headline's per-account dollars); null in CLP. */
  cashUsdToday: number | null
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
          if (ymd === grid[grid.length - 1] && cashUsdToday != null) return cashUsdToday;
          const usd = clpToUnitAt(clp, ymd, "usd");
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
    const values = grid.map((ymd) => byDate.get(ymd) ?? null);
    // A child group that starts holding inside the window reads a finite 0 before (a member
    // marks 0, not null): the line starts at its first non-zero day, as the monthly block does.
    nullLeadingZeroRun(values);
    // A sold-out child group (e.g. mutual funds after the fund was liquidated) reads a finite 0
    // every day after, which would hug zero to today; the monthly `accounts_ex_property` block is
    // clipped by `applyTrailingZeroTailClipToBlock`, so mirror it here — same kept-zeros rule.
    const startNullAt = trailingZeroRunClipStartIndex(values);
    if (startNullAt != null) for (let i = startNullAt; i < values.length; i++) values[i] = null;
    lines.push({ dataKey, values });
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
  const grid = chileCalendarDaysListEndingAt(endYmd, count);
  const byDate = buildDashboardBucketDailySeriesClp(grid);
  const liabByDate = liabilitiesClpByDate(grid);

  // Same leading-null convention as the monthly overview: real_estate and liabilities stay
  // null (line not drawn) until their first non-zero value — a flat 0 pre-ownership reads
  // as data, not absence.
  let reStarted = false;
  let liabStarted = false;
  // Today in USD is the headline's figure (Σ of each account's own dollars), never the
  // bucket's pesos ÷ one live rate: a cuota or a pre-open stock is priced on an earlier day.
  const usdToday = unit === "usd" ? dashboardBucketsUsdToday() : null;
  const points: OverviewDailyPoint[] = grid.map((ymd) => {
    const row = byDate.get(ymd)!;
    const isToday = ymd === endYmd && usdToday != null;
    const pick = (clp: number): number | null => {
      if (unit === "clp") return clp;
      const usd = clpToUnitAt(clp, ymd, "usd");
      return usd != null && Number.isFinite(usd) ? usd : null;
    };
    const bucket = (slug: "real_estate" | "retirement" | "brokerage" | "cash_eqs" | "net_worth"): number | null =>
      isToday ? usdToday![slug] : pick(row[slug]);
    if (!reStarted && Math.abs(row.real_estate) >= 0.5) reStarted = true;
    const liabClp = liabByDate.get(ymd)!;
    if (!liabStarted && Math.abs(liabClp) >= 0.5) liabStarted = true;
    return {
      as_of_date: ymd,
      net_worth: bucket("net_worth"),
      real_estate: reStarted ? bucket("real_estate") : null,
      retirement: bucket("retirement"),
      brokerage: bucket("brokerage"),
      cash_eqs: bucket("cash_eqs"),
      invested: isToday ? usdToday!.retirement + usdToday!.brokerage : pick(row.retirement + row.brokerage),
      liabilities: liabStarted ? pick(liabClp) : null,
      ...milestoneFieldsForDate(ymd, unit),
    };
  });

  const cashNettedClpByDate = new Map(grid.map((ymd) => [ymd, byDate.get(ymd)!.cash_eqs]));
  const primary_lines = buildPrimaryDailyLines(unit, days, grid, cashNettedClpByDate, usdToday?.cash_eqs ?? null);

  // Composition shares (day grain): the same lines and marks as the monthly block, sampled
  // daily (shares are unit-invariant, so the CLP marks serve both units).
  const compositionSpecs = compositionLineSpecsFromNavTree((slug) => listAccountsForGroupTab(slug));
  const allocation_proportional = buildCompositionBlock(
    grid,
    compositionSpecs,
    compositionValuesOnGridClp(compositionSpecs, grid)
  );

  return {
    unit,
    days,
    end_ymd: endYmd,
    points,
    primary_lines,
    allocation_proportional,
    ath: getNetWorthAllTimeHigh(unit),
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
