import {
  getAccountValuationTimeseries,
  listAccountsForGroupTab,
  convertTs,
  seriesAccountIdForGroupTab,
} from "./valuationTimeseries.js";
import type { TsUnit } from "./valuationTimeseries.js";
import { pickRepresentativeMonthlyPerfRow } from "./accountPerformanceMonthPick.js";
import { chileCalendarTodayYmd } from "./chileDate.js";
import { monthEndUtcYmd, monthKeyFromYmd } from "./calendarMonth.js";
import { resolveCfraserCsvDir } from "./cfraserPaths.js";
import {
  deptoCreditoRestanteUfBySnapshotDates,
  deptoMortgageCloseClpBySnapshotDates,
  deptoSueciaPropertyCloseClpBySnapshotDates,
  loadDeptoDividendosSheetLedger,
  mortgageSheetPaymentsClpThroughDate,
} from "./deptoDividendosLedger.js";
import {
  ccInstallmentLedgerRowCount,
  creditCardInstallmentPaymentsByBillingMonth,
} from "./ccInstallmentLedgerDb.js";
import { db } from "./db.js";
import {
  colorRgbForSyntheticAccountLine,
  colorRgbForTimeseriesAccountLine,
} from "./chartColorRgb.js";
import { ufClpBySnapshotDatesAsc } from "./fxRates.js";
import { AFP_IMPORT_CUOTAS_NOTE_SQL } from "./afpUnoValuation.js";
import {
  accountUsesEquityMtm,
  computeEquityMtmClp,
  computeEquityMtmClpCachedLive,
} from "./brokerageEquityMtm.js";
import { liveAfpDisplayValueClp } from "./accountPosition.js";
import { getCachedLiveEquityQuote } from "./equityQuote.js";
import { latestValuationRowOnOrBeforeChileToday } from "./valuationLatest.js";
import {
  accountUsesCryptoMtm,
  CRYPTO_IMPORT_NOTE_SQL,
  computeCryptoMtmClp,
  cryptoAssetFromCategorySlug,
  cryptoCoinCumulativeThroughDate,
} from "./cryptoValuation.js";

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

function collapseMonthlyPerfDuplicateCalendarMonths(
  outAsc: AccountMonthlyPerformanceRow[]
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
  const currentMk = monthKeyFromYmd(chileCalendarTodayYmd());
  const picked = monthsAsc.map((mk) => {
    const monthRows = byMonth.get(mk)!;
    const row = pickRepresentativeMonthlyPerfRow(monthRows, mk);
    if (mk !== currentMk) return row;
    const totalFlow = monthRows.reduce((s, r) => s + r.net_capital_flow, 0);
    return { ...row, net_capital_flow: totalFlow };
  });
  return recomputeYtdAndCumulativeOnMonthlyRows(picked);
}

function livePerfCloseClpForCurrentMonth(
  accountId: number,
  categorySlug: string
): number | null {
  if (categorySlug === "property") {
    const booked = latestValuationRowOnOrBeforeChileToday(accountId);
    if (booked?.value_clp != null && Number.isFinite(booked.value_clp)) {
      return booked.value_clp;
    }
    return null;
  }
  if (categorySlug === "afp") {
    return liveAfpDisplayValueClp(accountId)?.value_clp ?? null;
  }
  if (accountUsesEquityMtm(accountId)) {
    return computeEquityMtmClpCachedLive(accountId);
  }
  if (accountUsesCryptoMtm(accountId)) {
    const ticker = cryptoAssetFromCategorySlug(categorySlug);
    if (!ticker) return null;
    const equityTicker = ticker === "BTC" ? "BTC-USD" : "ETH-USD";
    const cached = getCachedLiveEquityQuote(equityTicker);
    if (!cached) return null;
    return computeCryptoMtmClp(accountId, cached.trade_date, cached.price_usd);
  }
  return null;
}

function priorCalendarMonthKeyFromToday(todayYmd: string): string {
  const y = Number(todayYmd.slice(0, 4));
  const m = Number(todayYmd.slice(5, 7));
  if (!Number.isFinite(y) || !Number.isFinite(m)) return todayYmd.slice(0, 7);
  if (m === 1) return `${y - 1}-12`;
  return `${y}-${String(m - 1).padStart(2, "0")}`;
}

