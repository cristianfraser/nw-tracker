import { cacheKeyAccountMonthlyPerf, getAggregationCached } from "./aggregationCache.js";
import { getAccountValuationTimeseriesForPerf } from "./accountPerformanceContext.js";
import { loadDeptoLedgerFromMovements } from "./deptoLedgerFromMovements.js";
import {
  getAccountValuationTimeseries,
  listAccountsForGroupTab,
  convertTs,
  seriesAccountIdForGroupTab,
} from "./valuationTimeseries.js";
import type { TsUnit } from "./valuationTimeseries.js";
import { MONTH_ROW_EPS, pickRepresentativeMonthlyPerfRow } from "./accountPerformanceMonthPick.js";
import { chileCalendarTodayYmd } from "./chileDate.js";
import { netDepositFlowCurrentMonthThroughToday } from "./flowsDeposits.js";
import { monthEndUtcYmd, monthKeyFromYmd } from "./calendarMonth.js";
import {
  deptoCreditoRestanteUfBySnapshotDates,
  deptoMortgageCloseClpBySnapshotDates,
  deptoPropertyClpPaymentsThroughDate,
  deptoSueciaPropertyCloseClpBySnapshotDates,
  mortgageSheetPaymentsClpThroughDate,
  type DeptoMortgageSheetRow,
} from "./deptoDividendosLedger.js";
import {
  ccInstallmentLedgerRowCount,
  creditCardInstallmentPaymentsByBillingMonth,
} from "./ccInstallmentLedgerDb.js";
import { addCalendarMonths } from "./ccYearMonth.js";
import { isMovementBalanceCashCategory } from "./movementBalanceCashAccounts.js";
import { db } from "./db.js";
import { loadBookValuationsAsc } from "./bookValuations.js";
export { loadBookValuationsAsc } from "./bookValuations.js";
import {
  colorRgbForSyntheticAccountLine,
  colorRgbForTimeseriesAccountLine,
} from "./chartColorRgb.js";
import { ufClpBySnapshotDatesAsc } from "./fxRates.js";
import { accountUsesEquityMtm, computeEquityMtmClp } from "./brokerageEquityMtm.js";
import { accountMarkClpAtYmd } from "./accountMarkClpAtYmd.js";
import { syncLatestDisplayValueClp } from "./syncLatestDisplayValueClp.js";
import {
  accountUsesCryptoMtm,
  computeCryptoMtmClp,
  cryptoAssetFromCategorySlug,
  cryptoCoinCumulativeThroughDate,
} from "./cryptoValuation.js";
import { accountBucketKindSlug } from "./accountBucket.js";
import {
  monthEndCloseClpForAccount,
  priorCalendarMonthKey,
  priorCalendarMonthKeyFromToday,
  type MonthEndCloseForAccountOpts,
} from "./accountPeriodMarks.js";
export type AccountMonthlyPerformanceRow = {
  as_of_date: string;
  /** Closing value at month-end (same unit as request: CLP or USD). */
  closing_value: number;
  prior_closing: number | null;
  /** Net capital flow in the month (Δ cumulative aportes vs prior month-end). */
  net_capital_flow: number;
  /** Sum of positive `movements.units_delta` in the calendar month (brokerage buys + DRIP, or AFP certificate cuotas). */
  stock_units_inflow: number;
  /** Coin units held at month-end snapshot (bitcoin / eth only). */
  coin_units_eom?: number | null;
  /**
   * Gain/loss beyond explained flows. Investments: `closing − prior − net_capital_flow`.
   * Mortgage: financing cost in the month = payments − CLP principal reduction (`net_capital_flow + Δ closing`).
   */
  nominal_pl: number | null;
  /** Investments: vs `prior + net_flow`. Mortgage: vs opening balance (`prior_closing`). */
  pct_month: number | null;
  /** Sum of nominal_pl from January of this row’s calendar year through this month (same unit). */
  ytd_nominal_pl: number | null;
  /** Running sum of nominal_pl from first month with a row through this month. */
  cumulative_nominal_pl: number | null;
  /** Mortgage: remaining principal in UF from `depto-dividendos.csv` (crédito restante), aligned to month-end. */
  closing_balance_uf?: number | null;
  /** Mortgage: UF value in CLP from `uf_daily` on or before month-end (not from the dividendos sheet). */
  uf_clp_day?: number | null;
  unit: TsUnit;
};

function numCell(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  return null;
}

/** Depto sheet payments are CLP; convert to the performance series unit. */
function perfSheetClpFlowInUnit(clpFlow: number, asOf: string, unit: TsUnit): number {
  if (unit === "clp") return clpFlow;
  const converted = convertTs(clpFlow, asOf, unit);
  if (!Number.isFinite(converted)) {
    throw new Error(
      `perfSheetClpFlowInUnit: missing FX for ${asOf} (${clpFlow} CLP → ${unit})`
    );
  }
  return converted;
}

function perfDeptoPropertyPaymentsInUnit(
  ledger: readonly DeptoMortgageSheetRow[],
  asOf: string,
  afterExclusive: string | null,
  unit: TsUnit
): number {
  return perfSheetClpFlowInUnit(
    deptoPropertyClpPaymentsThroughDate(ledger, asOf, afterExclusive),
    asOf,
    unit
  );
}

function perfMortgagePaymentsInUnit(
  ledger: readonly DeptoMortgageSheetRow[],
  asOf: string,
  afterExclusive: string | null,
  unit: TsUnit
): number {
  return perfSheetClpFlowInUnit(
    mortgageSheetPaymentsClpThroughDate(ledger, asOf, afterExclusive),
    asOf,
    unit
  );
}

export type ReanchorMonthlyPerfOpts = {
  accountId: number;
  bucketSlug: string;
  unit: TsUnit;
  import_key?: string | null;
  name?: string | null;
};

