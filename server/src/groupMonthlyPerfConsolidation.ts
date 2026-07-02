import {
  getAccountMonthlyPerformance,
  mapMonthlyClosingToChartDates,
  patchOrInsertLiveCurrentMonthPerfRows,
  type AccountMonthlyPerformanceRow,
} from "./accountPerformance.js";
import { accountCountsTowardGroupTotals } from "./accountGroupTotals.js";
import { loadBookValuationsAsc } from "./bookValuations.js";
import {
  checkingMovementBalanceClpAtCached,
  checkingMovementBalanceLive,
} from "./checkingCartolaBalances.js";
import { monthEndsBetweenInclusive, monthEndUtcYmd, monthKeyFromYmd } from "./calendarMonth.js";
import { chileCalendarTodayYmd } from "./chileDate.js";
import { pickRepresentativeMonthlyPerfRow } from "./accountPerformanceMonthPick.js";
import {
  monthEndCloseClpForAccount,
  monthEndCloseFromPerfRows,
  priorCalendarMonthKey,
} from "./accountPeriodMarks.js";
import { db } from "./db.js";
import { fxMonthEndForBalanceUsd, ufRowOnOrBefore } from "./fxRates.js";
import { isMovementBalanceCashCategory } from "./movementBalanceCashAccounts.js";
import { isUsdCashKindSlug } from "./movementTransfer.js";
import { usdCashBalanceClpAt } from "./usdCashAccounts.js";
import { isClpCashKindSlug, clpCashBalanceClpAt } from "./clpCashAccounts.js";
import { accountBucketKindSlug } from "./accountBucket.js";
import { syncLatestDisplayValueClp } from "./syncLatestDisplayValueClp.js";
import { isCashEqsNwValuationGroupSlug, isCashSavingsValuationGroupSlug } from "./assetGroupTree.js";
import { netLinkedCreditCardFromCashConsolidated } from "./cashEqsBucketNet.js";
import { seriesAccountIdForGroupTab } from "./groupTabAccounts.js";
import { movementBoundsByAccountIds } from "./movementBounds.js";
import { getAggregationCached } from "./aggregationCache.js";
import { withAccountValuationTsCache } from "./accountPerformanceContext.js";

export type TsUnit = "clp" | "usd" | "uf";

export type GroupTabAccountRow = {
  account_id: number;
  name: string;
  bucket_slug: string;
  notes?: string | null;
  exclude_from_group_totals: number;
  /** Long trailing-zero tail; omit from nav child cards only (charts/tables keep the series). */
  chart_inactive?: boolean;
};

function convertTs(clp: number, asOf: string, unit: TsUnit): number {
  if (unit === "usd") {
    const fx = fxMonthEndForBalanceUsd(asOf);
    if (!fx || fx.clp_per_usd <= 0) return Number.NaN;
    return clp / fx.clp_per_usd;
  }
  if (unit === "uf") {
    const u = ufRowOnOrBefore(asOf);
    return u && u.clp_per_uf > 0 ? clp / u.clp_per_uf : clp;
  }
  return clp;
}

export type ConsolidatedMonthlyPerfRow = {
  as_of_date: string;
  closing_value: number;
  prior_closing: number | null;
  net_capital_flow: number;
  stock_units_inflow: number;
  nominal_pl: number | null;
  pct_month: number | null;
  ytd_nominal_pl: number | null;
  cumulative_nominal_pl: number | null;
};

const MONTH_ROW_EPS = 0.01;
const GROUP_TAB_VAL_TOTAL = "__group_val_total";

function recomputeYtdAndCumulative(
  rowsAsc: ConsolidatedMonthlyPerfRow[]
): ConsolidatedMonthlyPerfRow[] {
  let ytdYear = 0;
  let ytdRun = 0;
  let cumPl = 0;
  return rowsAsc.map((row) => {
    const y = Number(row.as_of_date.slice(0, 4));
    if (!Number.isFinite(y)) return row;
    if (y !== ytdYear) {
      ytdYear = y;
      ytdRun = 0;
    }
    const nominal = row.nominal_pl ?? 0;
    ytdRun += nominal;
    cumPl += nominal;
    return { ...row, ytd_nominal_pl: ytdRun, cumulative_nominal_pl: cumPl };
  });
}

