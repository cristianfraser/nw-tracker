import { markJsonResponseCacheable } from "./jsonResponse.js";
import { noteSyncDimmingRead } from "./cacheDependencies.js";
import { DASHBOARD_PAGE_BUNDLE_PREFIX, getAggregationCached, invalidateDashboardPageBundle } from "./aggregationCache.js";
import { chainedGroupPctResolver, withDailyChainedAccountRowPcts } from "./periodPctDailyChain.js";
import { NOTE_STOCKS_LEGACY, type DashboardAccountStats } from "./brokerageAcciones.js";
import { accountChartInactive } from "./accountChartInactive.js";
import { accountBucketKindSlug, isLiabilityAccountId } from "./accountBucket.js";
import {
  accountPeriodMetricsFromMonthlyRows,
  type AccountPeriodMetrics,
} from "./accountPeriodMetrics.js";
import { monthlyPerfRowsForAccount } from "./groupMonthlyPerfConsolidation.js";
import { accountMarkClpAtYmd } from "./accountMarkClpAtYmd.js";
import { accountTodayValue, todayValueInUnit } from "./accountTodayValue.js";
import type { AccountMonthlyPerformanceRow } from "./accountPerformance.js";
import { priorCloseFromPerfRows, priorPeriodEndYmd } from "./accountPeriodMarks.js";
import { fxForLiveMtm } from "./fxRates.js";
import { accountValueClpToUnitAt, clpToUnitAt } from "./clpToUnitAt.js";
import {
  flowsDepositsNetTotalByAccount,
  flowsDepositsNetTotalUsdByAccount,
  netDepositFlowBetween,
} from "./flowsDeposits.js";
import { getAccountPositionMeta, positionSnapshotFromMeta } from "./accountPosition.js";
import { flowAdjustedPct } from "./periodReturns.js";
import { accountIdsWithAnyStaleSyncSource } from "./accountSyncSources.js";
import { syncStatusPayload } from "./globalSyncStale.js";
import { ccFinancingCostBetweenInUnit, ccFinancingCostClpBetween } from "./ccFinancingCostDaily.js";
import { flowEventInUnit } from "./flowsDeposits.js";
import { timeHeavyAsync, HeavyWork } from "./heavyWork.js";
import {
  getDashboardChartShape,
  liabilitiesBreakdownClpAsOf,
  type TsUnit,
} from "./valuationTimeseries.js";
import { chileCalendarAddDays, chileCalendarTodayYmd } from "./chileDate.js";
import { cashSavingsLinkedBalances } from "./cashEqsBucketNet.js";
import { buildDashboardNwBucketTotals } from "./dashboardNwBucketTotals.js";
import { buildNavCardMetricsBySlug } from "./dashboardNavCardMetrics.js";
import { buildNavValueMapPayload } from "./navValueMap.js";
import { getLiabilitiesNavRootNode, getNetWorthNavGroupNode } from "./navTree.js";
import { navContextScope, valueMapSubtree } from "./navContextScope.js";
import { getDashboardLayoutCards } from "./dashboardLayout.js";
import { withAccountValuationTsCache } from "./accountPerformanceContext.js";
import {
  leafPortfolioGroupSlugByAccountIds,
  nwDashboardMetricGroupForAccount,
  withPortfolioGroupIndex,
} from "./portfolioGroupTree.js";
import { mortgageSheetPaymentEventsThroughDate } from "./deptoDividendosLedger.js";
import { loadDeptoLedgerFromMovements } from "./deptoLedgerFromMovements.js";
import { db, dbInTransaction } from "./db.js";

const DASHBOARD_ASSET_METRIC_GROUPS = new Set(["real_estate", "retirement", "brokerage", "cash_eqs"]);

/**
 * A prior close in USD is the same anchor-date mark the CLP figure reads, at that date's stored
 * fx (a USD cash account: its ledger dollars that day, as its perf rows read them); the
 * performance series' month-end close is the fallback for an account with no mark there.
 * The USD frame keeps the peso's move inside P/L on every row, as the consolidated monthly
 * rows do — the dashboard card and the «Detalle por año» table must read the same year P/L.
 */
function priorCloseUsdFromMark(
  accountId: number,
  markClp: number | null | undefined,
  anchorYmd: string,
  fromPerf: number | undefined
): number | undefined {
  if (markClp == null || !Number.isFinite(markClp)) return fromPerf;
  return accountValueClpToUnitAt(accountId, markClp, anchorYmd, "usd") ?? fromPerf;
}