function monthEndCloseForAccountInUnit(
  accountId: number,
  bucketSlug: string,
  monthlyRows: readonly AccountMonthlyPerformanceRow[],
  monthKey: string,
  unit: TsUnit,
  opts?: MonthEndCloseForAccountOpts
): number | null {
  const clp = monthEndCloseClpForAccount(accountId, bucketSlug, monthlyRows, monthKey, opts);
  if (clp == null || !Number.isFinite(clp)) return null;
  if (unit === "clp") return clp;
  if (unit === "usd") {
    const usd = convertTs(clp, monthEndUtcYmd(monthKey), "usd");
    return Number.isFinite(usd) ? usd : null;
  }
  return clp;
}

/**
 * Recompute `prior_closing` and `nominal_pl` from calendar month-end anchors (same as dashboard MTD / consolidated tables),
 * not from sequential valuation snapshot chaining.
 */
export function reanchorMonthlyPerfToCalendarMonthEnds(
  pickedAsc: AccountMonthlyPerformanceRow[],
  opts: ReanchorMonthlyPerfOpts
): AccountMonthlyPerformanceRow[] {
  if (!pickedAsc.length) return pickedAsc;
  const kind = accountBucketKindSlug(opts.bucketSlug);
  const isMortgage = kind === "mortgage";
  const isDeptoProperty = kind === "property";
  const isCreditCard = kind === "credit_card";
  const deptoLedger =
    isMortgage || isDeptoProperty ? loadDeptoLedgerFromMovements() : [];

  const out: AccountMonthlyPerformanceRow[] = [];
  for (const row of pickedAsc) {
    const mk = monthKeyFromYmd(row.as_of_date);
    const priorMk = priorCalendarMonthKey(mk);
    const prior =
      out.length > 0
        ? monthEndCloseForAccountInUnit(
            opts.accountId,
            opts.bucketSlug,
            out,
            priorMk,
            opts.unit,
            { import_key: opts.import_key, name: opts.name }
          )
        : null;
    const closeFromMark = monthEndCloseForAccountInUnit(
      opts.accountId,
      opts.bucketSlug,
      out,
      mk,
      opts.unit,
      { import_key: opts.import_key, name: opts.name }
    );
    const close = closeFromMark ?? row.closing_value;
    let netFlow = row.net_capital_flow;
    if (isDeptoProperty && deptoLedger.length > 0) {
      netFlow = perfDeptoPropertyPaymentsInUnit(deptoLedger, monthEndUtcYmd(mk), null, opts.unit);
    } else if (isMortgage && deptoLedger.length > 0) {
      netFlow = perfMortgagePaymentsInUnit(deptoLedger, monthEndUtcYmd(mk), null, opts.unit);
    }

    let prior_closing: number | null;
    let nominal_pl: number | null;
    let pct_month: number | null;

    if (prior == null || !Number.isFinite(prior)) {
      prior_closing = null;
      nominal_pl = isMortgage ? 0 : isCreditCard ? creditCardNominalPlStub() : close - netFlow;
      pct_month =
        isCreditCard
          ? null
          : !isMortgage && Math.abs(netFlow) > MONTH_ROW_EPS && Number.isFinite((close - netFlow) / netFlow)
            ? (close - netFlow) / netFlow
            : null;
    } else {
      prior_closing = prior;
      nominal_pl = isMortgage
        ? mortgageFinancingCostClp(prior, close, netFlow)
        : isCreditCard
          ? creditCardNominalPlStub()
          : close - prior - netFlow;
      pct_month = isMortgage
        ? mortgagePctMonth(nominal_pl, prior)
        : isCreditCard
          ? null
          : (() => {
            const denom = prior + netFlow;
            return nominal_pl != null &&
              Math.abs(denom) > MONTH_ROW_EPS &&
              Number.isFinite(nominal_pl / denom)
              ? nominal_pl / denom
              : null;
          })();
    }

    out.push({
      ...row,
      closing_value: close,
      prior_closing,
      net_capital_flow: netFlow,
      nominal_pl,
      pct_month,
    });
  }

  return recomputeYtdAndCumulativeOnMonthlyRows(out);
}

function collapseMonthlyPerfDuplicateCalendarMonths(
  outAsc: AccountMonthlyPerformanceRow[],
  opts: ReanchorMonthlyPerfOpts
): AccountMonthlyPerformanceRow[] {
  if (outAsc.length === 0) return outAsc;
  const byMonth = new Map<string, AccountMonthlyPerformanceRow[]>();
  for (const r of outAsc) {
    const mk = monthKeyFromYmd(r.as_of_date);
    const arr = byMonth.get(mk) ?? [];
    arr.push(r);
    byMonth.set(mk, arr);
  }
  const monthsAsc = [...byMonth.keys()].sort((a, b) => a.localeCompare(b));
  const picked = monthsAsc.map((mk) => {
    const monthRows = byMonth.get(mk)!;
    const row = pickRepresentativeMonthlyPerfRow(monthRows, mk);
    /** Sum flows across every snapshot in the month (mid-month + month-end book row). */
    const totalFlow = monthRows.reduce((s, r) => s + r.net_capital_flow, 0);
    return { ...row, net_capital_flow: totalFlow };
  });
  return reanchorMonthlyPerfToCalendarMonthEnds(picked, opts);
}

function accountMetaForLivePerfClose(
  accountId: number
): { bucket_slug: string; import_key: string | null; name: string } | null {
  const row = db
    .prepare(
      `SELECT a.name, a.import_key, g.slug AS bucket_slug
       FROM accounts a
       INNER JOIN asset_groups g ON g.id = a.asset_group_id
       WHERE a.id = ?`
    )
    .get(accountId) as { name: string; import_key: string | null; bucket_slug: string } | undefined;
  return row ?? null;
}