function balanceOnlyMonthlyRowsAsc(
  accountId: number,
  categorySlug: string,
  unit: TsUnit,
  monthEndsAsc: string[],
  closeAt: (asOf: string) => number
): AccountMonthlyPerformanceRow[] {
  const outAsc: AccountMonthlyPerformanceRow[] = [];
  let prevClose: number | null = null;
  let ytdYear = 0;
  let ytdRun = 0;
  let cumPl = 0;

  for (const asOf of monthEndsAsc) {
    const close = closeAt(asOf);
    if (!Number.isFinite(close)) continue;
    const netFlow = 0;
    const nominal = prevClose != null ? close - prevClose - netFlow : null;
    const y = Number(asOf.slice(0, 4));
    if (Number.isFinite(y) && y !== ytdYear) {
      ytdYear = y;
      ytdRun = 0;
    }
    const nIn = nominal != null && Number.isFinite(nominal) ? nominal : 0;
    ytdRun += nIn;
    cumPl += nIn;

    outAsc.push({
      as_of_date: asOf,
      closing_value: close,
      prior_closing: prevClose,
      net_capital_flow: netFlow,
      stock_units_inflow: 0,
      nominal_pl: nominal,
      pct_month: null,
      ytd_nominal_pl: ytdRun,
      cumulative_nominal_pl: cumPl,
      unit,
    });
    prevClose = close;
  }

  if (isMovementBalanceCashCategory(categorySlug)) {
    return patchOrInsertLiveCurrentMonthPerfRows(accountId, categorySlug, outAsc, unit, () => {
      const live = checkingMovementBalanceLive(accountId);
      return live.value_clp;
    });
  }

  return outAsc;
}

function usdCashMonthlyPerfRows(
  accountId: number,
  categorySlug: string,
  unit: TsUnit
): AccountMonthlyPerformanceRow[] {
  const bounds = movementBoundsByAccountIds([accountId]).get(accountId);
  if (!bounds?.min_d || !bounds.max_d) return [];

  const today = chileCalendarTodayYmd();
  const maxD = bounds.max_d > today ? bounds.max_d : today;
  const monthEndsAsc = monthEndsBetweenInclusive(bounds.min_d, maxD);
  const asc = balanceOnlyMonthlyRowsAsc(accountId, categorySlug, unit, monthEndsAsc, (asOf) => {
    const clp = usdCashBalanceClpAt(accountId, asOf);
    return unit === "usd" ? convertTs(clp, asOf, "usd") : clp;
  });
  return [...asc].reverse();
}

function clpCashMonthlyPerfRows(
  accountId: number,
  categorySlug: string,
  unit: TsUnit
): AccountMonthlyPerformanceRow[] {
  const bounds = movementBoundsByAccountIds([accountId]).get(accountId);
  if (!bounds?.min_d || !bounds.max_d) return [];

  const today = chileCalendarTodayYmd();
  const maxD = bounds.max_d > today ? bounds.max_d : today;
  const monthEndsAsc = monthEndsBetweenInclusive(bounds.min_d, maxD);
  const asc = balanceOnlyMonthlyRowsAsc(accountId, categorySlug, unit, monthEndsAsc, (asOf) => {
    const clp = clpCashBalanceClpAt(accountId, asOf);
    return unit === "usd" ? convertTs(clp, asOf, "usd") : clp;
  });
  return [...asc].reverse();
}

function movementBalanceMonthlyPerfRows(
  accountId: number,
  categorySlug: string,
  unit: TsUnit
): AccountMonthlyPerformanceRow[] {
  const bounds = movementBoundsByAccountIds([accountId]).get(accountId);
  if (!bounds?.min_d || !bounds.max_d) return [];

  const today = chileCalendarTodayYmd();
  const maxD = bounds.max_d > today ? bounds.max_d : today;
  const monthEndsAsc = monthEndsBetweenInclusive(bounds.min_d, maxD);
  const asc = balanceOnlyMonthlyRowsAsc(accountId, categorySlug, unit, monthEndsAsc, (asOf) => {
    const clp = checkingMovementBalanceClpAtCached(accountId, asOf);
    return unit === "usd" ? convertTs(clp, asOf, "usd") : clp;
  });
  return [...asc].reverse();
}