export function listDashboardSourceAccounts(): {
  id: number;
  name: string;
  notes: string | null;
  import_key: string | null;
  exclude_from_group_totals: number;
  bucket_slug: string;
  bucket_label: string;
}[] {
  return db
    .prepare(
      `
      SELECT a.id, a.name, a.notes, a.import_key, a.exclude_from_group_totals,
             g.slug AS bucket_slug, g.label AS bucket_label
      FROM accounts a
      INNER JOIN asset_groups g ON g.id = a.asset_group_id
      WHERE (a.import_key IS NULL OR a.import_key != ?)
        AND g.slug != 'individual_stocks'
      ORDER BY g.sort_order, a.id, a.name
    `
    )
    .all(NOTE_STOCKS_LEGACY) as {
    id: number;
    name: string;
    notes: string | null;
    import_key: string | null;
    exclude_from_group_totals: number;
    bucket_slug: string;
    bucket_label: string;
  }[];
}

type MortgageCardDeposits = {
  total_clp: number;
  total_usd: number | null;
  month_clp: number;
  month_usd: number | null;
  year_clp: number;
  year_usd: number | null;
  day_clp: number;
  day_usd: number | null;
};

/**
 * Aportado on mortgage cards = depto ledger payments (cuotas + prepagos; pie is property
 * capital), not the flows deposit pool — mortgage cash-in carries `flow_kind` mortgage and
 * is excluded there. Null when no ledger (demo/test installs without depto data). USD: each
 * payment at its own date's rate (`flowEventInUnit`), like the performance table's flow.
 */
function computeMortgageCardDeposits(
  includeUsd: boolean,
  todayYmd: string,
  priorMonthEnd: string,
  priorYearEnd: string,
  priorDayAnchor: string | null
): MortgageCardDeposits | null {
  const ledger = loadDeptoLedgerFromMovements();
  if (!ledger.length) return null;
  const events = mortgageSheetPaymentEventsThroughDate(ledger, todayYmd);
  if (!events.length) return null;
  let total_clp = 0;
  let month_clp = 0;
  let year_clp = 0;
  let day_clp = 0;
  let total_usd: number | null = includeUsd ? 0 : null;
  let month_usd: number | null = includeUsd ? 0 : null;
  let year_usd: number | null = includeUsd ? 0 : null;
  let day_usd: number | null = includeUsd ? 0 : null;
  for (const e of events) {
    total_clp += e.pago_clp;
    const inMonth = e.occurred_on > priorMonthEnd;
    const inYear = e.occurred_on > priorYearEnd;
    const inDay = priorDayAnchor != null && e.occurred_on > priorDayAnchor;
    if (inMonth) month_clp += e.pago_clp;
    if (inYear) year_clp += e.pago_clp;
    if (inDay) day_clp += e.pago_clp;
    if (total_usd != null) {
      const usd = flowEventInUnit({ occurred_on: e.occurred_on, amt: e.pago_clp }, "usd");
      total_usd += usd;
      if (inMonth && month_usd != null) month_usd += usd;
      if (inYear && year_usd != null) year_usd += usd;
      if (inDay && day_usd != null) day_usd += usd;
    }
  }
  return { total_clp, total_usd, month_clp, month_usd, year_clp, year_usd, day_clp, day_usd };
}

/**
 * Flow-adjusted period returns from the row's FINAL legs (after the CC/mortgage P/L
 * overrides), via the shared `flowAdjustedPct`; every period closes at the row's current
 * value. Total has no prior close, so it reads P/L acumulado ÷ lifetime deposits (the
 * helper's prior-less frame).
 */