function livePerfCloseClpForCurrentMonth(accountId: number, categorySlug: string): number | null {
  const meta = accountMetaForLivePerfClose(accountId);
  const slug = categorySlug || meta?.bucket_slug || "";
  const markOpts = { import_key: meta?.import_key ?? null, name: meta?.name ?? null };
  const deptoKind = accountBucketKindSlug(slug);
  if (deptoKind === "property" || deptoKind === "mortgage") {
    const today = chileCalendarTodayYmd();
    const mark = accountMarkClpAtYmd(accountId, today, slug, markOpts);
    if (mark?.value_clp != null && Number.isFinite(mark.value_clp)) return mark.value_clp;
  }
  const live = syncLatestDisplayValueClp(accountId, slug, markOpts);
  if (live?.value_clp != null && Number.isFinite(live.value_clp)) return live.value_clp;
  return null;
}

/**
 * Prefer live marks for the in-progress calendar month so P/L reconciles with dashboard balance Δ.
 * Updates an existing current-month row or inserts one at month rollover when only prior months exist.
 */
export function patchOrInsertLiveCurrentMonthPerfRows(
  accountId: number,
  categorySlug: string,
  sortedAsc: AccountMonthlyPerformanceRow[],
  unit: TsUnit,
  resolveLiveClp?: () => number | null
): AccountMonthlyPerformanceRow[] {
  if (!sortedAsc.length) return sortedAsc;

  const today = chileCalendarTodayYmd();
  const curMk = monthKeyFromYmd(today);
  const priorMk = priorCalendarMonthKeyFromToday(today);
  const meta = accountMetaForLivePerfClose(accountId);
  const bucketKind = accountBucketKindSlug(categorySlug || meta?.bucket_slug || "");
  if (bucketKind === "credit_card") return sortedAsc;
  const markOpts: MonthEndCloseForAccountOpts = {
    import_key: meta?.import_key ?? null,
    name: meta?.name ?? null,
  };
  const priorClose = monthEndCloseForAccountInUnit(
    accountId,
    categorySlug || meta?.bucket_slug || "",
    sortedAsc,
    priorMk,
    unit,
    markOpts
  );
  if (priorClose == null || !Number.isFinite(priorClose)) return sortedAsc;

  const idx = sortedAsc.findIndex((r) => monthKeyFromYmd(r.as_of_date) === curMk);
  const row = idx >= 0 ? sortedAsc[idx]! : null;

  let live: number | null = resolveLiveClp?.() ?? livePerfCloseClpForCurrentMonth(accountId, categorySlug);
  if (live != null && unit === "usd") {
    const usd = convertTs(live, today, "usd");
    live = Number.isFinite(usd) ? usd : null;
  }
  if (live == null || !Number.isFinite(live)) {
    if (row?.closing_value != null && Number.isFinite(row.closing_value)) live = row.closing_value;
    else return sortedAsc;
  }

  const netFlow = (() => {
    if (bucketKind === "property") {
      const ledger = loadDeptoLedgerFromMovements();
      if (ledger.length > 0) {
        return perfDeptoPropertyPaymentsInUnit(ledger, today, null, unit);
      }
    }
    if (bucketKind === "mortgage") return row?.net_capital_flow ?? 0;
    // Live close is as-of-today, so the flow must be too: the base row sums the whole
    // calendar month and a future-dated movement would read as phantom negative P/L.
    return netDepositFlowCurrentMonthThroughToday(accountId, unit === "usd" ? "usd" : "clp");
  })();
  const nominal = live - priorClose - netFlow;
  const denom = priorClose + netFlow;
  const pct =
    Math.abs(denom) > 1e-6 && Number.isFinite(nominal / denom) ? nominal / denom : null;

  const mortgageUfFields =
    bucketKind === "mortgage"
      ? (() => {
          const ledger = loadDeptoLedgerFromMovements();
          if (!ledger.length) return {};
          const ufMap = ufClpBySnapshotDatesAsc([today]);
          const ufByDate = deptoCreditoRestanteUfBySnapshotDates([today], ledger);
          return {
            uf_clp_day: ufMap.get(today) ?? null,
            closing_balance_uf: ufByDate.get(today) ?? null,
          };
        })()
      : {};

  if (idx >= 0) {
    const out = [...sortedAsc];
    out[idx] = {
      ...row!,
      as_of_date: today,
      prior_closing: priorClose,
      closing_value: live,
      net_capital_flow: netFlow,
      nominal_pl: nominal,
      pct_month: pct,
      ...mortgageUfFields,
    };
    return recomputeYtdAndCumulativeOnMonthlyRows(out);
  }

  const inserted: AccountMonthlyPerformanceRow = {
    as_of_date: today,
    closing_value: live,
    prior_closing: priorClose,
    net_capital_flow: netFlow,
    stock_units_inflow: 0,
    nominal_pl: nominal,
    pct_month: pct,
    ytd_nominal_pl: null,
    cumulative_nominal_pl: null,
    ...mortgageUfFields,
    unit,
  };
  const out = [...sortedAsc, inserted].sort((a, b) =>
    String(a.as_of_date).localeCompare(String(b.as_of_date))
  );
  return recomputeYtdAndCumulativeOnMonthlyRows(out);
}

function applyLiveCloseToCurrentMonthPerfRows(
  accountId: number,
  categorySlug: string,
  sortedAsc: AccountMonthlyPerformanceRow[],
  unit: TsUnit
): AccountMonthlyPerformanceRow[] {
  return patchOrInsertLiveCurrentMonthPerfRows(accountId, categorySlug, sortedAsc, unit);
}

function recomputeYtdAndCumulativeOnMonthlyRows(
  sortedAsc: AccountMonthlyPerformanceRow[]
): AccountMonthlyPerformanceRow[] {
  let ytdYear = 0;
  let ytdRun = 0;
  let cumPl = 0;
  const out: AccountMonthlyPerformanceRow[] = [];
  for (const row of sortedAsc) {
    const y = Number(String(row.as_of_date).slice(0, 4));
    const nIn = row.nominal_pl != null && Number.isFinite(row.nominal_pl) ? row.nominal_pl : 0;
    if (Number.isFinite(y) && y !== ytdYear) {
      ytdYear = y;
      ytdRun = 0;
    }
    ytdRun += nIn;
    cumPl += nIn;
    out.push({
      ...row,
      ytd_nominal_pl: ytdRun,
      cumulative_nominal_pl: cumPl,
    });
  }
  return out;
}

