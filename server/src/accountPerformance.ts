import { dbStateMemo } from "./dbStateMemo.js";
import { cacheKeyAccountMonthlyPerf, getAggregationCached } from "./aggregationCache.js";
import { getAccountValuationTimeseriesForPerf } from "./accountPerformanceContext.js";
import { loadDeptoLedgerFromMovements } from "./deptoLedgerFromMovements.js";
import {
  getAccountValuationTimeseries,
  convertTs,
} from "./valuationTimeseries.js";
import type { TsUnit } from "./valuationTimeseries.js";
import { pickRepresentativeMonthlyPerfRow } from "./accountPerformanceMonthPick.js";
import { flowAdjustedPct } from "./periodReturns.js";
import { withRunningPlTotals } from "./monthlyPerfRollup.js";
import { chileCalendarTodayYmd } from "./chileDate.js";
import { flowEventInUnit, netDepositFlowCurrentMonthThroughToday } from "./flowsDeposits.js";
import { monthEndUtcYmd, monthKeyFromYmd } from "./calendarMonth.js";
import {
  deptoCreditoRestanteUfBySnapshotDates,
  deptoMortgageCloseClpBySnapshotDates,
  deptoPropertyPaymentEventsThroughDate,
  deptoPropertyCloseClpBySnapshotDates,
  mortgageSheetPaymentEventsThroughDate,
  type DeptoMortgageSheetRow,
} from "./deptoDividendosLedger.js";
import { ccFinancingCostClpBetween } from "./ccFinancingCostDaily.js";
import { isMovementBalanceCashCategory } from "./movementBalanceCashAccounts.js";
import { db } from "./db.js";
import { loadBookValuationsAsc } from "./bookValuations.js";
export { loadBookValuationsAsc } from "./bookValuations.js";
import { ufClpBySnapshotDatesAsc } from "./fxRates.js";
import { accountValueClpToUnitAt } from "./clpToUnitAt.js";
import { accountUsesEquityMtm, computeEquityMtmClp } from "./brokerageEquityMtm.js";
import { accountTodayValue } from "./accountTodayValue.js";
import {
  accountUsesCryptoMtm,
  requireCryptoMtmClp,
  cryptoAssetFromCategorySlug,
  cryptoCoinCumulativeThroughDate,
} from "./cryptoValuation.js";
import { accountBucketKindSlug } from "./accountBucket.js";
import { isCuotaLedgerKindSlug } from "./cuotaLedgerAccounts.js";
import { transferToLegUnits } from "./movementTransfer.js";
import {
  monthEndCloseFromPerfRows,
  monthEndMarkClpForAccount,
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

/** A CLP amount in the performance series unit at `asOf` (the card's financing cost). */
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

/**
 * Depto ledger payments in the calendar month of `asOf` (through `asOf`; only those after
 * `afterExclusive` when set, for same-month snapshots), in the series unit — each payment at
 * its own date's rate (`flowEventInUnit`), the same events and conversion as the mortgage card
 * and the daily series.
 */
function perfLedgerPaymentsInUnit(
  events: readonly { occurred_on: string; pago_clp: number }[],
  asOf: string,
  afterExclusive: string | null,
  unit: TsUnit
): number {
  const mk = asOf.slice(0, 7);
  let sum = 0;
  for (const e of events) {
    if (e.occurred_on.slice(0, 7) !== mk) continue;
    if (afterExclusive != null && e.occurred_on <= afterExclusive) continue;
    sum += flowEventInUnit({ occurred_on: e.occurred_on, amt: e.pago_clp }, unit);
  }
  return sum;
}

function perfDeptoPropertyPaymentsInUnit(
  ledger: readonly DeptoMortgageSheetRow[],
  asOf: string,
  afterExclusive: string | null,
  unit: TsUnit
): number {
  return perfLedgerPaymentsInUnit(
    deptoPropertyPaymentEventsThroughDate(ledger, asOf),
    asOf,
    afterExclusive,
    unit
  );
}

function perfMortgagePaymentsInUnit(
  ledger: readonly DeptoMortgageSheetRow[],
  asOf: string,
  afterExclusive: string | null,
  unit: TsUnit
): number {
  return perfLedgerPaymentsInUnit(
    mortgageSheetPaymentEventsThroughDate(ledger, asOf),
    asOf,
    afterExclusive,
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

/**
 * An account's month-end close in `unit`: its mark at the month end (`monthEndMarkClpForAccount`)
 * converted to the unit — USD at that month end's balance rate (a USD cash account's ledger
 * dollars), UF at that month end's UF — else the rows' own close, which is already in `unit`
 * (converting it again was the latent twin: a USD or UF close divided twice). The one wrapper
 * the per-account reanchor, the live current-month row and the group consolidation's prior
 * closes all read.
 */
export function monthEndCloseForAccountInUnit(
  accountId: number,
  bucketSlug: string,
  monthlyRows: readonly AccountMonthlyPerformanceRow[],
  monthKey: string,
  unit: TsUnit,
  opts?: MonthEndCloseForAccountOpts
): number | null {
  const markClp = monthEndMarkClpForAccount(accountId, bucketSlug, monthKey, opts);
  if (markClp == null) return monthEndCloseFromPerfRows(monthlyRows, monthKey);
  if (unit === "clp") return markClp;
  return accountValueClpToUnitAt(accountId, markClp, monthEndUtcYmd(monthKey), unit);
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

    const ccPerf = isCreditCard
      ? creditCardMonthPerf(
          opts.accountId,
          prior,
          close,
          out.length > 0 ? monthEndUtcYmd(priorMk) : null,
          monthEndUtcYmd(mk),
          opts.unit
        )
      : null;
    if (ccPerf) netFlow = ccPerf.netFlow;

    if (prior == null || !Number.isFinite(prior)) {
      prior_closing = null;
      nominal_pl = isMortgage ? 0 : ccPerf ? ccPerf.nominal : close - netFlow;
      // No prior close: the capital at work is the month's own net inflow, by the shared rule —
      // a first month of net withdrawals has none and reads null, not a sign-flipped %.
      pct_month = ccPerf
        ? ccPerf.pct
        : isMortgage
          ? null
          : flowAdjustedPct(nominal_pl, null, netFlow, close, opts.unit);
    } else {
      prior_closing = prior;
      nominal_pl = isMortgage
        ? mortgageMonthlyNominalPl(prior, close, netFlow)
        : ccPerf
          ? ccPerf.nominal
          : close - prior - netFlow;
      pct_month = isMortgage
        ? liabilityPctMonth(nominal_pl, prior)
        : ccPerf
          ? ccPerf.pct
          : flowAdjustedPct(nominal_pl, prior, netFlow, close, opts.unit);
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

  return withRunningPlTotals(out);
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
  return dbStateMemo("account_meta_live_perf_close", accountId, () => accountMetaForLivePerfCloseUncached(accountId));
}

function accountMetaForLivePerfCloseUncached(
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

/**
 * A live close for the current month: the CLP value today, the day it is dated and the day its
 * pesos were priced (`AccountTodayValue.priced_on`).
 */
export type LivePerfClose = { value_clp: number; as_of_date: string; priced_on: string };

/** The current month's live close: the account's one today value (`accountTodayValue`). */
export function livePerfCloseForCurrentMonth(
  accountId: number,
  categorySlug: string
): LivePerfClose | null {
  const meta = accountMetaForLivePerfClose(accountId);
  const slug = categorySlug || meta?.bucket_slug || "";
  const live = accountTodayValue(accountId, slug, {
    import_key: meta?.import_key ?? null,
    name: meta?.name ?? null,
  });
  if (live?.value_clp != null && Number.isFinite(live.value_clp)) return live;
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
  /** The live CLP close; a bare number is a mark dated today. */
  resolveLive?: () => number | LivePerfClose | null
): AccountMonthlyPerformanceRow[] {
  if (!sortedAsc.length) return sortedAsc;

  const today = chileCalendarTodayYmd();
  const curMk = monthKeyFromYmd(today);
  const priorMk = priorCalendarMonthKeyFromToday(today);
  const meta = accountMetaForLivePerfClose(accountId);
  const bucketKind = accountBucketKindSlug(categorySlug || meta?.bucket_slug || "");
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

  const resolved = resolveLive?.() ?? livePerfCloseForCurrentMonth(accountId, categorySlug);
  const liveClose: LivePerfClose | null =
    typeof resolved === "number"
      ? { value_clp: resolved, as_of_date: today, priced_on: today }
      : resolved;
  let live: number | null = liveClose?.value_clp ?? null;
  if (live != null && unit !== "clp") {
    // The dashboard row's frame (`current_value_usd`): the pesos at the fx of the day they
    // were priced, live while that fx day is open; a USD cash account's ledger dollars. In UF,
    // today's UF (the live row used to stay in pesos).
    live = accountValueClpToUnitAt(accountId, live, today, unit, {
      markAsOf: liveClose!.priced_on,
    });
  }
  if (live == null || !Number.isFinite(live)) {
    if (row?.closing_value != null && Number.isFinite(row.closing_value)) live = row.closing_value;
    else return sortedAsc;
  }

  const mortgageLedger = bucketKind === "mortgage" ? loadDeptoLedgerFromMovements() : null;
  // Card: the month so far costs whatever it has been charged; the rest of the balance move
  // (purchases, PAGOs, anchor corrections) is flow — same identity as the closed months.
  const ccPerf =
    bucketKind === "credit_card"
      ? creditCardMonthPerf(accountId, priorClose, live, monthEndUtcYmd(priorMk), today, unit)
      : null;
  const netFlow = (() => {
    if (ccPerf) return ccPerf.netFlow;
    if (bucketKind === "property") {
      const ledger = loadDeptoLedgerFromMovements();
      if (ledger.length > 0) {
        return perfDeptoPropertyPaymentsInUnit(ledger, today, null, unit);
      }
    }
    if (bucketKind === "mortgage") {
      return mortgageLedger != null && mortgageLedger.length > 0
        ? perfMortgagePaymentsInUnit(mortgageLedger, today, null, unit)
        : row?.net_capital_flow ?? 0;
    }
    // Live close is as-of-today, so the flow must be too: the base row sums the whole
    // calendar month. Both legs read forward-posted rows as today (`displayLedgerCutoffYmd`
    // for the balance, the display-dated events for the flow), so such a row never reads
    // as phantom P/L in either direction.
    if (unit === "uf") {
      // UF window flows convert at the window end, as the closed months' do.
      return perfSheetClpFlowInUnit(
        netDepositFlowCurrentMonthThroughToday(accountId, "clp"),
        today,
        "uf"
      );
    }
    return netDepositFlowCurrentMonthThroughToday(accountId, unit);
  })();
  const nominal = ccPerf
    ? ccPerf.nominal
    : bucketKind === "mortgage"
      ? mortgageMonthlyNominalPl(priorClose, live, netFlow)
      : live - priorClose - netFlow;
  // The closed months' rule (`reanchorMonthlyPerfToCalendarMonthEnds`): a running month that
  // ends at zero, or whose withdrawals exceed the prior close — a liquidation — charges its
  // flows at month end instead of reading exactly −100% (or null) and poisoning every
  // chained window.
  const pct = ccPerf
    ? ccPerf.pct
    : bucketKind === "mortgage"
      ? liabilityPctMonth(nominal, priorClose)
      : flowAdjustedPct(nominal, priorClose, netFlow, live, unit);

  const mortgageUfFields =
    bucketKind === "mortgage"
      ? (() => {
          if (!mortgageLedger?.length) return {};
          const ufMap = ufClpBySnapshotDatesAsc([today]);
          const ufByDate = deptoCreditoRestanteUfBySnapshotDates([today], mortgageLedger);
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
    return withRunningPlTotals(out);
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
  return withRunningPlTotals(out);
}

function applyLiveCloseToCurrentMonthPerfRows(
  accountId: number,
  categorySlug: string,
  sortedAsc: AccountMonthlyPerformanceRow[],
  unit: TsUnit
): AccountMonthlyPerformanceRow[] {
  return patchOrInsertLiveCurrentMonthPerfRows(accountId, categorySlug, sortedAsc, unit);
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
    rawClp = requireCryptoMtmClp(accountId, asOf);
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
 * Credit-card month, in the series unit: P/L is the cost of financing (intereses, comisiones,
 * impuestos from the statements, loss-negative) and the capital flow is everything else that
 * moved the balance — purchases as borrowing, payments as capital in, plus the corrections the
 * evidence anchors apply to both. See `ccFinancingCostDaily.ts` for why the balance move is
 * flow rather than cost; the monthly rows are the daily identity aggregated to month-ends, so
 * Σ of the daily P/L over a month equals `nominal_pl` here.
 */
function creditCardMonthPerf(
  accountId: number,
  priorClosing: number | null,
  closing: number,
  fromYmdExclusive: string | null,
  toYmd: string,
  unit: TsUnit
): { netFlow: number; nominal: number; pct: number | null } {
  const financing = perfSheetClpFlowInUnit(
    ccFinancingCostClpBetween(accountId, fromYmdExclusive ?? "", toYmd),
    toYmd,
    unit
  );
  const prior = priorClosing != null && Number.isFinite(priorClosing) ? priorClosing : 0;
  return {
    netFlow: -(closing - prior) + financing,
    nominal: -financing,
    pct: liabilityPctMonth(-financing, prior),
  };
}

/**
 * Mortgage month P/L (in the series unit): CLP amortization on the balance minus payments.
 * Negative = the debt fell less than you paid — the financing cost (interest/fees + UF revaluation).
 */
function mortgageMonthlyNominalPl(
  priorClosing: number,
  closing: number,
  netCapitalFlow: number
): number {
  return priorClosing - closing - netCapitalFlow;
}

/** Debt cost as a rate on the balance carried (both liability kinds). */
function liabilityPctMonth(nominal: number, priorClosing: number): number | null {
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
  // Only an equity account holds share units; the cash wallet a sell's proceeds land in is the
  // to-account of a `stock_sell` row with units, and must not read them as an inflow.
  if (!accountUsesEquityMtm(accountId)) return new Map();
  const shareKinds = ["compra_usd", "stock_buy", "stock_sell"];
  const ph = shareKinds.map(() => "?").join(", ");
  const rows = db
    .prepare(
      `SELECT occurred_on, from_account_id, to_account_id, account_id, units_delta, counter_units_delta
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
    units_delta: number | null;
    counter_units_delta: number | null;
  }[];
  const m = new Map<string, number>();
  for (const r of rows) {
    // The to-leg's own count (`transferToLegUnits`): a fund switch credits what it bought.
    const units =
      r.to_account_id === accountId
        ? (transferToLegUnits(r) ?? 0)
        : r.account_id === accountId
          ? (r.units_delta ?? 0)
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
 * NOT an account's monthly series on its own: the one entry is `monthlyPerfRowsForAccount` /
 * `monthlyPerfForAccountId` (groupMonthlyPerfConsolidation.ts), which sends ledger cash
 * (checking, USD / CLP cash, cuenta de ahorro) to its balance walk and every other account
 * here. Read it directly only to test the valuation-series builder itself, or from this
 * module's own group series (which cannot import that module).
 *
 * Skips **cuenta_corriente** (no P/L framing). Uses **monthly** granularity only (daily chart has no deposit line).
 * The **first** month with a valuation row is included: `prior_closing` is null and `net_capital_flow` equals cumulative
 * aportes at that date (so e.g. VEA’s March 2026 wires appear in March, not folded into April as ΔcumDep=0).
 */
/** @heavy Rebuilds monthly performance from valuation timeseries + capital flows (cached in-process). */
export function valuationSeriesMonthlyPerformance(
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
  // Running totals are not built here: the rows go through the month collapse and the
  // calendar re-anchor, which recompute them (`withRunningPlTotals`).
  const outAsc: AccountMonthlyPerformanceRow[] = [];
  const unitsByMonthEnd = stockUnitsInflowByMonthEnd(accountId);
  const afpCuotasByMonthKey =
    isCuotaLedgerKindSlug(accountBucketKindSlug(bucketSlug)) ? afpPositiveCuotasInflowByMonthKey(accountId) : null;
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
      ? deptoPropertyCloseClpBySnapshotDates(deptoSnapshotDates, deptoLedger, deptoUfClpByDate)
      : null;
  const deptoCloseClpByDate = mortgageCloseClpByDate ?? propertyCloseClpByDate;
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
    // A null deposit cell is a densified filler month (no valuation row, and — since the chart
    // grid adds the month-end of every deposit event — no flow either): cumulative deposits carry.
    // Reading it as 0 while `close` carried the last book value split one flow into a ± couplet
    // across the gap, while the daily series (deposit events) had it right.
    const cumDep: number = numCell(p[depKey]) ?? prevCumDep ?? 0;

    if (prevClose == null) {
      const y = Number(asOf.slice(0, 4));
      if (!Number.isFinite(y)) {
        prevClose = close;
        prevCumDep = cumDep;
        continue;
      }
      /** First month in the series: no prior month-end — net flow = cumulative aportes at this date (vs 0). */
      const ccFirst = isCreditCard
        ? creditCardMonthPerf(accountId, null, close, null, asOf, unit)
        : null;
      const netFlowFirst =
        isMortgage && deptoLedger
          ? perfMortgagePaymentsInUnit(deptoLedger, asOf, null, unit)
          : isDeptoProperty && deptoLedger
            ? perfDeptoPropertyPaymentsInUnit(deptoLedger, asOf, null, unit)
            : ccFirst
              ? ccFirst.netFlow
              : cumDep;
      /** Mortgage: opening balance after pie is not P/L (only cuota-driven changes count). */
      const nominalFirst = isMortgage ? 0 : ccFirst ? ccFirst.nominal : close - netFlowFirst;
      const pctFirst = ccFirst
        ? ccFirst.pct
        : isMortgage
          ? null
          : flowAdjustedPct(nominalFirst, null, netFlowFirst, close, unit);
      outAsc.push({
        as_of_date: asOf,
        closing_value: close,
        prior_closing: null,
        net_capital_flow: netFlowFirst,
        stock_units_inflow: stockUnitsInflowForPerfRow(asOf),
        coin_units_eom: coinUnitsEomForPerfRow(asOf),
        nominal_pl: nominalFirst,
        pct_month: pctFirst,
        ytd_nominal_pl: null,
        cumulative_nominal_pl: null,
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
    const ccPerf = isCreditCard
      ? creditCardMonthPerf(accountId, prevClose, close, prevPerfAsOf, asOf, unit)
      : null;
    if (ccPerf) netFlow = ccPerf.netFlow;
    const nominal = isMortgage
      ? mortgageMonthlyNominalPl(prevClose, close, netFlow)
      : ccPerf
        ? ccPerf.nominal
        : close - prevClose - netFlow;
    const pct = isMortgage
      ? liabilityPctMonth(nominal, prevClose)
      : ccPerf
        ? ccPerf.pct
        : flowAdjustedPct(nominal, prevClose, netFlow, close, unit);

    const y = Number(String(p.as_of_date).slice(0, 4));
    if (!Number.isFinite(y)) {
      prevClose = close;
      prevCumDep = cumDep;
      prevPerfAsOf = asOf;
      continue;
    }
    outAsc.push({
      as_of_date: asOf,
      closing_value: close,
      prior_closing: prevClose,
      net_capital_flow: netFlow,
      stock_units_inflow: stockUnitsInflowForPerfRow(asOf),
      coin_units_eom: coinUnitsEomForPerfRow(asOf),
      nominal_pl: nominal,
      pct_month: pct,
      ytd_nominal_pl: null,
      cumulative_nominal_pl: null,
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
