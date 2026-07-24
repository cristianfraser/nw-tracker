import type { AccountMonthlyPerformanceRow } from "./accountPerformance.js";
import { pickRepresentativeMonthlyPerfRow } from "./accountPerformanceMonthPick.js";
import { withAccountValuationTsCache } from "./accountPerformanceContext.js";
import {
  densifyMonthlyPoints,
  densifyYearlyPoints,
  monthEndUtcYmd,
  monthKeyFromYmd,
} from "./calendarMonth.js";
import { chileCalendarTodayYmd } from "./chileDate.js";
import {
  getGroupConsolidatedMonthlyPerfForRows,
  getGroupConsolidationAccountMonthly,
  type ConsolidatedMonthlyPerfRow,
} from "./groupMonthlyPerfConsolidation.js";
import { listAccountsForGroupTab } from "./valuationTimeseries.js";
import { resolveGroupDailySeries } from "./groupDailySeries.js";

/** Money buckets on the flows → PL page (real estate and liabilities excluded). */
export const FLOWS_PL_BUCKETS = [
  { slug: "brokerage", group_slug: "brokerage", label_i18n_key: "dashboard.buckets.brokerage" },
  { slug: "retirement", group_slug: "retirement", label_i18n_key: "dashboard.buckets.retirement" },
  { slug: "cash", group_slug: "cash_eqs", label_i18n_key: "dashboard.buckets.cash_eqs" },
] as const;
export type FlowsPlBucketSlug = (typeof FLOWS_PL_BUCKETS)[number]["slug"];

export type FlowsPlChartPoint = {
  /** UTC month-end (`YYYY-12-31` for yearly rows). */
  as_of_date: string;
  brokerage: number;
  retirement: number;
  cash: number;
  total: number;
  /** Running Σ `total` within the calendar year (resets each January). */
  ytd_total: number;
  /** Running Σ `total` from the first period of the series. */
  cumulative_total: number;
};

export type FlowsPlAccountRow = {
  account_id: number;
  name: string;
  pl_month_clp: number;
  pl_month_usd: number;
  pl_ytd_clp: number;
  pl_ytd_usd: number;
  pl_cumulative_clp: number;
  pl_cumulative_usd: number;
};

export type FlowsPlBucketBlock = {
  slug: FlowsPlBucketSlug;
  group_slug: string;
  label_i18n_key: string;
  total_month_clp: number;
  total_month_usd: number;
  total_ytd_clp: number;
  total_ytd_usd: number;
  total_cumulative_clp: number;
  total_cumulative_usd: number;
  accounts: FlowsPlAccountRow[];
};

export type FlowsPlPayload = {
  chart_monthly: FlowsPlChartPoint[];
  chart_yearly: FlowsPlChartPoint[];
  chart_monthly_usd: FlowsPlChartPoint[];
  chart_yearly_usd: FlowsPlChartPoint[];
  /** Per-calendar-day P/L (Diario), windowed to `?days`; present only when `days` is passed. */
  chart_daily?: FlowsPlChartPoint[];
  chart_daily_usd?: FlowsPlChartPoint[];
  by_bucket: FlowsPlBucketBlock[];
};

const ZERO_PL_EPS = 0.005;

/** Per-bucket consolidated monthly P/L folded into chart points (union of periods, zero-filled). */
export function assembleFlowsPlChartSeries(
  byBucket: Record<FlowsPlBucketSlug, readonly ConsolidatedMonthlyPerfRow[]>,
  granularity: "month" | "year"
): FlowsPlChartPoint[] {
  const byPeriod = new Map<string, FlowsPlChartPoint>();
  for (const bucket of FLOWS_PL_BUCKETS) {
    for (const row of byBucket[bucket.slug]) {
      const nominal = row.nominal_pl ?? 0;
      if (!Number.isFinite(nominal)) {
        throw new Error(
          `flows PL: non-finite nominal_pl for bucket ${bucket.slug} at ${row.as_of_date}`
        );
      }
      const asOf =
        granularity === "year"
          ? `${row.as_of_date.slice(0, 4)}-12-31`
          : monthEndUtcYmd(monthKeyFromYmd(row.as_of_date));
      let pt = byPeriod.get(asOf);
      if (!pt) {
        pt = {
          as_of_date: asOf,
          brokerage: 0,
          retirement: 0,
          cash: 0,
          total: 0,
          ytd_total: 0,
          cumulative_total: 0,
        };
        byPeriod.set(asOf, pt);
      }
      pt[bucket.slug] += nominal;
      pt.total += nominal;
    }
  }
  const sorted = [...byPeriod.values()].sort((a, b) => a.as_of_date.localeCompare(b.as_of_date));
  // Accounts exist for months before any P/L accrues (nulls → 0); leading all-zero
  // periods are information-free and would drag chart timelines back for nothing.
  const firstNonZero = sorted.findIndex(
    (pt) =>
      Math.abs(pt.brokerage) >= ZERO_PL_EPS ||
      Math.abs(pt.retirement) >= ZERO_PL_EPS ||
      Math.abs(pt.cash) >= ZERO_PL_EPS
  );
  const trimmed = firstNonZero < 0 ? [] : sorted.slice(firstNonZero);
  const emptyPoint = (as_of_date: string): FlowsPlChartPoint => ({
    as_of_date,
    brokerage: 0,
    retirement: 0,
    cash: 0,
    total: 0,
    ytd_total: 0,
    cumulative_total: 0,
  });
  const densified =
    granularity === "year"
      ? densifyYearlyPoints(trimmed, emptyPoint)
      : densifyMonthlyPoints(trimmed, emptyPoint);
  let year = "";
  let ytd = 0;
  let cumulative = 0;
  for (const pt of densified) {
    const y = pt.as_of_date.slice(0, 4);
    if (y !== year) {
      year = y;
      ytd = 0;
    }
    ytd += pt.total;
    cumulative += pt.total;
    pt.ytd_total = ytd;
    pt.cumulative_total = cumulative;
  }
  return densified;
}