function lastStoredBookClpOnOrBefore(
  asOf: string,
  sortedAsc: { as_of_date: string; value_clp: number }[]
): number | null {
  let last: number | null = null;
  for (const r of sortedAsc) {
    if (r.as_of_date > asOf) break;
    last = r.value_clp;
  }
  return last;
}

/**
 * Month-end close for monthly P/L must match the **account valuation chart** (`buildPointsForAccounts`):
 * that series is `p[accountId]` (MTM where applicable, then forward-fill). Using a different source
 * (e.g. exact `valuations` before live crypto MTM) desyncs the bar chart from the line and can pin May to $0.
 *
 * When the chart cell is null (edge of series), mirror {@link valuationTimeseries.valuationRawClpForAccount}
 * in CLP, then {@link convertTs}.
 */
function monthEndCloseForPerformance(
  accountId: number,
  asOf: string,
  pointRow: Record<string, string | number | null>,
  dataKey: string,
  bookAsc: { as_of_date: string; value_clp: number }[],
  exactClpByDate: Map<string, number>,
  unit: TsUnit
): number | null {
  const chart = numCell(pointRow[dataKey]);
  if (chart != null) return chart;

  let rawClp: number | null = null;
  if (accountUsesEquityMtm(accountId)) {
    rawClp = computeEquityMtmClp(accountId, asOf);
    if (rawClp == null) {
      const ex = exactClpByDate.get(asOf);
      rawClp =
        ex != null && Number.isFinite(ex) ? ex : lastStoredBookClpOnOrBefore(asOf, bookAsc);
    }
  } else if (accountUsesCryptoMtm(accountId)) {
    const mtm = computeCryptoMtmClp(accountId, asOf);
    if (mtm != null) rawClp = mtm;
    else {
      const ex = exactClpByDate.get(asOf);
      rawClp =
        ex != null && Number.isFinite(ex) ? ex : lastStoredBookClpOnOrBefore(asOf, bookAsc);
    }
  } else {
    const ex = exactClpByDate.get(asOf);
    rawClp =
      ex != null && Number.isFinite(ex) ? ex : lastStoredBookClpOnOrBefore(asOf, bookAsc);
  }
  if (rawClp == null) return null;
  const converted = convertTs(rawClp, asOf, unit);
  return Number.isFinite(converted) ? converted : null;
}

/**
 * Phase-1 stub until installment-interest P/L (`creditCardPerformancePl.ts`).
 * Credit-card balance change is not investment return.
 */
export function creditCardNominalPlStub(): number {
  return 0;
}

/**
 * Mortgage month cost: payments minus CLP amortization on the balance.
 * Positive = you paid more than the debt fell (UF revaluation + interest/fees).
 */
function mortgageFinancingCostClp(
  priorClosing: number,
  closing: number,
  netCapitalFlow: number
): number {
  return netCapitalFlow - (priorClosing - closing);
}

function mortgagePctMonth(nominal: number, priorClosing: number): number | null {
  return Math.abs(priorClosing) > 1e-6 && Number.isFinite(nominal / priorClosing)
    ? nominal / priorClosing
    : null;
}


function monthEndCloseForMortgagePerformance(
  accountId: number,
  asOf: string,
  pointRow: Record<string, string | number | null>,
  dataKey: string,
  bookAsc: { as_of_date: string; value_clp: number }[],
  exactClpByDate: Map<string, number>,
  unit: TsUnit,
  closeClpByDate: Map<string, number> | null
): number | null {
  const fromSheet = closeClpByDate?.get(asOf);
  if (fromSheet != null && Number.isFinite(fromSheet)) {
    const converted = convertTs(fromSheet, asOf, unit);
    return Number.isFinite(converted) ? converted : null;
  }
  return monthEndCloseForPerformance(
    accountId,
    asOf,
    pointRow,
    dataKey,
    bookAsc,
    exactClpByDate,
    unit
  );
}

/** Month-end `YYYY-MM-DD` → Σ positive units_delta on equity brokerage movements in that calendar month. */
function stockUnitsInflowByMonthEnd(accountId: number): Map<string, number> {
  const shareKinds = ["compra_usd", "stock_buy", "stock_sell", "dividend_usd"];
  const ph = shareKinds.map(() => "?").join(", ");
  const rows = db
    .prepare(
      `SELECT occurred_on, from_account_id, to_account_id, account_id, COALESCE(units_delta, 0) AS ud
       FROM movements
       WHERE (account_id = ? OR to_account_id = ?)
         AND flow_kind IN (${ph})
         AND COALESCE(units_delta, 0) > 0`
    )
    .all(accountId, accountId, ...shareKinds) as {
    occurred_on: string;
    from_account_id: number | null;
    to_account_id: number | null;
    account_id: number | null;
    ud: number;
  }[];
  const m = new Map<string, number>();
  for (const r of rows) {
    const units =
      r.to_account_id === accountId
        ? r.ud
        : r.account_id === accountId
          ? r.ud
          : 0;
    if (units <= 0) continue;
    const me = monthEndUtcYmd(monthKeyFromYmd(r.occurred_on));
    m.set(me, (m.get(me) ?? 0) + units);
  }
  return m;
}

/** `YYYY-MM` → Σ positive `units_delta` on AFP import rows in that calendar month (matches chart rows keyed by snapshot month). */
/** Month-end `YYYY-MM-DD` → Σ positive `units_delta` on crypto account in that calendar month. */
function cryptoCoinInflowByMonthEnd(accountId: number): Map<string, number> {
  const rows = db
    .prepare(
      `SELECT occurred_on, COALESCE(units_delta, 0) AS ud
       FROM movements
       WHERE account_id = ? AND COALESCE(units_delta, 0) > 0`
    )
    .all(accountId) as { occurred_on: string; ud: number }[];
  const m = new Map<string, number>();
  for (const r of rows) {
    const me = monthEndUtcYmd(monthKeyFromYmd(r.occurred_on));
    m.set(me, (m.get(me) ?? 0) + r.ud);
  }
  return m;
}

