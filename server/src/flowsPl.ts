import { isHomeCurrency } from "./displayUnits.js";
import type { AccountMonthlyPerformanceRow } from "./accountPerformance.js";
import { pickRepresentativeMonthlyPerfRow } from "./accountPerformanceMonthPick.js";
import { withAccountValuationTsCache } from "./accountPerformanceContext.js";
import { densifyMonthlyPoints, monthEndUtcYmd, monthKeyFromYmd } from "./calendarMonth.js";
import { chileCalendarTodayYmd } from "./chileDate.js";
import {
  getGroupConsolidatedMonthlyPerfForRows,
  getGroupConsolidationAccountMonthly,
  type ConsolidatedMonthlyPerfRow,
} from "./groupMonthlyPerfConsolidation.js";
import { listAccountsForGroupTab } from "./valuationTimeseries.js";
import { getBucketDailySeriesCached } from "./dailySeries.js";
import { accountIdsUnderCheckingAccounts } from "./movementBalanceCashAccounts.js";
import { db } from "./db.js";
import { cachedMortgageCarryingEvents, type MortgageCarryingEvent } from "./flowsMortgageCarrying.js";

/**
 * Market P/L of the accounts whose deposits the flows pages count — the /flows P/L page and the
 * flows overview's P/L leg read this one builder (2026-10-27), so the two cannot drift:
 * - brokerage and retirement;
 * - cash: cash_eqs WITHOUT the accounts under Checking accounts — their own P/L (the plan fee,
 *   fx on the dollar account) is already a gasto or in the cash change;
 * - real estate: the property's P/L with its mortgage carrying added back
 *   (`flowsMortgageCarrying.ts`) — the property counts the interés + seguros as a loss, and gastos
 *   already counts them, so the market P/L is the UF revaluation alone.
 * Liabilities stay out.
 */
export const FLOWS_PL_BUCKETS = [
  { slug: "brokerage", group_slug: "brokerage", label_i18n_key: "dashboard.buckets.brokerage" },
  { slug: "retirement", group_slug: "retirement", label_i18n_key: "dashboard.buckets.retirement" },
  { slug: "cash", group_slug: "cash_eqs", label_i18n_key: "dashboard.buckets.cash_eqs" },
  { slug: "real_estate", group_slug: "real_estate", label_i18n_key: "dashboard.buckets.real_estate" },
] as const;
export type FlowsPlBucketSlug = (typeof FLOWS_PL_BUCKETS)[number]["slug"];


/** A bucket's accounts: the group tab's, less the checking accounts. */
function flowsPlBucketRows(bucket: (typeof FLOWS_PL_BUCKETS)[number]) {
  const checking = new Set(accountIdsUnderCheckingAccounts());
  const all = listAccountsForGroupTab(bucket.group_slug);
  const rows = all.filter((r) => !checking.has(r.account_id));
  return { rows, whole: rows.length === all.length };
}

/** The account each carrying event's deposit belongs to (the property). */
function carryingAccountId(e: MortgageCarryingEvent): number {
  const row = db
    .prepare(`SELECT COALESCE(account_id, to_account_id) AS account_id FROM movements WHERE id = ?`)
    .get(e.deposit_movement_id) as { account_id: number | null } | undefined;
  if (!row || row.account_id == null) {
    throw new Error(`flows PL: mortgage deposit movement ${e.deposit_movement_id} not found`);
  }
  return row.account_id;
}

function carryingByMonthEnd(events: readonly MortgageCarryingEvent[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const e of events) {
    const end = monthEndUtcYmd(monthKeyFromYmd(e.occurred_on));
    out.set(end, (out.get(end) ?? 0) + e.amount);
  }
  return out;
}

export type FlowsPlChartPoint = {
  /** UTC month-end. */
  as_of_date: string;
  brokerage: number;
  retirement: number;
  cash: number;
  real_estate: number;
  total: number;
  /** Running Σ `total` within the calendar year (resets each January). */
  ytd_total: number;
  /** Running Σ `total` from the first period of the series. */
  cumulative_total: number;
};

/** One account's P/L in the payload's unit (current month, YTD, since the start). */
export type FlowsPlAccountRow = {
  account_id: number;
  name: string;
  pl_month: number;
  pl_ytd: number;
  pl_cumulative: number;
};

