import {
  valuationSeriesMonthlyPerformance,
  mapMonthlyClosingToChartDates,
  monthEndCloseForAccountInUnit,
  patchOrInsertLiveCurrentMonthPerfRows,
  type AccountMonthlyPerformanceRow,
} from "./accountPerformance.js";
import { accountCountsTowardGroupTotals } from "./accountGroupTotals.js";
import { db } from "./db.js";
import { loadBookValuationsAsc } from "./bookValuations.js";
import { checkingMovementBalanceClpAtCached } from "./checkingCartolaBalances.js";
import {
  monthEndsBetweenInclusive,
  monthKeyFromYmd,
} from "./calendarMonth.js";
import { chileCalendarTodayYmd } from "./chileDate.js";
import { pickMonthlyPerfRowsByMonth } from "./accountPeriodMetrics.js";
import { rollupMonthlyPerfYearly, withRunningPlTotals } from "./monthlyPerfRollup.js";
import { endChargedFlow, flowAdjustedPct, groupStartFrameFlow } from "./periodReturns.js";
import {
  monthEndCloseFromPerfRows,
  priorCalendarMonthKey,
} from "./accountPeriodMarks.js";
import { accountValueClpToUnitAt, convertTs } from "./clpToUnitAt.js";
import { isMovementBalanceCashCategory } from "./movementBalanceCashAccounts.js";
import { netDepositFlowWindows } from "./flowsDeposits.js";
import { isUsdCashKindSlug } from "./movementTransfer.js";
import { usdCashBalanceClpAt, usdCashBalanceUsdAt } from "./usdCashAccounts.js";
import { isClpCashKindSlug, clpCashBalanceClpAt } from "./clpCashAccounts.js";
import { accountBucketKindSlug } from "./accountBucket.js";
import { accountTodayValue } from "./accountTodayValue.js";
import { isCashEqsNwValuationGroupSlug } from "./assetGroupTree.js";
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
  import_key?: string | null;
  exclude_from_group_totals: number;
  /** Long trailing-zero tail; omit from nav child cards only (charts/tables keep the series). */
  chart_inactive?: boolean;
};

/**
 * A ledger balance close in USD at `asOf` (the current month evaluates at Chile today, framed
 * live like the dashboard row; earlier months at the stored fx on or before). NaN without a rate.
 */
function balanceCloseUsdAt(accountId: number, clp: number, asOf: string): number {
  return accountValueClpToUnitAt(accountId, clp, asOf, "usd") ?? Number.NaN;
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
  /**
   * Σ of the net withdrawals of the members that ended the month at zero ({@link endChargedFlow}),
   * uncapped — `pct_month` charges them at the month end up to the group's own net withdrawal
   * ({@link groupStartFrameFlow}). Summed again by the net-worth / inversiones consolidation,
   * which caps the sum with its own net flow (transfers between buckets cancel there).
   */
  end_charged_flow: number;
};

const GROUP_TAB_VAL_TOTAL = "__group_val_total";

function balanceOnlyMonthlyRowsAsc(
  accountId: number,
  categorySlug: string,
  unit: TsUnit,
  monthEndsAsc: string[],
  closeAt: (asOf: string) => number,
  /**
   * Event-based month flow over `(prevEvalYmd, evalYmd]` (null prev = cumulative through the
   * first month, the builder convention): the account's merged deposit events
   * ({@link ledgerCashNetFlowBetween}), each converted at its own date's rate, so fx moves on
   * the balance held are P/L. Every caller passes it (2026-10-28): a balance − cumulative
   * interest delta re-prices the standing balance at each month-end and leaked the month's fx
   * move into the aportes column (the cuenta de ahorro's USD closed months did until then).
   */
  netFlowBetween: (prevEvalYmd: string | null, evalYmd: string) => number
): AccountMonthlyPerformanceRow[] {
  const outAsc: AccountMonthlyPerformanceRow[] = [];
  let prevClose: number | null = null;
  let prevEvalAt: string | null = null;
  const today = chileCalendarTodayYmd();

  for (const asOf of monthEndsAsc) {
    // Current month: evaluate the ledger at Chile-today, never the future month-end —
    // a future-dated movement inside the month must not count until its date arrives
    // (equity MTM only counts units through today; mixing skews consolidated totals).
    const evalAt = asOf > today ? today : asOf;
    const close = closeAt(evalAt);
    if (!Number.isFinite(close)) continue;
    // First month: flow = cumulative aportes at this date (vs 0) and P/L = close − that flow —
    // same convention as the equity/AFP monthly perf builder. A null first P/L dropped the
    // month's fx move on an event-based flow, so the lifetime P/L missed part of what the
    // dashboard card's value − deposits counts.
    const netFlow = netFlowBetween(prevEvalAt, evalAt);
    const nominal = close - (prevClose ?? 0) - netFlow;

    outAsc.push({
      as_of_date: asOf,
      closing_value: close,
      prior_closing: prevClose,
      net_capital_flow: netFlow,
      stock_units_inflow: 0,
      nominal_pl: nominal,
      // The account's own month %, the valuation-series builder's rule (the account page's
      // «Detalle por mes» reads it; the group consolidation computes its own from the sums).
      pct_month: flowAdjustedPct(nominal, prevClose, netFlow, close, unit),
      ytd_nominal_pl: null,
      cumulative_nominal_pl: null,
      unit,
    });
    prevClose = close;
    prevEvalAt = evalAt;
  }
  const withTotals = withRunningPlTotals(outAsc);

  if (isMovementBalanceCashCategory(categorySlug)) {
    return patchOrInsertLiveCurrentMonthPerfRows(accountId, categorySlug, withTotals, unit, () =>
      accountTodayValue(accountId, categorySlug)
    );
  }

  return withTotals;
}