function afpPositiveCuotasInflowByMonthKey(accountId: number): Map<string, number> {
  const rows = db
    .prepare(
      `SELECT occurred_on, COALESCE(units_delta, 0) AS ud
       FROM movements
       WHERE account_id = ?
         AND COALESCE(units_delta, 0) > 0`
    )
    .all(accountId) as { occurred_on: string; ud: number }[];
  const m = new Map<string, number>();
  for (const r of rows) {
    const mk = monthKeyFromYmd(r.occurred_on);
    m.set(mk, (m.get(mk) ?? 0) + r.ud);
  }
  return m;
}

/**
 * Month-on-month investment-style metrics from existing valuations + merged capital flows
 * (same series as the account valuation chart). Not persisted.
 *
 * Skips **cuenta_corriente** (no P/L framing). Uses **monthly** granularity only (daily chart has no deposit line).
 * The **first** month with a valuation row is included: `prior_closing` is null and `net_capital_flow` equals cumulative
 * aportes at that date (so e.g. VEA’s March 2026 wires appear in March, not folded into April as ΔcumDep=0).
 */
/** @heavy Rebuilds monthly performance from valuation timeseries + capital flows (cached in-process). */
export function getAccountMonthlyPerformance(
  accountId: number,
  unit: TsUnit = "clp"
): { account_id: number; bucket_slug: string; monthly: AccountMonthlyPerformanceRow[] } | null {
  const row = db
    .prepare(
      `SELECT a.id AS id, g.slug AS bucket_slug
       FROM accounts a
       INNER JOIN asset_groups g ON g.id = a.asset_group_id
       WHERE a.id = ?`
    )
    .get(accountId) as { id: number; bucket_slug: string } | undefined;
  if (!row) return null;

  // Checking (cartola movement-balance) accounts have their own monthly table; skip the perf builder.
  // USD / CLP ledger cash accounts DO get a perf series (value − deposited = interest earned).
  if (isMovementBalanceCashCategory(row.bucket_slug)) {
    return { account_id: accountId, bucket_slug: row.bucket_slug, monthly: [] };
  }

  const base = getAggregationCached(cacheKeyAccountMonthlyPerf(accountId, unit), () =>
    buildAccountMonthlyPerformanceUncached(accountId, unit, row.bucket_slug)
  );
  // Live MTM marks refresh on every quote sync; do not bake them into the perf cache.
  const asc = [...base.monthly].reverse();
  const withLive = applyLiveCloseToCurrentMonthPerfRows(accountId, row.bucket_slug, asc, unit);
  return {
    account_id: base.account_id,
    bucket_slug: base.bucket_slug,
    monthly: [...withLive].reverse(),
  };
}