export type FlowsPlBucketBlock = {
  slug: FlowsPlBucketSlug;
  group_slug: string;
  label_i18n_key: string;
  total_month: number;
  total_ytd: number;
  total_cumulative: number;
  accounts: FlowsPlAccountRow[];
};

/** `GET /api/flows/pl?unit=`: every amount in `unit`. */
export type FlowsPlPayload = {
  unit: string;
  /**
   * Monthly only: the page's yearly chart rolls these up client-side AFTER cutting the months at
   * its own Rango (a partial first year), and the year table rolls them the same way.
   */
  chart_monthly: FlowsPlChartPoint[];
  /** Per-calendar-day P/L (Diario), windowed to `?days`; present only when `days` is passed. */
  chart_daily?: FlowsPlChartPoint[];
  by_bucket: FlowsPlBucketBlock[];
};

const ZERO_PL_EPS = 0.005;

function emptyChartPoint(as_of_date: string): FlowsPlChartPoint {
  return {
    as_of_date,
    brokerage: 0,
    retirement: 0,
    cash: 0,
    real_estate: 0,
    total: 0,
    ytd_total: 0,
    cumulative_total: 0,
  };
}

/** Running YTD (resets each January) and cumulative totals over ascending points, in place. */
function accumulateTotals(points: FlowsPlChartPoint[]): void {
  let year = "";
  let ytd = 0;
  let cumulative = 0;
  for (const pt of points) {
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
}

/**
 * Per-bucket consolidated monthly P/L folded into chart points (union of months, zero-filled);
 * `carryingByMonthEnd` (month-end → mortgage carrying) goes back into the real-estate bucket.
 */
export function assembleFlowsPlChartSeries(
  byBucket: Record<FlowsPlBucketSlug, readonly ConsolidatedMonthlyPerfRow[]>,
  carryingByMonthEnd: ReadonlyMap<string, number> = new Map()
): FlowsPlChartPoint[] {
  const byPeriod = new Map<string, FlowsPlChartPoint>();
  const touch = (asOf: string): FlowsPlChartPoint => {
    let pt = byPeriod.get(asOf);
    if (!pt) {
      pt = emptyChartPoint(asOf);
      byPeriod.set(asOf, pt);
    }
    return pt;
  };
  for (const bucket of FLOWS_PL_BUCKETS) {
    for (const row of byBucket[bucket.slug]) {
      const nominal = row.nominal_pl ?? 0;
      if (!Number.isFinite(nominal)) {
        throw new Error(
          `flows PL: non-finite nominal_pl for bucket ${bucket.slug} at ${row.as_of_date}`
        );
      }
      const pt = touch(monthEndUtcYmd(monthKeyFromYmd(row.as_of_date)));
      pt[bucket.slug] += nominal;
      pt.total += nominal;
    }
  }
  for (const [asOf, carrying] of carryingByMonthEnd) {
    const pt = touch(asOf);
    pt.real_estate += carrying;
    pt.total += carrying;
  }
  const sorted = [...byPeriod.values()].sort((a, b) => a.as_of_date.localeCompare(b.as_of_date));
  // Accounts exist for months before any P/L accrues (nulls → 0); leading all-zero
  // months are information-free and would drag chart timelines back for nothing.
  const firstNonZero = sorted.findIndex((pt) =>
    FLOWS_PL_BUCKETS.some((b) => Math.abs(pt[b.slug]) >= ZERO_PL_EPS)
  );
  const trimmed = firstNonZero < 0 ? [] : sorted.slice(firstNonZero);
  const densified = densifyMonthlyPoints(trimmed, emptyChartPoint);
  accumulateTotals(densified);
  return densified;
}

/** The consolidated monthly P/L of each bucket's accounts, in the unit. */
function consolidatedByBucket(unit: string): Record<FlowsPlBucketSlug, ConsolidatedMonthlyPerfRow[]> {
  const out = {} as Record<FlowsPlBucketSlug, ConsolidatedMonthlyPerfRow[]>;
  for (const bucket of FLOWS_PL_BUCKETS) {
    const { rows } = flowsPlBucketRows(bucket);
    out[bucket.slug] = rows.length > 0 ? getGroupConsolidatedMonthlyPerfForRows(rows, bucket.group_slug, unit) : [];
  }
  return out;
}

/**
 * The monthly market P/L series of one unit: the /flows P/L page's chart and table, and the flows
 * overview's P/L leg (`total` per month) — one builder for both.
 */
export function buildFlowsPlChartMonthly(
  unit: string,
  carrying: readonly MortgageCarryingEvent[]
): FlowsPlChartPoint[] {
  return withAccountValuationTsCache(() =>
    assembleFlowsPlChartSeries(consolidatedByBucket(unit), carryingByMonthEnd(carrying))
  );
}

/**
 * Per-calendar-day P/L per bucket (Diario), summed from each bucket's daily series — the group's
 * own (`pg:<group_slug>`, shared with its page) when nothing is left out of it, else a scope of
 * its own (`flows.pl:<group_slug>`, cash without checking). The buckets share one grid (same
 * `days`, same today), so merging by `as_of_date` is exact; the carrying lands on its day in the
 * real-estate bucket (days outside the window are dropped). `ytd_total` / `cumulative_total`
 * accumulate over the windowed grid (window-relative, like every daily view). Σ(daily `total`
 * over a calendar month) reconciles to the monthly chart's `total`.
 */
export function buildFlowsPlDailyChartSeries(
  unit: string,
  days: number,
  carrying: readonly MortgageCarryingEvent[]
): FlowsPlChartPoint[] {
  const byDay = new Map<string, FlowsPlChartPoint>();
  for (const bucket of FLOWS_PL_BUCKETS) {
    const { rows, whole } = flowsPlBucketRows(bucket);
    const accounts = rows.filter((r) => r.account_id > 0);
    if (accounts.length === 0) continue;
    const scope = whole ? `pg:${bucket.group_slug}` : `flows.pl:${bucket.group_slug}`;
    const series = getBucketDailySeriesCached(scope, accounts, { unit, days, includeAccounts: true });
    for (const pt of series.points) {
      let out = byDay.get(pt.as_of_date);
      if (!out) {
        out = emptyChartPoint(pt.as_of_date);
        byDay.set(pt.as_of_date, out);
      }
      const pl = pt.pl ?? 0;
      out[bucket.slug] += pl;
      out.total += pl;
    }
  }
  for (const e of carrying) {
    const out = byDay.get(e.occurred_on);
    if (!out) continue;
    out.real_estate += e.amount;
    out.total += e.amount;
  }
  const sorted = [...byDay.values()].sort((a, b) => a.as_of_date.localeCompare(b.as_of_date));
  accumulateTotals(sorted);
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

/** Current-month / YTD / cumulative Σ of carrying events (Chile clock), like {@link flowsPlAccountPerfSummary}. */
function carryingSummary(events: readonly MortgageCarryingEvent[]): { pl_month: number; pl_ytd: number; pl_cumulative: number } {
  const today = chileCalendarTodayYmd();
  const out = { pl_month: 0, pl_ytd: 0, pl_cumulative: 0 };
  for (const e of events) {
    out.pl_cumulative += e.amount;
    if (e.occurred_on.slice(0, 4) === today.slice(0, 4)) out.pl_ytd += e.amount;
    if (e.occurred_on.slice(0, 7) === today.slice(0, 7)) out.pl_month += e.amount;
  }
  return out;
}

function buildFlowsPlBucketBlock(
  bucket: (typeof FLOWS_PL_BUCKETS)[number],
  accountsClp: readonly ConsolidationAccountPayload[],
  accountsUnit: readonly ConsolidationAccountPayload[],
  unit: string,
  carryingByAccount: ReadonlyMap<number, { clp: MortgageCarryingEvent[]; unit: MortgageCarryingEvent[] }>
): FlowsPlBucketBlock {
  const unitById = new Map(accountsUnit.map((a) => [a.account_id, a]));
  const ranked: { row: FlowsPlAccountRow; cumulativeClp: number }[] = [];
  for (const acc of accountsClp) {
    const inUnit = unitById.get(acc.account_id);
    if (!inUnit) {
      throw new Error(
        `flows PL: ${unit} consolidation missing account ${acc.account_id} (${acc.name}) in bucket ${bucket.slug}`
      );
    }
    const clpSummary = flowsPlAccountPerfSummary(acc.monthly);
    const unitSummary = isHomeCurrency(unit) ? clpSummary : flowsPlAccountPerfSummary(inUnit.monthly);
    // The property's mortgage carrying back into its P/L (a gasto already), as in the chart.
    const carrying = carryingByAccount.get(acc.account_id);
    if (carrying) {
      const pairs: (readonly [ReturnType<typeof flowsPlAccountPerfSummary>, readonly MortgageCarryingEvent[]])[] =
        isHomeCurrency(unit) ? [[clpSummary, carrying.clp]] : [[clpSummary, carrying.clp], [unitSummary, carrying.unit]];
      for (const [summary, events] of pairs) {
        const c = carryingSummary(events);
        summary.pl_month += c.pl_month;
        summary.pl_ytd += c.pl_ytd;
        summary.pl_cumulative += c.pl_cumulative;
      }
    }
    const row: FlowsPlAccountRow = {
      account_id: acc.account_id,
      name: acc.name,
      pl_month: unitSummary.pl_month,
      pl_ytd: unitSummary.pl_ytd,
      pl_cumulative: unitSummary.pl_cumulative,
    };
    for (const [field, v] of Object.entries(row)) {
      if (typeof v === "number" && !Number.isFinite(v)) {
        throw new Error(`flows PL: non-finite ${field} for account ${acc.account_id} (${acc.name})`);
      }
    }
    // Accounts with no P/L ever (e.g. interest-free checking) are noise on a P/L breakdown:
    // zero in pesos and in the unit.
    const zero = (v: number) => Math.abs(v) < ZERO_PL_EPS;
    const allZero =
      zero(clpSummary.pl_month) &&
      zero(clpSummary.pl_ytd) &&
      zero(clpSummary.pl_cumulative) &&
      zero(row.pl_month) &&
      zero(row.pl_ytd) &&
      zero(row.pl_cumulative);
    if (allZero) continue;
    ranked.push({ row, cumulativeClp: clpSummary.pl_cumulative });
  }
  // Ordered by the pesos whatever the unit, so every unit lists the accounts alike.
  ranked.sort((a, b) => b.cumulativeClp - a.cumulativeClp);
  const accounts = ranked.map((r) => r.row);
  const sum = (pick: (a: FlowsPlAccountRow) => number) =>
    accounts.reduce((s, a) => s + pick(a), 0);
  return {
    slug: bucket.slug,
    group_slug: bucket.group_slug,
    label_i18n_key: bucket.label_i18n_key,
    total_month: sum((a) => a.pl_month),
    total_ytd: sum((a) => a.pl_ytd),
    total_cumulative: sum((a) => a.pl_cumulative),
    accounts,
  };
}

/** @heavy 4 buckets of consolidated monthly perf in the unit (and pesos, the accounts' order). */
export function buildFlowsPlPayload(unit: string = "clp", opts?: { days?: number }): FlowsPlPayload {
  const carryingClp = cachedMortgageCarryingEvents("clp");
  const carryingUnit = isHomeCurrency(unit) ? carryingClp : cachedMortgageCarryingEvents(unit);
  return withAccountValuationTsCache(() => {
    const carryingByAccount = new Map<number, { clp: MortgageCarryingEvent[]; unit: MortgageCarryingEvent[] }>();
    for (const [leg, events] of [
      ["clp", carryingClp],
      ["unit", carryingUnit],
    ] as const) {
      for (const e of events) {
        const id = carryingAccountId(e);
        const entry = carryingByAccount.get(id) ?? { clp: [], unit: [] };
        entry[leg].push(e);
        carryingByAccount.set(id, entry);
      }
    }
    const by_bucket: FlowsPlBucketBlock[] = [];
    for (const bucket of FLOWS_PL_BUCKETS) {
      const { rows } = flowsPlBucketRows(bucket);
      for (const id of carryingByAccount.keys()) {
        if (bucket.slug !== "real_estate" && rows.some((r) => r.account_id === id)) {
          throw new Error(`flows PL: mortgage carrying on account ${id} outside the real-estate bucket`);
        }
      }
      const accountsClp = getGroupConsolidationAccountMonthly(rows, bucket.group_slug, "clp");
      by_bucket.push(
        buildFlowsPlBucketBlock(
          bucket,
          accountsClp,
          isHomeCurrency(unit) ? accountsClp : getGroupConsolidationAccountMonthly(rows, bucket.group_slug, unit),
          unit,
          bucket.slug === "real_estate" ? carryingByAccount : new Map()
        )
      );
    }
    const payload: FlowsPlPayload = {
      unit,
      chart_monthly: buildFlowsPlChartMonthly(unit, carryingUnit),
      by_bucket,
    };
    if (opts?.days != null) payload.chart_daily = buildFlowsPlDailyChartSeries(unit, opts.days, carryingUnit);
    return payload;
  });
}