function dashboardRowPeriodPcts(
  row: DashboardAccountStats,
  includeUsd: boolean
): Partial<DashboardAccountStats> {
  const pctIn =
    (unit: TsUnit) =>
    (
      delta: number | null | undefined,
      prior: number | null | undefined,
      flow: number | null | undefined,
      close: number | null | undefined
    ) =>
      flowAdjustedPct(delta ?? null, prior ?? null, flow ?? 0, close ?? null, unit);
  const pctClp = pctIn("clp");
  const pctUsd = pctIn("usd");
  const clp = row.current_value_clp;
  const usd = row.current_value_usd;
  return {
    pct_day_clp: pctClp(row.delta_day_clp, row.prior_day_close_clp, row.deposits_day_clp, clp),
    pct_month_clp: pctClp(row.delta_month_clp, row.prior_month_close_clp, row.deposits_month_clp, clp),
    pct_year_clp: pctClp(row.delta_year_clp, row.prior_year_close_clp, row.deposits_year_clp, clp),
    pct_total_clp: pctClp(row.delta_total_clp, null, row.deposits_clp, clp),
    ...(includeUsd
      ? {
          pct_day_usd: pctUsd(row.delta_day_usd, row.prior_day_close_usd, row.deposits_day_usd, usd),
          pct_month_usd: pctUsd(
            row.delta_month_usd,
            row.prior_month_close_usd,
            row.deposits_month_usd,
            usd
          ),
          pct_year_usd: pctUsd(
            row.delta_year_usd,
            row.prior_year_close_usd,
            row.deposits_year_usd,
            usd
          ),
          pct_total_usd: pctUsd(row.delta_total_usd, null, row.deposits_usd, usd),
        }
      : {}),
  };
}

/**
 * Dashboard nav cards: account rows with balances and P/L metrics (one perf fetch per unit).
 * Cached for the page bundle's lifetime (`dashboard.page_bundle|account_rows|<unit>`) and shared
 * by its three readers — the home bundle, the nav snapshot and an account page's row — which each
 * built them; built afresh inside a transaction. Callers must not mutate the rows.
 *
 * Each row is its own entry (`dashboard.page_bundle|account_row|<id>|<unit>`) on top of the
 * listing's shared inputs (`account_rows_ctx|<unit>`), so a live-quote tick that moves one price
 * rebuilds only the rows that read it (`cacheDependencies.ts`); the list links every row's
 * inputs, goes with any of them, and is reassembled from the rows still cached.
 */
export function buildDashboardAccountRows(includeUsd: boolean): Promise<DashboardAccountStats[]> {
  if (dbInTransaction()) return buildDashboardAccountRowsUncached(includeUsd);
  return cachedWithPageBundleLifetime(`account_rows|${unitKey(includeUsd)}`, () =>
    buildDashboardAccountRowsUncached(includeUsd)
  );
}

/**
 * One account's dashboard row, the same object the full listing holds (shared cache entry), for a
 * page that shows only its own account: building the whole listing read every account's live
 * price, so the account page refetched on every move (`X-Live-Inputs`). Null when the account is
 * not a dashboard source account.
 */
export function buildDashboardAccountRow(accountId: number, includeUsd: boolean): DashboardAccountStats | null {
  return withPortfolioGroupIndex(() =>
    withAccountValuationTsCache(() => {
      const ctx = dashboardAccountRowsContext(includeUsd);
      const a = ctx.accounts.find((x) => x.id === accountId);
      if (!a) return null;
      noteSyncDimmingRead();
      const stale = accountIdsWithAnyStaleSyncSource(syncStatusPayload().stale_dimming).has(a.id);
      const row = pageBundleCachedSync(`account_row|${a.id}|${unitKey(includeUsd)}`, () =>
        buildDashboardAccountRowFor(ctx, a, includeUsd)
      );
      return { ...row, sync_stale: stale };
    })
  );
}

function unitKey(includeUsd: boolean): "usd" | "clp" {
  return includeUsd ? "usd" : "clp";
}

/**
 * `build()` cached for the page bundle's lifetime under `name`, or built afresh inside a
 * transaction (a report-only import reads rows it then rolls back). Synchronous builds only: a
 * build that throws caches nothing.
 */
function pageBundleCachedSync<T>(name: string, build: () => T): T {
  if (dbInTransaction()) return build();
  return getAggregationCached(`${DASHBOARD_PAGE_BUNDLE_PREFIX}${name}`, build);
}

function buildDashboardAccountRowsUncached(includeUsd: boolean): Promise<DashboardAccountStats[]> {
  return withPortfolioGroupIndex(() => withAccountValuationTsCache(() => buildDashboardAccountRowsInner(includeUsd)));
}

type DashboardSourceAccount = ReturnType<typeof listDashboardSourceAccounts>[number];