function buildAccountMonthlyPerformanceUncached(
  accountId: number,
  unit: TsUnit,
  bucketSlug: string
): { account_id: number; bucket_slug: string; monthly: AccountMonthlyPerformanceRow[] } {
  const ts = getAccountValuationTimeseriesForPerf(accountId, unit, () =>
    getAccountValuationTimeseries(accountId, unit, {})
  );
  if (!ts || ts.granularity !== "monthly" || !ts.accounts.points.length) {
    return { account_id: accountId, bucket_slug: bucketSlug, monthly: [] };
  }

  const dk = String(accountId);
  const depKeyFull = `${dk}__dep`;
  let pts = [...ts.accounts.points].sort((a, b) => String(a.as_of_date).localeCompare(String(b.as_of_date)));
  const depKey = depKeyFull;

  const bookAsc = loadBookValuationsAsc(accountId);
  const exactClpByDate = new Map(bookAsc.map((r) => [r.as_of_date, r.value_clp]));

  let prevClose: number | null = null;
  let prevCumDep: number | null = null;
  let prevPerfAsOf: string | null = null;
  const outAsc: AccountMonthlyPerformanceRow[] = [];
  let ytdYear = 0;
  let ytdRun = 0;
  let cumPl = 0;
  const unitsByMonthEnd = stockUnitsInflowByMonthEnd(accountId);
  const afpCuotasByMonthKey =
    bucketSlug === "afp" ? afpPositiveCuotasInflowByMonthKey(accountId) : null;
  const cryptoInflowByMonthEnd =
    cryptoAssetFromCategorySlug(bucketSlug) != null ? cryptoCoinInflowByMonthEnd(accountId) : null;
  const cryptoAsset = cryptoAssetFromCategorySlug(bucketSlug);
  const bucketKind = accountBucketKindSlug(bucketSlug);
  const deptoLedger =
    bucketKind === "mortgage" || bucketKind === "property"
      ? loadDeptoLedgerFromMovements()
      : null;
  const isMortgage = bucketKind === "mortgage";
  const isDeptoProperty = bucketKind === "property";
  const isCreditCard = bucketKind === "credit_card";
  const deptoSnapshotDates = deptoLedger ? pts.map((p) => String(p.as_of_date)) : [];
  const mortgageUfByDate =
    deptoLedger && isMortgage
      ? deptoCreditoRestanteUfBySnapshotDates(deptoSnapshotDates, deptoLedger)
      : null;
  const deptoUfClpByDate =
    deptoLedger && (isMortgage || isDeptoProperty)
      ? ufClpBySnapshotDatesAsc(deptoSnapshotDates)
      : null;
  const mortgageCloseClpByDate =
    deptoLedger && deptoUfClpByDate && isMortgage
      ? deptoMortgageCloseClpBySnapshotDates(deptoSnapshotDates, deptoLedger, deptoUfClpByDate)
      : null;
  const propertyCloseClpByDate =
    deptoLedger && deptoUfClpByDate && isDeptoProperty
      ? deptoSueciaPropertyCloseClpBySnapshotDates(deptoSnapshotDates, deptoLedger, deptoUfClpByDate)
      : null;
  const deptoCloseClpByDate = mortgageCloseClpByDate ?? propertyCloseClpByDate;
  const ccBillingPayByMonth =
    bucketKind === "credit_card" && ccInstallmentLedgerRowCount(accountId) > 0
      ? creditCardInstallmentPaymentsByBillingMonth(accountId)
      : null;
  const stockUnitsInflowForPerfRow = (asOf: string) =>
    afpCuotasByMonthKey != null
      ? afpCuotasByMonthKey.get(monthKeyFromYmd(asOf)) ?? 0
      : cryptoInflowByMonthEnd != null
        ? cryptoInflowByMonthEnd.get(asOf) ?? 0
        : unitsByMonthEnd.get(asOf) ?? 0;
  const coinUnitsEomForPerfRow = (asOf: string) =>
    cryptoAsset != null ? cryptoCoinCumulativeThroughDate(accountId, asOf, cryptoAsset) : null;

  for (const p of pts) {
    const asOf = String(p.as_of_date);
    const close =
      deptoCloseClpByDate != null
        ? monthEndCloseForMortgagePerformance(
            accountId,
            asOf,
            p,
            dk,
            bookAsc,
            exactClpByDate,
            unit,
            deptoCloseClpByDate
          )
        : monthEndCloseForPerformance(accountId, asOf, p, dk, bookAsc, exactClpByDate, unit);
    if (close == null) continue;
    const cumDep = numCell(p[depKey]) ?? 0;

    if (prevClose == null) {
      const y = Number(asOf.slice(0, 4));
      if (!Number.isFinite(y)) {
        prevClose = close;
        prevCumDep = cumDep;
        continue;
      }
      ytdYear = y;
      ytdRun = 0;
      /** First month in the series: no prior month-end — net flow = cumulative aportes at this date (vs 0). */
      const netFlowFirst =
        isMortgage && deptoLedger
          ? perfMortgagePaymentsInUnit(deptoLedger, asOf, null, unit)
          : isDeptoProperty && deptoLedger
            ? perfDeptoPropertyPaymentsInUnit(deptoLedger, asOf, null, unit)
            : cumDep;
      /** Mortgage: opening balance after pie is not P/L (only cuota-driven changes count). */
      const nominalFirst = isMortgage
        ? 0
        : isCreditCard
          ? creditCardNominalPlStub()
          : close - netFlowFirst;
      const pctFirst =
        isCreditCard
          ? null
          : Math.abs(netFlowFirst) > 1e-6 && Number.isFinite(nominalFirst / netFlowFirst)
            ? nominalFirst / netFlowFirst
            : null;
      ytdRun += nominalFirst;
      cumPl += nominalFirst;
      outAsc.push({
        as_of_date: asOf,
        closing_value: close,
        prior_closing: null,
        net_capital_flow: netFlowFirst,
        stock_units_inflow: stockUnitsInflowForPerfRow(asOf),
        coin_units_eom: coinUnitsEomForPerfRow(asOf),
        nominal_pl: nominalFirst,
        pct_month: pctFirst,
        ytd_nominal_pl: ytdRun,
        cumulative_nominal_pl: cumPl,
        ...(mortgageUfByDate
          ? {
              closing_balance_uf: mortgageUfByDate.get(asOf) ?? null,
              uf_clp_day: deptoUfClpByDate?.get(asOf) ?? null,
            }
          : {}),
        unit,
      });
      prevClose = close;
      prevCumDep = cumDep;
      prevPerfAsOf = asOf;
      continue;
    }

    const mortgageAfterExclusive =
      isMortgage && deptoLedger && prevPerfAsOf != null && monthKeyFromYmd(prevPerfAsOf) === monthKeyFromYmd(asOf)
        ? prevPerfAsOf
        : null;
    const propertyAfterExclusive =
      isDeptoProperty && deptoLedger && prevPerfAsOf != null && monthKeyFromYmd(prevPerfAsOf) === monthKeyFromYmd(asOf)
        ? prevPerfAsOf
        : null;
    let netFlow =
      isMortgage && deptoLedger
        ? perfMortgagePaymentsInUnit(deptoLedger, asOf, mortgageAfterExclusive, unit)
        : isDeptoProperty && deptoLedger
          ? perfDeptoPropertyPaymentsInUnit(deptoLedger, asOf, propertyAfterExclusive, unit)
          : cumDep - (prevCumDep ?? 0);
    if (ccBillingPayByMonth != null) {
      // Cuotas paid during month M (~10th) were billed at the previous month's close, and
      // the plan schedule is keyed by facturación month — so look up M−1.
      const asOfYm = monthKeyFromYmd(asOf);
      const sched = asOfYm != null ? ccBillingPayByMonth.get(addCalendarMonths(asOfYm, -1)) ?? 0 : 0;
      const balanceDelta = close - prevClose;
      if (sched > 0 && Math.abs(balanceDelta) < MONTH_ROW_EPS) {
        netFlow = perfSheetClpFlowInUnit(sched, asOf, unit);
      }
    }
    const nominal = isMortgage
      ? mortgageFinancingCostClp(prevClose, close, netFlow)
      : isCreditCard
        ? creditCardNominalPlStub()
        : close - prevClose - netFlow;
    const pct = isMortgage
      ? mortgagePctMonth(nominal, prevClose)
      : isCreditCard
        ? null
        : (() => {
            const denom = prevClose + netFlow;
            return Math.abs(denom) > 1e-6 && Number.isFinite(nominal / denom) ? nominal / denom : null;
          })();

    const y = Number(String(p.as_of_date).slice(0, 4));
    if (!Number.isFinite(y)) {
      prevClose = close;
      prevCumDep = cumDep;
      prevPerfAsOf = asOf;
      continue;
    }
    if (y !== ytdYear) {
      ytdYear = y;
      ytdRun = 0;
    }
    ytdRun += nominal;
    cumPl += nominal;

    outAsc.push({
      as_of_date: asOf,
      closing_value: close,
      prior_closing: prevClose,
      net_capital_flow: netFlow,
      stock_units_inflow: stockUnitsInflowForPerfRow(asOf),
      coin_units_eom: coinUnitsEomForPerfRow(asOf),
      nominal_pl: nominal,
      pct_month: pct,
      ytd_nominal_pl: ytdRun,
      cumulative_nominal_pl: cumPl,
      ...(mortgageUfByDate
        ? {
            closing_balance_uf: mortgageUfByDate.get(asOf) ?? null,
            uf_clp_day: deptoUfClpByDate?.get(asOf) ?? null,
          }
        : {}),
      unit,
    });

    prevClose = close;
    prevCumDep = cumDep;
    prevPerfAsOf = asOf;
  }

  const perfMeta = accountMetaForLivePerfClose(accountId);
  const reanchorOpts: ReanchorMonthlyPerfOpts = {
    accountId,
    bucketSlug,
    unit,
    import_key: perfMeta?.import_key ?? null,
    name: perfMeta?.name ?? null,
  };
  const collapsed = collapseMonthlyPerfDuplicateCalendarMonths(outAsc, reanchorOpts);
  return { account_id: accountId, bucket_slug: bucketSlug, monthly: [...collapsed].reverse() };
}