/** Prefer live marks for the in-progress calendar month so P/L reconciles with dashboard balance Δ. */
function applyLiveCloseToCurrentMonthPerfRows(
  accountId: number,
  categorySlug: string,
  sortedAsc: AccountMonthlyPerformanceRow[],
  unit: TsUnit
): AccountMonthlyPerformanceRow[] {
  if (!sortedAsc.length) return sortedAsc;
  const today = chileCalendarTodayYmd();
  const curMk = monthKeyFromYmd(today);
  const idx = sortedAsc.findIndex((r) => monthKeyFromYmd(r.as_of_date) === curMk);
  if (idx < 0) return sortedAsc;

  const row = sortedAsc[idx]!;
  const priorMk = priorCalendarMonthKeyFromToday(today);
  const priorRow = sortedAsc.find((r) => monthKeyFromYmd(r.as_of_date) === priorMk);
  const priorClose = priorRow?.closing_value ?? row.prior_closing;
  if (priorClose == null || !Number.isFinite(priorClose)) return sortedAsc;

  let live: number | null = livePerfCloseClpForCurrentMonth(accountId, categorySlug);
  if (live != null && unit === "usd") {
    const usd = convertTs(live, today, "usd");
    live = Number.isFinite(usd) ? usd : null;
  }
  if (live == null || !Number.isFinite(live)) live = row.closing_value;
  if (live == null || !Number.isFinite(live)) return sortedAsc;

  const netFlow = row.net_capital_flow;
  const nominal = live - priorClose - netFlow;
  const denom = priorClose + netFlow;
  const pct =
    Math.abs(denom) > 1e-6 && Number.isFinite(nominal / denom) ? nominal / denom : null;
  const out = [...sortedAsc];
  out[idx] = {
    ...row,
    as_of_date: today,
    prior_closing: priorClose,
    closing_value: live,
    nominal_pl: nominal,
    pct_month: pct,
  };
  return recomputeYtdAndCumulativeOnMonthlyRows(out);
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

/** Stored `valuations` rows (ascending) for book / month-end snapshots. */
export function loadBookValuationsAsc(accountId: number): { as_of_date: string; value_clp: number }[] {
  return db
    .prepare(`SELECT as_of_date, value_clp FROM valuations WHERE account_id = ? ORDER BY as_of_date`)
    .all(accountId) as { as_of_date: string; value_clp: number }[];
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
  const rows = db
    .prepare(
      `SELECT occurred_on, COALESCE(units_delta, 0) AS ud
       FROM movements
       WHERE account_id = ?
         AND flow_kind IN ('compra_usd', 'dividend_usd')
         AND COALESCE(units_delta, 0) > 0`
    )
    .all(accountId) as { occurred_on: string; ud: number }[];
  const m = new Map<string, number>();
  for (const r of rows) {
    const me = monthEndUtcYmd(monthKeyFromYmd(r.occurred_on));
    m.set(me, (m.get(me) ?? 0) + r.ud);
  }
  return m;
}

/** `YYYY-MM` → Σ positive `units_delta` on AFP import rows in that calendar month (matches chart rows keyed by snapshot month). */
/** Month-end `YYYY-MM-DD` → Σ positive `units_delta` on cripto-sheet rows in that calendar month. */
function cryptoCoinInflowByMonthEnd(accountId: number): Map<string, number> {
  const rows = db
    .prepare(
      `SELECT occurred_on, COALESCE(units_delta, 0) AS ud
       FROM movements
       WHERE account_id = ?
         AND ${CRYPTO_IMPORT_NOTE_SQL}
         AND COALESCE(units_delta, 0) > 0`
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
         AND ${AFP_IMPORT_CUOTAS_NOTE_SQL}
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
export function getAccountMonthlyPerformance(
  accountId: number,
  unit: TsUnit = "clp"
): { account_id: number; category_slug: string; monthly: AccountMonthlyPerformanceRow[] } | null {
  const row = db
    .prepare(
      `SELECT a.id AS id, c.slug AS category_slug FROM accounts a JOIN categories c ON c.id = a.category_id WHERE a.id = ?`
    )
    .get(accountId) as { id: number; category_slug: string } | undefined;
  if (!row) return null;

  if (row.category_slug === "cuenta_corriente" || row.category_slug === "cuenta_ahorro_vivienda") {
    return { account_id: accountId, category_slug: row.category_slug, monthly: [] };
  }

  const ts = getAccountValuationTimeseries(accountId, unit, {});
  if (!ts || ts.granularity !== "monthly" || !ts.accounts.points.length) {
    return { account_id: accountId, category_slug: row.category_slug, monthly: [] };
  }

  const dk = String(accountId);
  const depKeyFull = `${dk}__dep`;
  const depKeyDisplay = `${dk}__dep_display`;
  let pts = [...ts.accounts.points].sort((a, b) => String(a.as_of_date).localeCompare(String(b.as_of_date)));
  const depKey = pts.some((p) => p[depKeyDisplay] != null && Number.isFinite(Number(p[depKeyDisplay])))
    ? depKeyDisplay
    : depKeyFull;

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
    row.category_slug === "afp" ? afpPositiveCuotasInflowByMonthKey(accountId) : null;
  const cryptoInflowByMonthEnd =
    cryptoAssetFromCategorySlug(row.category_slug) != null
      ? cryptoCoinInflowByMonthEnd(accountId)
      : null;
  const cryptoAsset = cryptoAssetFromCategorySlug(row.category_slug);
  const deptoLedger =
    row.category_slug === "mortgage" || row.category_slug === "property"
      ? loadDeptoDividendosSheetLedger(resolveCfraserCsvDir())
      : null;
  const isMortgage = row.category_slug === "mortgage";
  const isDeptoProperty = row.category_slug === "property";
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
    row.category_slug === "credit_card" && ccInstallmentLedgerRowCount(accountId) > 0
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
          ? mortgageSheetPaymentsClpThroughDate(deptoLedger, asOf, null)
          : cumDep;
      /** Mortgage: opening balance after pie is not P/L (only cuota-driven changes count). */
      const nominalFirst = isMortgage ? 0 : close - netFlowFirst;
      const pctFirst =
        Math.abs(netFlowFirst) > 1e-6 && Number.isFinite(nominalFirst / netFlowFirst)
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
    let netFlow =
      isMortgage && deptoLedger
        ? mortgageSheetPaymentsClpThroughDate(deptoLedger, asOf, mortgageAfterExclusive)
        : cumDep - (prevCumDep ?? 0);
    if (ccBillingPayByMonth != null) {
      const sched = ccBillingPayByMonth.get(monthKeyFromYmd(asOf)) ?? 0;
      const balanceDelta = close - prevClose;
      if (sched > 0 && Math.abs(balanceDelta) < MONTH_ROW_EPS) {
        netFlow = sched;
      }
    }
    const nominal = isMortgage
      ? mortgageFinancingCostClp(prevClose, close, netFlow)
      : close - prevClose - netFlow;
    const pct = isMortgage
      ? mortgagePctMonth(nominal, prevClose)
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

  const collapsed = collapseMonthlyPerfDuplicateCalendarMonths(outAsc);
  const withLive = applyLiveCloseToCurrentMonthPerfRows(
    accountId,
    row.category_slug,
    collapsed,
    unit
  );
  const monthly = [...withLive].reverse();
  return { account_id: accountId, category_slug: row.category_slug, monthly };
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
  const byMonth = new Map<string, AccountMonthlyPerformanceRow>();
  for (const row of asc) {
    const mk = monthKeyFromYmd(row.as_of_date);
    const prev = byMonth.get(mk);
    if (!prev || String(row.as_of_date).localeCompare(String(prev.as_of_date)) > 0) {
      byMonth.set(mk, row);
    }
  }
  return byMonth;
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
    (r) => r.category_slug !== "cuenta_corriente" && r.category_slug !== "cuenta_ahorro_vivienda"
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
  const accStmt = db.prepare("SELECT id AS account_id, name FROM accounts WHERE notes = ?");
  const spy = accStmt.get("import:excel|key=spy") as { account_id: number; name: string } | undefined;
  const vea = accStmt.get("import:excel|key=vea") as { account_id: number; name: string } | undefined;
  const stock_accounts = [spy, vea].filter((x): x is { account_id: number; name: string } => x != null);
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