/** What every row of one listing reads: the accounts, their leaves, lifetime deposits, the anchors. */
type DashboardAccountRowsContext = {
  accounts: DashboardSourceAccount[];
  leafSlugByAccount: ReturnType<typeof leafPortfolioGroupSlugByAccountIds>;
  depositsNetByAccount: ReturnType<typeof flowsDepositsNetTotalByAccount>;
  depositsNetUsdByAccount: ReturnType<typeof flowsDepositsNetTotalUsdByAccount> | null;
  today: string;
  priorMonthEnd: string;
  priorYearEnd: string;
  priorDayYmd: string;
  /** The mortgage card's deposits, once per listing (the mortgage master appears in one summed scope). */
  mortgageCardDeposits: () => MortgageCardDeposits | null;
};

function dashboardAccountRowsContext(includeUsd: boolean): DashboardAccountRowsContext {
  return pageBundleCachedSync(`account_rows_ctx|${unitKey(includeUsd)}`, () => {
    const accounts = listDashboardSourceAccounts();
    const today = chileCalendarTodayYmd();
    const priorMonthEnd = priorPeriodEndYmd("mtd", today);
    const priorYearEnd = priorPeriodEndYmd("ytd", today);
    /**
     * Day window = yesterday (Chile calendar) for every account: marks are flat on each
     * account's closed days, so per-account market calendars fall out of the level delta.
     * Day deltas are always balance-change net of flows (no perf series exists at day grain).
     */
    const priorDayYmd = chileCalendarAddDays(today, -1);
    const computeMortgage = () =>
      computeMortgageCardDeposits(includeUsd, today, priorMonthEnd, priorYearEnd, priorDayYmd);
    // Its own entry, so the row that reads it records what it read; inside a transaction (this
    // context is then not cached) a memo on the context.
    let mortgageMemo: MortgageCardDeposits | null | undefined;
    const mortgageCardDeposits = dbInTransaction()
      ? () => (mortgageMemo === undefined ? (mortgageMemo = computeMortgage()) : mortgageMemo)
      : () => pageBundleCachedSync(`account_rows_mortgage_deposits|${unitKey(includeUsd)}`, computeMortgage);
    return {
      accounts,
      leafSlugByAccount: leafPortfolioGroupSlugByAccountIds(accounts.map((a) => a.id)),
      // Lifetime deposits for the rows whose deposits are not their series' flows (cards, whose
      // flows are not personal capital; a liability or reference account): the asset rows read
      // theirs from their series.
      depositsNetByAccount: flowsDepositsNetTotalByAccount(),
      depositsNetUsdByAccount: includeUsd ? flowsDepositsNetTotalUsdByAccount() : null,
      today,
      priorMonthEnd,
      priorYearEnd,
      priorDayYmd,
      mortgageCardDeposits,
    };
  });
}

async function buildDashboardAccountRowsInner(includeUsd: boolean): Promise<DashboardAccountStats[]> {
  const ctx = dashboardAccountRowsContext(includeUsd);
  // `stale_dimming`, not `stale`: a source waiting on its publisher (Fintual has not published
  // the expected cuota yet, our poll is current) dims its accounts only once the cuota is overdue —
  // from 18:00 Chile until it lands — never before, when the display holds all the publisher has.
  // Read by the list, not the cached rows: a source's status is not a live-quote input, so a row
  // can outlive it. The list reports the read, and a change of the dimmed set drops it
  // (`syncDimmingWatch.ts`); before that it went only when some row did.
  noteSyncDimmingRead();
  const staleAccountIds = accountIdsWithAnyStaleSyncSource(syncStatusPayload().stale_dimming);
  return ctx.accounts.map((a) => {
    const row = pageBundleCachedSync(`account_row|${a.id}|${unitKey(includeUsd)}`, () =>
      buildDashboardAccountRowFor(ctx, a, includeUsd)
    );
    // Overwrites the placeholder in place, so the row's keys keep their order.
    return { ...row, sync_stale: staleAccountIds.has(a.id) };
  });
}