/**
 * Month flow of a ledger cash account (USD cash since 2026-08-04; CLP cash and checking since
 * 2026-09-27): its merged deposit events in `(prevEvalYmd, evalYmd]`, each at its own date's
 * rate (`flowEventInUnit`) — the events the dashboard card's deposits, the daily series and
 * the aportes line read. A month with no events reads 0; fx moves on the balance held are
 * P/L. UF converts the window's CLP sum at the window end.
 */
function ledgerCashNetFlowBetween(
  accountId: number,
  unit: TsUnit
): (prevEvalYmd: string | null, evalYmd: string) => number {
  const windowFlow = netDepositFlowWindows(accountId, unit === "usd" ? "usd" : "clp");
  return (prevEvalYmd, evalYmd) => {
    const raw = windowFlow(prevEvalYmd ?? "0000-01-01", evalYmd);
    return unit === "uf" ? convertTs(raw, evalYmd, "uf") : raw;
  };
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
  const asc = balanceOnlyMonthlyRowsAsc(
    accountId,
    categorySlug,
    unit,
    monthEndsAsc,
    // In USD the account's ledger dollars, never its sell-rate pesos ÷ the mid rate.
    (asOf) => (unit === "usd" ? usdCashBalanceUsdAt(accountId, asOf) : usdCashBalanceClpAt(accountId, asOf)),
    ledgerCashNetFlowBetween(accountId, unit)
  );
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
  const asc = balanceOnlyMonthlyRowsAsc(
    accountId,
    categorySlug,
    unit,
    monthEndsAsc,
    (asOf) => {
      const clp = clpCashBalanceClpAt(accountId, asOf);
      return unit === "usd" ? balanceCloseUsdAt(accountId, clp, asOf) : clp;
    },
    ledgerCashNetFlowBetween(accountId, unit)
  );
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
  const asc = balanceOnlyMonthlyRowsAsc(
    accountId,
    categorySlug,
    unit,
    monthEndsAsc,
    (asOf) => {
      const clp = checkingMovementBalanceClpAtCached(accountId, asOf);
      return unit === "usd" ? balanceCloseUsdAt(accountId, clp, asOf) : clp;
    },
    ledgerCashNetFlowBetween(accountId, unit)
  );
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
  // Month-precision dated (`monthPrecisionAccountKinds.ts`): movements sit on conventional
  // month-ends, the same days as the book rows, so each `(prev month-end, month-end]` window
  // takes its month's deposit exactly once.
  const asc = balanceOnlyMonthlyRowsAsc(
    accountId,
    categorySlug,
    unit,
    monthEndsAsc,
    (asOf) => {
      const clp = clpByDate.get(asOf) ?? 0;
      return unit === "usd" ? balanceCloseUsdAt(accountId, clp, asOf) : clp;
    },
    ledgerCashNetFlowBetween(accountId, unit)
  );

  const patched = patchOrInsertLiveCurrentMonthPerfRows(accountId, categorySlug, asc, unit, () => {
    // The account's one today value, with its real import key and name (read from the account).
    const live = accountTodayValue(accountId, categorySlug);
    return live ?? bookAsc[bookAsc.length - 1]!.value_clp;
  });

  return [...patched].reverse();
}

/**
 * An account's monthly performance rows in `unit` — THE per-account series behind every group
 * table (consolidation) and every dashboard card row (`accountPeriodMetricsFromMonthlyRows`):
 * the valuation-series performance for invested accounts, the ledger-balance walks for cash
 * (checking, USD / CLP cash, cuenta de ahorro). A new reader of an account's month P/L takes
 * these rows; it does not re-derive them.
 */
export function monthlyPerfRowsForAccount(
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
  // By kind, like the other branches: the account's leaf slug is `cash_eqs__cuenta_ahorro_vivienda`,
  // so a bare-slug match never fired and the account fell to the valuation series.
  if (kindSlug === "cuenta_ahorro_vivienda") {
    return bookValuationMonthlyPerfRows(accountId, bucketSlug, unit);
  }
  const perf = valuationSeriesMonthlyPerformance(accountId, unit);
  return perf?.monthly ?? [];
}