/** Latest consolidated cierre per calendar month (`YYYY-MM`). */
export function closingByCalendarMonthFromRaw(raw: Map<string, number>): Map<string, number> {
  const latestInMonth = new Map<string, { as_of_date: string; closing_value: number }>();
  for (const [d, v] of raw) {
    if (!Number.isFinite(v)) continue;
    const mk = monthKeyFromYmd(d);
    const prev = latestInMonth.get(mk);
    if (!prev || d >= prev.as_of_date) {
      latestInMonth.set(mk, { as_of_date: d, closing_value: v });
    }
  }
  const out = new Map<string, number>();
  for (const [mk, bucket] of latestInMonth) {
    out.set(mk, bucket.closing_value);
  }
  return out;
}

/**
 * Map monthly perf cierre onto daily (or mixed) chart dates: each date uses that month's cierre,
 * including when the snapshot is dated later in the same month (e.g. live close on Chile today).
 */
export function mapMonthlyClosingToChartDates(
  raw: Map<string, number>,
  datesAsc: string[]
): Map<string, number> {
  const byMonth = closingByCalendarMonthFromRaw(raw);
  const monthsAsc = [...byMonth.keys()].sort();
  const out = new Map<string, number>();
  for (const d of datesAsc) {
    const mk = monthKeyFromYmd(d);
    const inMonth = byMonth.get(mk);
    if (inMonth != null && Number.isFinite(inMonth)) {
      out.set(d, inMonth);
      continue;
    }
    let last: number | undefined;
    for (const m of monthsAsc) {
      if (m > mk) break;
      const v = byMonth.get(m);
      if (v != null && Number.isFinite(v)) last = v;
    }
    if (last != null && Number.isFinite(last)) out.set(d, last);
  }
  return out;
}

/** Latest calendar month nominal P/L (falls back to most recent month in the series). */
export function latestAccountMonthDelta(accountId: number, unit: TsUnit = "clp"): number | null {
  const perf = getAccountMonthlyPerformance(accountId, unit);
  if (!perf?.monthly.length) return null;
  const currentMk = monthKeyFromYmd(chileCalendarTodayYmd());
  for (const row of perf.monthly) {
    if (monthKeyFromYmd(row.as_of_date) === currentMk) {
      return row.nominal_pl;
    }
  }
  const latest = perf.monthly[0]?.nominal_pl;
  return latest != null && Number.isFinite(latest) ? latest : null;
}

export type GroupMonthlyPerformanceBarAccount = {
  account_id: number;
  name: string;
  /** Point field for this account’s monthly nominal P/L (e.g. `pl_12`). */
  bar_data_key: string;
  /** Portfolio group / account color (`r,g,b`), same as valuation lines. */
  color_rgb?: string;
};

/**
 * Latest snapshot in each calendar month (same rule as client `densifyRecordsByCalendarPeriod`).
 * Different accounts can have different `as_of_date` strings in the same month (e.g. MTM “today” vs month-end import);
 * merging group rows by exact date would zero out whoever does not share that day.
 */
function bestPerformanceRowByMonthKey(
  asc: AccountMonthlyPerformanceRow[]
): Map<string, AccountMonthlyPerformanceRow> {
  const grouped = new Map<string, AccountMonthlyPerformanceRow[]>();
  for (const row of asc) {
    const mk = monthKeyFromYmd(row.as_of_date);
    const arr = grouped.get(mk) ?? [];
    arr.push(row);
    grouped.set(mk, arr);
  }
  const currentMk = monthKeyFromYmd(chileCalendarTodayYmd());
  const out = new Map<string, AccountMonthlyPerformanceRow>();
  for (const [mk, monthRows] of grouped) {
    if (mk === currentMk) {
      const picked = pickRepresentativeMonthlyPerfRow(monthRows, mk);
      const totalFlow = monthRows.reduce((s, r) => s + r.net_capital_flow, 0);
      out.set(mk, { ...picked, net_capital_flow: totalFlow });
      continue;
    }
    const best = monthRows.reduce((a, r) =>
      !a || String(r.as_of_date).localeCompare(String(a.as_of_date)) > 0 ? r : a
    )!;
    out.set(mk, best);
  }
  return out;
}

/**
 * Per-class tab: per-account monthly P/L bars + group YTD area (resets each Jan) + ΣΔ line, and
 * `accumulated_earnings` (running sum of `delta_total` since first month, no reset).
 * Skips `cuenta_corriente` and accounts with no monthly P/L rows.
 *
 * Points are **one row per calendar month** (`as_of_date` = that month’s UTC month-end). Each account’s
 * nominal for that month is taken from its latest performance row in that month, so brokerage / inversiones
 * tabs stay consistent when e.g. equities end on “today” mid-month and Fintual only on month-end.
 */