/** One account's dashboard row; `sync_stale` is a placeholder the list sets. */
function buildDashboardAccountRowFor(
  ctx: DashboardAccountRowsContext,
  a: DashboardSourceAccount,
  includeUsd: boolean
): DashboardAccountStats {
  const {
    leafSlugByAccount,
    depositsNetByAccount,
    depositsNetUsdByAccount,
    today,
    priorMonthEnd,
    priorYearEnd,
    priorDayYmd,
    mortgageCardDeposits,
  } = ctx;
  const leafSlug = a.bucket_slug;
  const kindSlug = accountBucketKindSlug(leafSlug);
  const mortgagePayments = kindSlug === "mortgage" ? mortgageCardDeposits() : null;
  const portfolioLeafSlug = leafSlugByAccount.get(a.id) ?? null;
  const metricGroup = nwDashboardMetricGroupForAccount(a.id) ?? leafSlug;
  const dashboard_bucket_slug = nwDashboardMetricGroupForAccount(a.id);
  const trackAssetMetrics = DASHBOARD_ASSET_METRIC_GROUPS.has(metricGroup);
  // The card's deposits and P/L (month, year, lifetime) are read from the same monthly
  // rows the group tables consolidate — one series, one picker, one sum — so the card and
  // the «Detalle por mes / año» table of the same scope agree by construction, in both
  // units (a card's USD year P/L keeps the peso's move inside P/L like every table row).
  // The mortgage and credit-card rows read their P/L from the same rows (the card's is
  // its cost of financing per calendar month, `creditCardMonthPerf`, the account page's
  // «Detalle por mes»); their deposits are not the rows' flows — the mortgage's are the
  // depto ledger's payments, and a card's flows are not personal capital.
  const hasPerfRows =
    trackAssetMetrics || kindSlug === "mortgage" || kindSlug === "credit_card";
  const rowsClp: AccountMonthlyPerformanceRow[] = hasPerfRows
    ? monthlyPerfRowsForAccount(a.id, leafSlug, "clp")
    : [];
  const rowsUsd: AccountMonthlyPerformanceRow[] =
    hasPerfRows && includeUsd ? monthlyPerfRowsForAccount(a.id, leafSlug, "usd") : [];
  const perfClp: AccountPeriodMetrics | null = hasPerfRows
    ? accountPeriodMetricsFromMonthlyRows(rowsClp, today)
    : null;
  const perfUsd: AccountPeriodMetrics | null =
    hasPerfRows && includeUsd ? accountPeriodMetricsFromMonthlyRows(rowsUsd, today) : null;
  const deposits = mortgagePayments
    ? mortgagePayments.total_clp
    : trackAssetMetrics
      ? perfClp!.deposits_total
      : depositsNetByAccount.get(a.id) ?? 0;
  const deposits_usd = mortgagePayments
    ? mortgagePayments.total_usd
    : trackAssetMetrics
      ? perfUsd?.deposits_total ?? null
      : depositsNetUsdByAccount?.get(a.id) ?? null;
  const markOpts = { import_key: a.import_key, name: a.name };

  /** Asset-group leaf slug (`real_estate__property`), not nav bucket (`real_estate`) — required for depto UF marks. */
  const markCategorySlug = leafSlug;

  // Today's value is the account's one today value for every row, liabilities included —
  // the today mark (`accountMarkClpAtYmd` at today reads it too), the account page header,
  // the current month's performance row and the charts' live last point. The position is
  // asked at Chile today and shared with it, so units-priced accounts (cuota ledgers,
  // Fintual cert funds, crypto) are valued by the same position the row shows.
  const positionMeta = getAccountPositionMeta(a.id, kindSlug, {
    afpCuotasAsOfYmd: today,
    accountImportKey: a.import_key,
    accountName: a.name,
  });
  const v = accountTodayValue(a.id, markCategorySlug, { ...markOpts, positionMeta });

  const priorMonthMark = accountMarkClpAtYmd(a.id, priorMonthEnd, markCategorySlug, markOpts);
  const priorYearMark = accountMarkClpAtYmd(a.id, priorYearEnd, markCategorySlug, markOpts);
  // Mortgage and CC track day marks too (daily UF cost; per-day owed) — their title
  // deltas move daily, P/L stays their own convention.
  const rowTracksDayMetrics =
    trackAssetMetrics || kindSlug === "mortgage" || kindSlug === "credit_card";
  const priorDayMark = rowTracksDayMetrics
    ? accountMarkClpAtYmd(a.id, priorDayYmd, markCategorySlug, markOpts)
    : null;
  const prior_day_close_clp = priorDayMark?.value_clp ?? null;
  // Stored fx of the prior day (a USD cash account: its ledger dollars that day).
  const prior_day_close_usd =
    includeUsd && prior_day_close_clp != null
      ? accountValueClpToUnitAt(a.id, prior_day_close_clp, priorDayYmd, "usd", { categorySlug: markCategorySlug })
      : null;
  const deposits_day_clp = mortgagePayments
    ? mortgagePayments.day_clp
    : trackAssetMetrics
      ? netDepositFlowBetween(a.id, priorDayYmd, today, "clp")
      : undefined;
  const deposits_day_usd = mortgagePayments
    ? mortgagePayments.day_usd
    : trackAssetMetrics && includeUsd
      ? netDepositFlowBetween(a.id, priorDayYmd, today, "usd")
      : undefined;
  const prior_month_close_clp =
    priorMonthMark?.value_clp ??
    (trackAssetMetrics ? priorCloseFromPerfRows(rowsClp, "mtd", today) ?? undefined : undefined);
  const prior_year_close_clp =
    priorYearMark?.value_clp ??
    (trackAssetMetrics ? priorCloseFromPerfRows(rowsClp, "ytd", today) ?? undefined : undefined);
  const position = positionSnapshotFromMeta(kindSlug, positionMeta, deposits, v);
  const current_value_clp = v?.value_clp ?? null;
  const valuation_as_of = v?.as_of_date ?? null;
  // The USD frame of the row is the account's value converted once at today's rate and its
  // side (`todayValueInUnit`): a USD cash account reads its ledger dollars, a dollar stock its
  // shares × dollar price, a peso value its pesos at the buy rate (a debt at the sell rate).
  // The perf live row and the charts' live point read the same value, so the card, its table
  // and its chart agree. `fx_*` below only report the rate of the day the price was observed.
  const fxRow = includeUsd ? fxForLiveMtm(v?.priced_on ?? null) : null;
  const current_value_usd = includeUsd && v != null ? todayValueInUnit(a.id, v, "usd") : null;
  const fx_missing =
    includeUsd &&
    ((current_value_clp != null && current_value_usd == null) ||
      (deposits !== 0 && deposits_usd == null));
  // Day Δ = live value vs day-anchor close net of day flows — same identity the daily
  // series uses (pl = delta − flow), so cards and the daily view agree. Both liabilities
  // keep the loss-negative convention (prior − close − payments, as the monthly
  // nominal_pl): a UF uptick is a daily financing loss on the mortgage, an amortizing
  // cuota nets interest+seguros. A card's day cost is the intereses/comisiones charged
  // that day (`ccFinancingCostDaily.ts`) — its purchases and PAGOs are flows, so they
  // cancel out and most days read 0 — and the fx revaluation of what it owes in another
  // currency; in dollars the same cost in dollars (`ccFinancingCostByDateInUnit`), the map its
  // monthly rows sum, so the day and the month share one frame.
  const isMortgageRow = kindSlug === "mortgage";
  const isCcRow = kindSlug === "credit_card";
  const ccDayFinancingClp = isCcRow ? ccFinancingCostClpBetween(a.id, priorDayYmd, today) : 0;
  const delta_day_clp = isCcRow
    ? -ccDayFinancingClp
    : current_value_clp != null && prior_day_close_clp != null
      ? isMortgageRow
        ? prior_day_close_clp - current_value_clp - (deposits_day_clp ?? 0)
        : current_value_clp - prior_day_close_clp - (deposits_day_clp ?? 0)
      : null;
  const delta_day_usd = isCcRow
    ? includeUsd
      ? -ccFinancingCostBetweenInUnit(a.id, priorDayYmd, today, "usd")
      : null
    : includeUsd && current_value_usd != null && prior_day_close_usd != null
      ? isMortgageRow
        ? prior_day_close_usd - current_value_usd - (deposits_day_usd ?? 0)
        : current_value_usd - prior_day_close_usd - (deposits_day_usd ?? 0)
      : null;
  const baseRow = {
    account_id: a.id,
    name: a.name,
    group_slug: portfolioLeafSlug ?? leafSlug,
    group_label: a.bucket_label,
    bucket_slug: leafSlug,
    bucket_label: a.bucket_label,
    dashboard_bucket_slug: dashboard_bucket_slug ?? null,
    deposits_clp: deposits,
    deposits_usd: includeUsd ? deposits_usd : undefined,
    delta_month_clp: perfClp?.delta_month ?? null,
    delta_month_usd: includeUsd ? perfUsd?.delta_month ?? null : undefined,
    delta_year_clp: perfClp?.delta_year ?? null,
    delta_year_usd: includeUsd ? perfUsd?.delta_year ?? null : undefined,
    delta_total_clp: perfClp?.delta_total ?? null,
    delta_total_usd: includeUsd ? perfUsd?.delta_total ?? null : undefined,
    deposits_month_clp: mortgagePayments
      ? mortgagePayments.month_clp
      : trackAssetMetrics
        ? perfClp!.deposits_month
        : undefined,
    deposits_month_usd: mortgagePayments
      ? mortgagePayments.month_usd
      : trackAssetMetrics
        ? perfUsd?.deposits_month ?? null
        : undefined,
    deposits_year_clp: mortgagePayments
      ? mortgagePayments.year_clp
      : trackAssetMetrics
        ? perfClp!.deposits_year
        : undefined,
    deposits_year_usd: mortgagePayments
      ? mortgagePayments.year_usd
      : trackAssetMetrics
        ? perfUsd?.deposits_year ?? null
        : undefined,
    deposits_day_clp,
    deposits_day_usd: includeUsd ? deposits_day_usd : undefined,
    delta_day_clp,
    delta_day_usd: includeUsd ? delta_day_usd : undefined,
    prior_day_close_clp,
    prior_day_close_usd: includeUsd ? prior_day_close_usd : undefined,
    prior_month_close_clp,
    prior_month_close_usd: includeUsd
      ? priorCloseUsdFromMark(
          a.id,
          priorMonthMark?.value_clp,
          priorMonthEnd,
          trackAssetMetrics ? priorCloseFromPerfRows(rowsUsd, "mtd", today) ?? undefined : undefined
        )
      : undefined,
    prior_year_close_clp,
    prior_year_close_usd: includeUsd
      ? priorCloseUsdFromMark(
          a.id,
          priorYearMark?.value_clp,
          priorYearEnd,
          trackAssetMetrics ? priorCloseFromPerfRows(rowsUsd, "ytd", today) ?? undefined : undefined
        )
      : undefined,
    current_value_clp,
    valuation_as_of,
    current_value_usd,
    fx_clp_per_usd: fxRow?.clp_per_usd ?? null,
    fx_date_used: fxRow?.date ?? null,
    fx_missing: includeUsd ? fx_missing : undefined,
    notes: a.notes ?? null,
    exclude_from_group_totals: a.exclude_from_group_totals,
    chart_inactive: accountChartInactive(a.id),
    position,
    // Placeholder: the listing sets it (see buildDashboardAccountRowsInner).
    sync_stale: false,
  };
  const row = baseRow as DashboardAccountStats;
  const withPcts = { ...row, ...dashboardRowPeriodPcts(row, includeUsd) };
  // Every period % is the account's daily returns compounded (periodPctDailyChain.ts); the
  // one-step Total stays as `pct_total_on_deposits_*`. Row by row: each reads only its own
  // account's daily series.
  return withDailyChainedAccountRowPcts([withPcts], includeUsd, isLiabilityAccountId)[0]!;
}