function bookValuationMonthlyPerfRows(
  accountId: number,
  categorySlug: string,
  unit: TsUnit
): AccountMonthlyPerformanceRow[] {
  const bookAsc = loadBookValuationsAsc(accountId);
  if (!bookAsc.length) return [];

  const monthEndsAsc = bookAsc.map((r) => r.as_of_date);
  const clpByDate = new Map(bookAsc.map((r) => [r.as_of_date, r.value_clp]));
  const asc = balanceOnlyMonthlyRowsAsc(accountId, categorySlug, unit, monthEndsAsc, (asOf) => {
    const clp = clpByDate.get(asOf) ?? 0;
    return unit === "usd" ? convertTs(clp, asOf, "usd") : clp;
  });

  const patched = patchOrInsertLiveCurrentMonthPerfRows(accountId, categorySlug, asc, unit, () => {
    const liveMark = syncLatestDisplayValueClp(accountId, categorySlug, { notes: null, name: "" });
    const liveClp = liveMark?.value_clp ?? bookAsc[bookAsc.length - 1]!.value_clp;
    return liveClp;
  });

  return [...patched].reverse();
}

/** Per-account month-end rows for group consolidation (full cash bucket incl. cartola / ahorro). */
export function loadAccountRowsForGroupConsolidation(
  accountId: number,
  bucketSlug: string,
  unit: TsUnit = "clp"
): AccountMonthlyPerformanceRow[] {
  if (isMovementBalanceCashCategory(bucketSlug)) {
    return movementBalanceMonthlyPerfRows(accountId, bucketSlug, unit);
  }
  const kindSlug = accountBucketKindSlug(bucketSlug);
  if (isUsdCashKindSlug(kindSlug)) {
    return usdCashMonthlyPerfRows(accountId, bucketSlug, unit);
  }
  if (isClpCashKindSlug(kindSlug)) {
    return clpCashMonthlyPerfRows(accountId, bucketSlug, unit);
  }
  if (bucketSlug === "cuenta_ahorro_vivienda") {
    return bookValuationMonthlyPerfRows(accountId, bucketSlug, unit);
  }
  const perf = getAccountMonthlyPerformance(accountId, unit);
  return perf?.monthly ?? [];
}

/** One row per account per calendar month (same rules as account monthly perf collapse). */
function pickAccountMonthlyRowForConsolidation(
  monthRows: readonly AccountMonthlyPerformanceRow[],
  monthKey: string
): AccountMonthlyPerformanceRow {
  if (monthRows.length === 1) return monthRows[0]!;
  const picked = pickRepresentativeMonthlyPerfRow([...monthRows], monthKey);
  const totalFlow = monthRows.reduce((s, r) => s + r.net_capital_flow, 0);
  return { ...picked, net_capital_flow: totalFlow };
}

/**
 * Sum each account's monthly performance by calendar month (one representative row per account).
 * Canonical source for detalle por mes cierre and dashboard bucket lines.
 */
function monthEndCloseForConsolidation(
  acct: {
    account_id: number;
    bucket_slug: string;
    monthly: readonly AccountMonthlyPerformanceRow[];
    notes?: string | null;
    name?: string | null;
  },
  priorMk: string,
  unit: TsUnit
): number | null {
  const clp = monthEndCloseClpForAccount(
    acct.account_id,
    acct.bucket_slug,
    acct.monthly,
    priorMk,
    { notes: acct.notes, name: acct.name }
  );
  if (clp == null || !Number.isFinite(clp)) return null;
  if (unit === "clp") return clp;
  if (unit === "usd") {
    const usd = convertTs(clp, monthEndUtcYmd(priorMk), "usd");
    return Number.isFinite(usd) ? usd : null;
  }
  return clp;
}