/**
 * {@link monthlyPerfRowsForAccount} for a caller holding only the account id (the account page,
 * `GET /api/accounts/:id/performance-monthly`, the export, the benchmark row, tail-inactive
 * detection): looks the leaf bucket up and returns the same rows. Null when the account does
 * not exist.
 */
export function monthlyPerfForAccountId(
  accountId: number,
  unit: TsUnit = "clp"
): {
  account_id: number;
  bucket_slug: string;
  monthly: AccountMonthlyPerformanceRow[];
  /** The «Detalle por año» rows: `monthly` rolled up by year (`rollupMonthlyPerfYearly`). */
  yearly: AccountMonthlyPerformanceRow[];
} | null {
  const row = db
    .prepare(
      `SELECT g.slug AS bucket_slug
       FROM accounts a
       INNER JOIN asset_groups g ON g.id = a.asset_group_id
       WHERE a.id = ?`
    )
    .get(accountId) as { bucket_slug: string } | undefined;
  if (!row) return null;
  const monthly = monthlyPerfRowsForAccount(accountId, row.bucket_slug, unit);
  return {
    account_id: accountId,
    bucket_slug: row.bucket_slug,
    monthly,
    yearly: rollupMonthlyPerfYearly(monthly),
  };
}

export function consolidateGroupMonthlyPerf(
  byAccount: readonly {
    account_id: number;
    bucket_slug: string;
    monthly: readonly AccountMonthlyPerformanceRow[];
    notes?: string | null;
    import_key?: string | null;
    name?: string | null;
  }[],
  unit: TsUnit = "clp"
): ConsolidatedMonthlyPerfRow[] {
  const today = chileCalendarTodayYmd();
  const currentMk = monthKeyFromYmd(today);

  // One picked row per account per month — the same rows `accountPeriodMetricsFromMonthlyRows`
  // sums for the dashboard cards, so a card and this table cannot drift.
  const latestByAccountMonth = new Map<string, AccountMonthlyPerformanceRow>();
  for (const acct of byAccount) {
    for (const [mk, row] of pickMonthlyPerfRowsByMonth(acct.monthly)) {
      latestByAccountMonth.set(`${acct.account_id}:${mk}`, row);
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
        end_charged_flow: 0,
      } satisfies ConsolidatedMonthlyPerfRow);

    if (mk !== currentMk) {
      bucket.as_of_date =
        bucket.as_of_date >= row.as_of_date ? bucket.as_of_date : row.as_of_date;
    }
    bucket.closing_value += row.closing_value;
    bucket.net_capital_flow += row.net_capital_flow;
    bucket.stock_units_inflow += row.stock_units_inflow;
    bucket.end_charged_flow += endChargedFlow(row.net_capital_flow, row.closing_value, unit);
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
      let priorClose = monthEndCloseForAccountInUnit(
        acct.account_id,
        acct.bucket_slug,
        acct.monthly,
        priorMk,
        unit,
        { import_key: acct.import_key ?? null, name: acct.name }
      );
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
      /** Σ per-account picked nominal_pl — the group P/L chart's `delta_total` reads this row (`groupMonthlyPlSeries.ts`). */
      const nominal = bucket.nominal_pl;
      const pct = flowAdjustedPct(
        nominal,
        prior ?? null,
        groupStartFrameFlow(net, bucket.end_charged_flow),
        bucket.closing_value,
        unit
      );
      return { ...bucket, nominal_pl: nominal, pct_month: pct };
    });

  return withRunningPlTotals(asc).reverse();
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
  /** Account identity for the month-end marks (a Fintual certificate account is valued by it). */
  import_key: string | null;
  monthly: AccountMonthlyPerformanceRow[];
}[] {
  const account_monthly: {
    account_id: number;
    name: string;
    bucket_slug: string;
    notes: string | null;
    import_key: string | null;
    monthly: AccountMonthlyPerformanceRow[];
  }[] = [];

  for (const r of rows) {
    if (r.exclude_from_group_totals === 1) continue;
    const seriesId = seriesAccountIdForGroupTab(r, groupSlug);
    if (!accountCountsTowardGroupTotals(seriesId)) continue;
    const monthly = monthlyPerfRowsForAccount(seriesId, r.bucket_slug, unit);
    if (!monthly.length) continue;
    account_monthly.push({
      account_id: seriesId,
      name: r.name,
      bucket_slug: r.bucket_slug,
      notes: r.notes ?? null,
      import_key: r.import_key ?? null,
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
  // The payloads go in whole: the month-end marks need each account's `import_key` (a Fintual
  // certificate account has no mark without it, and its prior close fell back to perf rows
  // already in `unit`, which the USD path then divided by fx a second time).
  const consolidated = consolidateGroupMonthlyPerf(
    buildConsolidationPayloads(rows, groupSlug, unit),
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