/**
 * Nav cards strip + account detail row lookup (no full dashboard totals/charts). Cached with the
 * page bundle's lifetime (`dashboard.page_bundle|nav_snapshot|<unit>`): every invalidation that
 * drops the bundle drops it, so it is what a fresh build would answer; the cached value is the
 * in-flight promise, and a rejected build evicts itself.
 */
export function buildDashboardNavSnapshot(includeUsd: boolean): ReturnType<typeof buildDashboardNavSnapshotUncached> {
  return cachedWithPageBundleLifetime(`nav_snapshot|${includeUsd ? "usd" : "clp"}`, () =>
    buildDashboardNavSnapshotUncached(includeUsd)
  );
}

function cachedWithPageBundleLifetime<T>(name: string, build: () => Promise<T>): Promise<T> {
  return getAggregationCached(`${DASHBOARD_PAGE_BUNDLE_PREFIX}${name}`, () => {
    const built = build().then(markJsonResponseCacheable);
    built.catch(() => invalidateDashboardPageBundle());
    return built;
  });
}

/** @heavy One {@link monthlyPerfRowsForAccount} per unit per tracked account (via {@link buildDashboardAccountRows}). */
async function buildDashboardNavSnapshotUncached(includeUsd: boolean) {
  const rowsBuilt = await buildDashboardAccountRows(includeUsd);
  const clientAccounts = rowsBuilt.map(({ notes, ...rest }) => ({
    ...rest,
    notes: notes ?? null,
  }));
  const asOfToday = chileCalendarTodayYmd();
  const liabilitiesClp = liabilitiesBreakdownClpAsOf(asOfToday);
  const liabilities_breakdown = {
    mortgage_clp: liabilitiesClp.mortgage_clp,
    credit_card_clp: liabilitiesClp.credit_card_clp,
    // Balances owed today, at today's mid (live while the fx day is open), as every USD value
    // on the page — never the buy rate deposit events use.
    mortgage_usd: clpToUnitAt(liabilitiesClp.mortgage_clp, asOfToday, "usd", { side: "debt" }),
    credit_card_usd: clpToUnitAt(liabilitiesClp.credit_card_clp, asOfToday, "usd", { side: "debt" }),
  };
  const dashboard_layout = getDashboardLayoutCards().map((card) =>
    card.slug === "cash_eqs"
      ? {
          ...card,
          linked_balances: cashSavingsLinkedBalances(asOfToday, includeUsd),
        }
      : card
  );
  const nw_bucket_totals = buildDashboardNwBucketTotals(includeUsd);
  // Nav-strip card metrics, precomputed server-side (see dashboardNavCardMetrics.ts).
  // The Pasivos page renders nav nodes from the liabilities root (DB-driven liability_groups
  // children), so both trees get entries; the liabilities root wins the shared `liabilities` slug.
  const navRoot = getNetWorthNavGroupNode();
  if (!navRoot) throw new Error("nav snapshot: net_worth nav tree missing");
  const liabilitiesRoot = getLiabilitiesNavRootNode();
  if (!liabilitiesRoot) throw new Error("nav snapshot: liabilities nav tree missing");
  const chainedGroupPct = chainedGroupPctResolver(rowsBuilt, includeUsd, isLiabilityAccountId);
  const card_metrics_by_slug = buildNavCardMetricsBySlug({
    navRoots: [navRoot, liabilitiesRoot],
    rows: rowsBuilt,
    bucketTotals: nw_bucket_totals,
    chainedGroupPct,
  });
  return {
    accounts: clientAccounts,
    liabilities_breakdown,
    dashboard_layout,
    nw_bucket_totals,
    card_metrics_by_slug,
    ...buildNavValueMapPayload(rowsBuilt, includeUsd, chainedGroupPct),
    chart_shape: getDashboardChartShape(),
  };
}