/** @heavy One {@link getAccountMonthlyPerformance} per account in the group tab. */
export function getGroupMonthlyPerformanceSeries(
  groupSlug: string,
  unit: TsUnit = "clp",
  tabSubgroup?: string
): {
  unit: TsUnit;
  group_slug: string;
  bar_accounts: GroupMonthlyPerformanceBarAccount[];
  points: Record<string, string | number | null>[];
} {
  const rows = listAccountsForGroupTab(groupSlug, tabSubgroup);
  const perfRows = rows.filter(
    (r) => !isMovementBalanceCashCategory(r.bucket_slug)
  );

  const byIdAsc = new Map<number, AccountMonthlyPerformanceRow[]>();
  const bar_accounts: GroupMonthlyPerformanceBarAccount[] = [];

  for (const r of perfRows) {
    const seriesId = seriesAccountIdForGroupTab(r, groupSlug);
    const p = getAccountMonthlyPerformance(seriesId, unit);
    if (!p || p.monthly.length === 0) continue;
    const asc = [...p.monthly].reverse();
    byIdAsc.set(seriesId, asc);
    const color_rgb =
      seriesId > 0
        ? colorRgbForTimeseriesAccountLine(seriesId)
        : colorRgbForSyntheticAccountLine(seriesId);
    bar_accounts.push({
      account_id: seriesId,
      name: r.name,
      bar_data_key: `pl_${seriesId}`,
      ...(color_rgb ? { color_rgb } : {}),
    });
  }

  const byIdBestByMonth = new Map<number, Map<string, AccountMonthlyPerformanceRow>>();
  const allMonthKeys = new Set<string>();
  for (const [id, asc] of byIdAsc) {
    const bm = bestPerformanceRowByMonthKey(asc);
    byIdBestByMonth.set(id, bm);
    for (const mk of bm.keys()) allMonthKeys.add(mk);
  }
  const monthsAsc = [...allMonthKeys].sort((a, b) => a.localeCompare(b));

  const nominalForAccountMonth = (accountId: number, monthKey: string): number => {
    const row = byIdBestByMonth.get(accountId)?.get(monthKey);
    const n = row?.nominal_pl;
    return n != null && Number.isFinite(n) ? n : 0;
  };

  const pointsAsc: Record<string, string | number | null>[] = [];
  let ytdYear = 0;
  let ytdRun = 0;
  let cumLife = 0;

  for (const mk of monthsAsc) {
    const d = monthEndUtcYmd(mk);
    const pt: Record<string, string | number | null> = { as_of_date: d };
    let deltaTotal = 0;
    for (const ba of bar_accounts) {
      const v = nominalForAccountMonth(ba.account_id, mk);
      pt[ba.bar_data_key] = v;
      deltaTotal += v;
    }
    pt.delta_total = deltaTotal;

    const y = Number(String(d).slice(0, 4));
    if (Number.isFinite(y) && y !== ytdYear) {
      ytdYear = y;
      ytdRun = 0;
    }
    ytdRun += deltaTotal;
    pt.ytd_group = ytdRun;
    cumLife += deltaTotal;
    pt.accumulated_earnings = cumLife;

    pointsAsc.push(pt);
  }

  return {
    unit,
    group_slug: groupSlug,
    bar_accounts,
    points: pointsAsc,
  };
}

/**
 * Dashboard “Acciones” (SPY ± VEA): monthly Δ as sum of each ticker’s nominal P/L, area = cumulative sum from
 * first month with data (no calendar-year reset). Same per-account logic as {@link getAccountMonthlyPerformance}.
 */
export function getStocksLifetimeEarningsSeries(unit: TsUnit = "clp"): {
  unit: TsUnit;
  stock_accounts: { account_id: number; name: string }[];
  points: { as_of_date: string; delta_month: number; accumulated_earnings: number; ytd_merged: number }[];
} {
  const stock_accounts = db
    .prepare(
      `SELECT a.id AS account_id, a.name
       FROM accounts a
       JOIN asset_groups g ON g.id = a.asset_group_id
       WHERE g.slug = 'brokerage_acciones'
         AND (a.notes IS NULL OR a.notes != 'import:excel|key=stocks')
       ORDER BY a.name`
    )
    .all() as { account_id: number; name: string }[];
  if (stock_accounts.length === 0) {
    return { unit, stock_accounts: [], points: [] };
  }

  const byIdAsc = new Map<number, AccountMonthlyPerformanceRow[]>();
  for (const s of stock_accounts) {
    const p = getAccountMonthlyPerformance(s.account_id, unit);
    if (!p || p.monthly.length === 0) continue;
    byIdAsc.set(s.account_id, [...p.monthly].reverse());
  }
  if (byIdAsc.size === 0) {
    return { unit, stock_accounts, points: [] };
  }

  const dateSet = new Set<string>();
  for (const asc of byIdAsc.values()) {
    for (const row of asc) dateSet.add(row.as_of_date);
  }
  const datesAsc = [...dateSet].sort((a, b) => a.localeCompare(b));

  const nominalCell = new Map<string, number>();
  for (const [id, asc] of byIdAsc) {
    for (const row of asc) {
      const n = row.nominal_pl;
      nominalCell.set(`${id}|${row.as_of_date}`, n != null && Number.isFinite(n) ? n : 0);
    }
  }

  let cum = 0;
  let ytdYear = 0;
  let ytdRun = 0;
  const points = datesAsc.map((d) => {
    let deltaMonth = 0;
    for (const s of stock_accounts) {
      deltaMonth += nominalCell.get(`${s.account_id}|${d}`) ?? 0;
    }
    cum += deltaMonth;
    const y = Number(String(d).slice(0, 4));
    if (Number.isFinite(y) && y !== ytdYear) {
      ytdYear = y;
      ytdRun = 0;
    }
    ytdRun += deltaMonth;
    return { as_of_date: d, delta_month: deltaMonth, accumulated_earnings: cum, ytd_merged: ytdRun };
  });

  return { unit, stock_accounts, points };
}
