import {
  getAccountMonthlyPerformance,
  mapMonthlyClosingToChartDates,
  type AccountMonthlyPerformanceRow,
} from "./accountPerformance.js";
import { accountCountsTowardGroupTotals } from "./accountGroupTotals.js";
import { loadBookValuationsAsc } from "./bookValuations.js";
import {
  checkingMovementBalanceClpAtCached,
  checkingMovementBalanceLive,
} from "./checkingCartolaBalances.js";
import { monthEndsBetweenInclusive, monthKeyFromYmd } from "./calendarMonth.js";
import { chileCalendarTodayYmd } from "./chileDate.js";
import { db } from "./db.js";
import { fxMonthEndForBalanceUsd, ufRowOnOrBefore } from "./fxRates.js";
import { isMovementBalanceCashCategory } from "./movementBalanceCashAccounts.js";
import { syncLatestDisplayValueClp } from "./syncLatestDisplayValueClp.js";
import { netLinkedCreditCardFromCashConsolidated } from "./cashEqsBucketNet.js";
import { seriesAccountIdForGroupTab } from "./groupTabAccounts.js";

export type TsUnit = "clp" | "usd" | "uf";

export type GroupTabAccountRow = {
  account_id: number;
  name: string;
  bucket_slug: string;
  exclude_from_group_totals: number;
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

function addNullable(a: number | null, b: number | null): number | null {
  if (a == null && b == null) return null;
  return (a ?? 0) + (b ?? 0);
}

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
    const today = chileCalendarTodayYmd();
    const curMk = monthKeyFromYmd(today);
    const curIdx = outAsc.findIndex((r) => monthKeyFromYmd(r.as_of_date) === curMk);
    if (curIdx >= 0) {
      const row = outAsc[curIdx]!;
      const prior = row.prior_closing;
      if (prior != null && Number.isFinite(prior)) {
        const live = checkingMovementBalanceLive(accountId);
        let liveVal = live.value_clp;
        if (unit === "usd") {
          const usd = convertTs(liveVal, today, "usd");
          liveVal = Number.isFinite(usd) ? usd : liveVal;
        }
        const net = row.net_capital_flow;
        const nominal = liveVal - prior - net;
        outAsc[curIdx] = {
          ...row,
          as_of_date: today,
          closing_value: liveVal,
          nominal_pl: nominal,
        };
      }
    }
  }

  return outAsc;
}

function movementBalanceMonthlyPerfRows(
  accountId: number,
  categorySlug: string,
  unit: TsUnit
): AccountMonthlyPerformanceRow[] {
  const bounds = db
    .prepare(
      `SELECT MIN(occurred_on) AS min_d, MAX(occurred_on) AS max_d
       FROM movements WHERE account_id = ?`
    )
    .get(accountId) as { min_d: string | null; max_d: string | null } | undefined;
  if (!bounds?.min_d || !bounds.max_d) return [];

  const today = chileCalendarTodayYmd();
  const maxD = bounds.max_d > today ? bounds.max_d : today;
  const monthEndsAsc = monthEndsBetweenInclusive(bounds.min_d, maxD);
  const asc = balanceOnlyMonthlyRowsAsc(accountId, categorySlug, unit, monthEndsAsc, (asOf) => {
    const clp = checkingMovementBalanceClpAtCached(accountId, asOf);
    const v = unit === "usd" ? convertTs(clp, asOf, "usd") : clp;
    return Number.isFinite(v) ? v : clp;
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
    const v = unit === "usd" ? convertTs(clp, asOf, "usd") : clp;
    return Number.isFinite(v) ? v : clp;
  });

  const today = chileCalendarTodayYmd();
  const curMk = monthKeyFromYmd(today);
  const curIdx = asc.findIndex((r) => monthKeyFromYmd(r.as_of_date) === curMk);
  if (curIdx >= 0) {
    const liveMark = syncLatestDisplayValueClp(accountId, categorySlug, { notes: null, name: "" });
    let liveClp = liveMark?.value_clp ?? bookAsc[bookAsc.length - 1]!.value_clp;
    let live = unit === "usd" ? convertTs(liveClp, today, "usd") : liveClp;
    if (!Number.isFinite(live)) live = liveClp;
    const row = asc[curIdx]!;
    const prior = row.prior_closing;
    const net = row.net_capital_flow;
    const nominal =
      prior != null && Number.isFinite(prior) ? live - prior - net : row.nominal_pl;
    asc[curIdx] = {
      ...row,
      as_of_date: today,
      closing_value: live,
      nominal_pl: nominal,
    };
  }

  return [...asc].reverse();
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
  if (bucketSlug === "cuenta_ahorro_vivienda") {
    return bookValuationMonthlyPerfRows(accountId, bucketSlug, unit);
  }
  const perf = getAccountMonthlyPerformance(accountId, unit);
  return perf?.monthly ?? [];
}

/**
 * Sum each account's monthly performance by calendar month (latest snapshot in the month per account).
 * Canonical source for detalle por mes cierre and dashboard bucket lines.
 */
export function consolidateGroupMonthlyPerf(
  byAccount: readonly {
    account_id: number;
    monthly: readonly AccountMonthlyPerformanceRow[];
  }[]
): ConsolidatedMonthlyPerfRow[] {
  const latestByAccountMonth = new Map<string, AccountMonthlyPerformanceRow>();
  for (const acct of byAccount) {
    for (const row of acct.monthly) {
      const mk = monthKeyFromYmd(row.as_of_date);
      const key = `${acct.account_id}:${mk}`;
      const prev = latestByAccountMonth.get(key);
      if (!prev || row.as_of_date > prev.as_of_date) {
        latestByAccountMonth.set(key, row);
      }
    }
  }

  const monthBuckets = new Map<string, ConsolidatedMonthlyPerfRow>();
  for (const row of latestByAccountMonth.values()) {
    const mk = monthKeyFromYmd(row.as_of_date);
    const bucket =
      monthBuckets.get(mk) ??
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

    bucket.as_of_date =
      bucket.as_of_date >= row.as_of_date ? bucket.as_of_date : row.as_of_date;
    bucket.closing_value += row.closing_value;
    bucket.prior_closing = addNullable(bucket.prior_closing, row.prior_closing);
    bucket.net_capital_flow += row.net_capital_flow;
    bucket.stock_units_inflow += row.stock_units_inflow;
    bucket.nominal_pl = addNullable(bucket.nominal_pl, row.nominal_pl);
    monthBuckets.set(mk, bucket);
  }

  const asc = [...monthBuckets.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, bucket]) => {
      const prior = bucket.prior_closing;
      const net = bucket.net_capital_flow;
      const nominal = bucket.nominal_pl;
      const denom = (prior ?? 0) + net;
      const pct =
        nominal != null &&
        Number.isFinite(nominal) &&
        Math.abs(denom) > MONTH_ROW_EPS &&
        Number.isFinite(nominal / denom)
          ? nominal / denom
          : null;
      return { ...bucket, pct_month: pct };
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
  rows: GroupTabAccountRow[],
  groupSlug: string,
  unit: TsUnit
): { account_id: number; name: string; category_slug: string; monthly: AccountMonthlyPerformanceRow[] }[] {
  const   account_monthly: {
    account_id: number;
    name: string;
    bucket_slug: string;
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
  const payloads = buildConsolidationPayloads(rows, groupSlug, unit);
  const consolidated = consolidateGroupMonthlyPerf(
    payloads.map((p) => ({ account_id: p.account_id, monthly: p.monthly }))
  );
  if (groupSlug === "cash_eqs") {
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