export function consolidateGroupMonthlyPerf(
  byAccount: readonly {
    account_id: number;
    bucket_slug: string;
    monthly: readonly AccountMonthlyPerformanceRow[];
    notes?: string | null;
    name?: string | null;
  }[],
  unit: TsUnit = "clp"
): ConsolidatedMonthlyPerfRow[] {
  const today = chileCalendarTodayYmd();
  const currentMk = monthKeyFromYmd(today);

  const latestByAccountMonth = new Map<string, AccountMonthlyPerformanceRow>();
  for (const acct of byAccount) {
    const byMonth = new Map<string, AccountMonthlyPerformanceRow[]>();
    for (const row of acct.monthly) {
      const mk = monthKeyFromYmd(row.as_of_date);
      const arr = byMonth.get(mk) ?? [];
      arr.push(row);
      byMonth.set(mk, arr);
    }
    for (const [mk, monthRows] of byMonth) {
      latestByAccountMonth.set(
        `${acct.account_id}:${mk}`,
        pickAccountMonthlyRowForConsolidation(monthRows, mk)
      );
    }
  }

  const monthBuckets = new Map<string, ConsolidatedMonthlyPerfRow>();
  for (const row of latestByAccountMonth.values()) {
    const mk = monthKeyFromYmd(row.as_of_date);
    const bucket =
      monthBuckets.get(mk) ??
      ({
        as_of_date: mk === currentMk ? today : row.as_of_date,
        closing_value: 0,
        prior_closing: null as number | null,
        net_capital_flow: 0,
        stock_units_inflow: 0,
        nominal_pl: null as number | null,
        pct_month: null,
        ytd_nominal_pl: null,
        cumulative_nominal_pl: null,
      } satisfies ConsolidatedMonthlyPerfRow);

    if (mk !== currentMk) {
      bucket.as_of_date =
        bucket.as_of_date >= row.as_of_date ? bucket.as_of_date : row.as_of_date;
    }
    bucket.closing_value += row.closing_value;
    bucket.net_capital_flow += row.net_capital_flow;
    bucket.stock_units_inflow += row.stock_units_inflow;
    if (row.nominal_pl != null && Number.isFinite(row.nominal_pl)) {
      bucket.nominal_pl = (bucket.nominal_pl ?? 0) + row.nominal_pl;
    }
    monthBuckets.set(mk, bucket);
  }

  for (const [mk, bucket] of monthBuckets) {
    const priorMk = priorCalendarMonthKey(mk);
    let sumPrior = 0;
    let anyPrior = false;
    for (const acct of byAccount) {
      let priorClose = monthEndCloseForConsolidation(acct, priorMk, unit);
      if (priorClose == null) {
        priorClose = monthEndCloseFromPerfRows(acct.monthly, priorMk);
      }
      if (priorClose == null) {
        const row = latestByAccountMonth.get(`${acct.account_id}:${mk}`);
        priorClose = row?.prior_closing ?? null;
      }
      if (priorClose != null && Number.isFinite(priorClose)) {
        sumPrior += priorClose;
        anyPrior = true;
      }
    }
    bucket.prior_closing = anyPrior ? sumPrior : null;
  }

  const asc = [...monthBuckets.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, bucket]) => {
      const prior = bucket.prior_closing;
      const net = bucket.net_capital_flow;
      /** Same definition as {@link getGroupMonthlyPerformanceSeries} `delta_total` (Σ per-account picked nominal_pl). */
      const nominal = bucket.nominal_pl;
      const denom = (prior ?? 0) + net;
      const pct =
        nominal != null &&
        Number.isFinite(nominal) &&
        Math.abs(denom) > MONTH_ROW_EPS &&
        Number.isFinite(nominal / denom)
          ? nominal / denom
          : null;
      return { ...bucket, nominal_pl: nominal, pct_month: pct };
    });

  return recomputeYtdAndCumulative(asc).reverse();
}

export function consolidatedClosingRawByDate(
  rows: readonly ConsolidatedMonthlyPerfRow[]
): Map<string, number> {
  const out = new Map<string, number>();
  for (const row of rows) {
    if (Number.isFinite(row.closing_value)) {
      out.set(row.as_of_date, row.closing_value);
    }
  }
  return out;
}