/**
 * Per-calendar-day P/L per bucket (Diario), summed from each bucket's shared daily series
 * (`pg:<group_slug>`). The three buckets share one grid (same `days`, same today), so merging
 * by `as_of_date` is exact. `ytd_total` / `cumulative_total` accumulate over the windowed grid
 * (window-relative, like every daily view). Σ(daily `total` over a calendar month) reconciles
 * to the monthly chart's `total` — same marks, one sampling per grid vs month-end.
 */
export function buildFlowsPlDailyChartSeries(
  unit: "clp" | "usd",
  days: number
): FlowsPlChartPoint[] {
  const byDay = new Map<string, FlowsPlChartPoint>();
  for (const bucket of FLOWS_PL_BUCKETS) {
    const series = resolveGroupDailySeries(bucket.group_slug, unit, days);
    if (!series) continue;
    for (const pt of series.points) {
      let out = byDay.get(pt.as_of_date);
      if (!out) {
        out = {
          as_of_date: pt.as_of_date,
          brokerage: 0,
          retirement: 0,
          cash: 0,
          total: 0,
          ytd_total: 0,
          cumulative_total: 0,
        };
        byDay.set(pt.as_of_date, out);
      }
      const pl = pt.pl ?? 0;
      out[bucket.slug] += pl;
      out.total += pl;
    }
  }
  const sorted = [...byDay.values()].sort((a, b) => a.as_of_date.localeCompare(b.as_of_date));
  let year = "";
  let ytd = 0;
  let cumulative = 0;
  for (const pt of sorted) {
    const y = pt.as_of_date.slice(0, 4);
    if (y !== year) {
      year = y;
      ytd = 0;
    }
    ytd += pt.total;
    cumulative += pt.total;
    pt.ytd_total = ytd;
    pt.cumulative_total = cumulative;
  }
  return sorted;
}

/**
 * Current-month / YTD / cumulative nominal P/L from an account's monthly perf rows.
 * One representative row per calendar month (same pick as group consolidation), so
 * Σ over a bucket's accounts equals the consolidated series by construction.
 */
export function flowsPlAccountPerfSummary(monthly: readonly AccountMonthlyPerformanceRow[]): {
  pl_month: number;
  pl_ytd: number;
  pl_cumulative: number;
} {
  const today = chileCalendarTodayYmd();
  const currentMk = monthKeyFromYmd(today);
  const currentYear = today.slice(0, 4);

  const byMonth = new Map<string, AccountMonthlyPerformanceRow[]>();
  for (const row of monthly) {
    const mk = monthKeyFromYmd(row.as_of_date);
    const arr = byMonth.get(mk) ?? [];
    arr.push(row);
    byMonth.set(mk, arr);
  }

  let pl_month = 0;
  let pl_ytd = 0;
  let pl_cumulative = 0;
  for (const [mk, rows] of byMonth) {
    const picked = pickRepresentativeMonthlyPerfRow([...rows], mk);
    const nominal =
      picked.nominal_pl != null && Number.isFinite(picked.nominal_pl) ? picked.nominal_pl : 0;
    pl_cumulative += nominal;
    if (mk.slice(0, 4) === currentYear) pl_ytd += nominal;
    if (mk === currentMk) pl_month += nominal;
  }
  return { pl_month, pl_ytd, pl_cumulative };
}

type ConsolidationAccountPayload = ReturnType<typeof getGroupConsolidationAccountMonthly>[number];