/**
 * The nav strip's payload for one group, Pasivos or account page (`GET /api/dashboard/nav-context`),
 * cut to what that page can draw ({@link navContextScope}): the card figures, account rows and value
 * map of its node, the groups it hosts and the liability accounts. The bucket totals, layout and
 * liabilities breakdown are whole (small, read by the strip's totals and footers).
 */
export function buildDashboardNavContext(
  includeUsd: boolean,
  unit: TsUnit,
  rootSlug: string
): ReturnType<typeof buildDashboardNavContextInner> {
  return cachedWithPageBundleLifetime(`nav_context|${includeUsd ? "usd" : "clp"}|${unit}|${rootSlug}`, () =>
    withPortfolioGroupIndex(() => buildDashboardNavContextInner(includeUsd, rootSlug))
  );
}

async function buildDashboardNavContextInner(includeUsd: boolean, rootSlug: string) {
  const nav = await timeHeavyAsync(HeavyWork.navContext, () => buildDashboardNavSnapshot(includeUsd));
  const navRoot = getNetWorthNavGroupNode();
  if (!navRoot) throw new Error("nav-context: net_worth nav tree missing");
  const liabilitiesRoot = getLiabilitiesNavRootNode();
  if (!liabilitiesRoot) throw new Error("nav-context: liabilities nav tree missing");
  const scope = navContextScope(rootSlug, [liabilitiesRoot, navRoot], liabilitiesRoot);
  return {
    accounts: nav.accounts.filter((a) => scope.accountIds.has(a.account_id)),
    liabilities_breakdown: nav.liabilities_breakdown,
    dashboard_layout: nav.dashboard_layout,
    nw_bucket_totals: nav.nw_bucket_totals,
    card_metrics_by_slug: Object.fromEntries(
      Object.entries(nav.card_metrics_by_slug).filter(([slug]) => scope.slugs.has(slug))
    ),
    value_map: valueMapSubtree(nav.value_map, rootSlug),
    value_map_color_bounds: nav.value_map_color_bounds,
  };
}