function buildConsolidationPayloads(
  rows: readonly GroupTabAccountRow[],
  groupSlug: string,
  unit: TsUnit
): {
  account_id: number;
  name: string;
  bucket_slug: string;
  notes: string | null;
  monthly: AccountMonthlyPerformanceRow[];
}[] {
  const account_monthly: {
    account_id: number;
    name: string;
    bucket_slug: string;
    notes: string | null;
    monthly: AccountMonthlyPerformanceRow[];
  }[] = [];

  for (const r of rows) {
    if (r.exclude_from_group_totals === 1) continue;
    const seriesId = seriesAccountIdForGroupTab(r, groupSlug);
    if (!accountCountsTowardGroupTotals(seriesId)) continue;
    const monthly = loadAccountRowsForGroupConsolidation(seriesId, r.bucket_slug, unit);
    if (!monthly.length) continue;
    account_monthly.push({
      account_id: seriesId,
      name: r.name,
      bucket_slug: r.bucket_slug,
      notes: r.notes ?? null,
      monthly,
    });
  }
  return account_monthly;
}

/** Consolidated detalle por mes rows for accounts in a group tab. */
export function getGroupConsolidatedMonthlyPerfForRows(
  rows: readonly GroupTabAccountRow[],
  groupSlug: string,
  unit: TsUnit = "clp"
): ConsolidatedMonthlyPerfRow[] {
  return withAccountValuationTsCache(() =>
    getGroupConsolidatedMonthlyPerfForRowsInner(rows, groupSlug, unit)
  );
}

function getGroupConsolidatedMonthlyPerfForRowsInner(
  rows: readonly GroupTabAccountRow[],
  groupSlug: string,
  unit: TsUnit = "clp"
): ConsolidatedMonthlyPerfRow[] {
  // Consolidation result depends on the exact `rows` set (accounts + their bucket slugs).
  // Cache key must include a stable fingerprint of inputs to avoid cross-tab collisions
  // (e.g. brokerage_mutual_funds vs brokerage_acciones).
  const rowsKey = rows.map((r) => `${r.account_id}:${r.bucket_slug}`).join("|");
  const key = `group.consolidated_monthly|${groupSlug}|${unit}|${rowsKey}`;
  return getAggregationCached(key, () => buildGroupConsolidatedMonthlyPerfUncached(rows, groupSlug, unit));
}

function buildGroupConsolidatedMonthlyPerfUncached(
  rows: readonly GroupTabAccountRow[],
  groupSlug: string,
  unit: TsUnit
): ConsolidatedMonthlyPerfRow[] {
  const payloads = buildConsolidationPayloads(rows, groupSlug, unit);
  const consolidated = consolidateGroupMonthlyPerf(
    payloads.map((p) => ({
      account_id: p.account_id,
      bucket_slug: p.bucket_slug,
      monthly: p.monthly,
      notes: p.notes,
      name: p.name,
    })),
    unit
  );
  if (isCashEqsNwValuationGroupSlug(groupSlug)) {
    return netLinkedCreditCardFromCashConsolidated(consolidated, unit);
  }
  return consolidated;
}

export function getGroupConsolidationAccountMonthly(
  rows: readonly GroupTabAccountRow[],
  groupSlug: string,
  unit: TsUnit = "clp"
): ReturnType<typeof buildConsolidationPayloads> {
  return buildConsolidationPayloads(rows, groupSlug, unit);
}

type GroupTabValuationBlock = {
  accounts: { account_id: number; dataKey: string; exclude_from_group_totals?: boolean }[];
  points: Record<string, string | number | null>[];
  lines?: { dataKey: string }[];
};

/** Replace `__group_val_total` with consolidated month cierre (same as detalle / overview). */
export function applyConsolidatedTotalToGroupTabBlock(
  block: GroupTabValuationBlock,
  consolidated: readonly ConsolidatedMonthlyPerfRow[]
): GroupTabValuationBlock {
  if (!block.points.length || !consolidated.length) return block;

  const raw = consolidatedClosingRawByDate(consolidated);
  const datesAsc = block.points.map((p) => String(p.as_of_date));
  const byChartDate = mapMonthlyClosingToChartDates(raw, datesAsc);

  const points = block.points.map((row) => {
    const d = String(row.as_of_date);
    const total = byChartDate.get(d);
    return {
      ...row,
      [GROUP_TAB_VAL_TOTAL]:
        total != null && Number.isFinite(total) ? total : row[GROUP_TAB_VAL_TOTAL] ?? null,
    };
  });

  return { ...block, points };
}