function buildFlowsPlBucketBlock(
  bucket: (typeof FLOWS_PL_BUCKETS)[number],
  accountsClp: readonly ConsolidationAccountPayload[],
  accountsUsd: readonly ConsolidationAccountPayload[]
): FlowsPlBucketBlock {
  const usdById = new Map(accountsUsd.map((a) => [a.account_id, a]));
  const accounts: FlowsPlAccountRow[] = [];
  for (const acc of accountsClp) {
    const usd = usdById.get(acc.account_id);
    if (!usd) {
      throw new Error(
        `flows PL: USD consolidation missing account ${acc.account_id} (${acc.name}) in bucket ${bucket.slug}`
      );
    }
    const clpSummary = flowsPlAccountPerfSummary(acc.monthly);
    const usdSummary = flowsPlAccountPerfSummary(usd.monthly);
    const row: FlowsPlAccountRow = {
      account_id: acc.account_id,
      name: acc.name,
      pl_month_clp: clpSummary.pl_month,
      pl_month_usd: usdSummary.pl_month,
      pl_ytd_clp: clpSummary.pl_ytd,
      pl_ytd_usd: usdSummary.pl_ytd,
      pl_cumulative_clp: clpSummary.pl_cumulative,
      pl_cumulative_usd: usdSummary.pl_cumulative,
    };
    for (const [field, v] of Object.entries(row)) {
      if (typeof v === "number" && !Number.isFinite(v)) {
        throw new Error(`flows PL: non-finite ${field} for account ${acc.account_id} (${acc.name})`);
      }
    }
    // Accounts with no P/L ever (e.g. interest-free checking) are noise on a P/L breakdown.
    const allZero =
      Math.abs(row.pl_month_clp) < ZERO_PL_EPS &&
      Math.abs(row.pl_ytd_clp) < ZERO_PL_EPS &&
      Math.abs(row.pl_cumulative_clp) < ZERO_PL_EPS &&
      Math.abs(row.pl_month_usd) < ZERO_PL_EPS &&
      Math.abs(row.pl_ytd_usd) < ZERO_PL_EPS &&
      Math.abs(row.pl_cumulative_usd) < ZERO_PL_EPS;
    if (allZero) continue;
    accounts.push(row);
  }
  accounts.sort((a, b) => b.pl_cumulative_clp - a.pl_cumulative_clp);

  const sum = (pick: (a: FlowsPlAccountRow) => number) =>
    accounts.reduce((s, a) => s + pick(a), 0);
  return {
    slug: bucket.slug,
    group_slug: bucket.group_slug,
    label_i18n_key: bucket.label_i18n_key,
    total_month_clp: sum((a) => a.pl_month_clp),
    total_month_usd: sum((a) => a.pl_month_usd),
    total_ytd_clp: sum((a) => a.pl_ytd_clp),
    total_ytd_usd: sum((a) => a.pl_ytd_usd),
    total_cumulative_clp: sum((a) => a.pl_cumulative_clp),
    total_cumulative_usd: sum((a) => a.pl_cumulative_usd),
    accounts,
  };
}

/** @heavy 3 buckets × 2 units of consolidated monthly perf (inner per-account/group caches). */
export function buildFlowsPlPayload(opts?: { days?: number }): FlowsPlPayload {
  return withAccountValuationTsCache(() => {
    const consolidatedClp = {} as Record<FlowsPlBucketSlug, ConsolidatedMonthlyPerfRow[]>;
    const consolidatedUsd = {} as Record<FlowsPlBucketSlug, ConsolidatedMonthlyPerfRow[]>;
    const by_bucket: FlowsPlBucketBlock[] = [];
    for (const bucket of FLOWS_PL_BUCKETS) {
      const rows = listAccountsForGroupTab(bucket.group_slug);
      consolidatedClp[bucket.slug] = getGroupConsolidatedMonthlyPerfForRows(
        rows,
        bucket.group_slug,
        "clp"
      );
      consolidatedUsd[bucket.slug] = getGroupConsolidatedMonthlyPerfForRows(
        rows,
        bucket.group_slug,
        "usd"
      );
      by_bucket.push(
        buildFlowsPlBucketBlock(
          bucket,
          getGroupConsolidationAccountMonthly(rows, bucket.group_slug, "clp"),
          getGroupConsolidationAccountMonthly(rows, bucket.group_slug, "usd")
        )
      );
    }
    const payload: FlowsPlPayload = {
      chart_monthly: assembleFlowsPlChartSeries(consolidatedClp, "month"),
      chart_yearly: assembleFlowsPlChartSeries(consolidatedClp, "year"),
      chart_monthly_usd: assembleFlowsPlChartSeries(consolidatedUsd, "month"),
      chart_yearly_usd: assembleFlowsPlChartSeries(consolidatedUsd, "year"),
      by_bucket,
    };
    if (opts?.days != null) {
      payload.chart_daily = buildFlowsPlDailyChartSeries("clp", opts.days);
      payload.chart_daily_usd = buildFlowsPlDailyChartSeries("usd", opts.days);
    }
    return payload;
  });
}
