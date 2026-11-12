import { DTO_SCHEMA_VERSIONS } from "nw-tracker-contracts/dto/schemaVersions";
import { noteSyncDimmingRead } from "./cacheDependencies.js";
import { cacheKeyDashboardAccountRows, cacheKeyDashboardNav } from "./cacheFamilies.js";
import { getAggregationCached } from "./cacheRegistry.js";
import { chainedGroupPctResolver, withDailyChainedAccountRowPcts } from "./periodPctDailyChain.js";
import { NOTE_STOCKS_LEGACY, type DashboardAccountStats } from "./brokerageAcciones.js";
import { accountChartInactive } from "./accountChartInactive.js";
import { accountBucketKindSlug } from "./accountBucket.js";
import { accountIsDebt } from "./accountProfile.js";
import { isPropertyKind } from "./accountRowProfileFields.js";
import { loanAccountIdOfProperty } from "./accountRoles.js";
import { isInvestmentPerformanceAccount } from "./portfolioGroupTree.js";
import {
  accountPeriodMetricsFromMonthlyRows,
  type AccountPeriodMetrics,
} from "./accountPeriodMetrics.js";
import { monthlyPerfRowsForAccount } from "./groupMonthlyPerfConsolidation.js";
import { accountMarkClpAtYmd } from "./accountMarkClpAtYmd.js";
import { accountTodayValue, todayValueInUnit } from "./accountTodayValue.js";
import type { AccountMonthlyPerformanceRow } from "./accountPerformance.js";
import { priorCloseFromPerfRows, priorPeriodEndYmd } from "./accountPeriodMarks.js";
import { accountValueClpToUnitAt, clpToUnitAt } from "./clpToUnitAt.js";
import {
  flowsDepositsNetTotalByAccount,
  listDepositFlowAccounts,
  netDepositFlowBetween,
} from "./flowsDeposits.js";
import { loadMergedDisplayDepositInflowEvents } from "./accountDeposits.js";
import { getAccountPositionMeta } from "./accountPosition.js";
import { positionSnapshotInUnit } from "./accountPositionInUnit.js";
import { flowAdjustedPct } from "./periodReturns.js";
import { accountIdsWithAnyStaleSyncSource } from "./accountSyncSources.js";
import { syncStatusPayload } from "./globalSyncStale.js";
import { ccFinancingCostBetweenInUnit } from "./ccFinancingCostDaily.js";
import { flowEventInUnit } from "./rates.js";
import { timeHeavyAsync, HeavyWork } from "./heavyWork.js";
import {
  getDashboardChartShape,
  liabilitiesBreakdownClpAsOf,
  type TsUnit,
} from "./valuationTimeseries.js";
import { chileCalendarAddDays, chileCalendarTodayYmd } from "./chileDate.js";
import { cashSavingsLinkedBalances, groupNetsLinkedCards } from "./cashEqsBucketNet.js";
import { buildDashboardNwBucketTotals } from "./dashboardNwBucketTotals.js";
import { buildNavCardMetricsBySlug } from "./dashboardNavCardMetrics.js";
import { buildNavValueMapPayload } from "./navValueMap.js";
import { getLiabilitiesNavRootNode, getNetWorthNavGroupNode } from "./navTree.js";
import { navContextScope, valueMapSubtree } from "./navContextScope.js";
import { getDashboardLayoutCards } from "./dashboardLayout.js";
import { withAccountValuationTsCache } from "./accountPerformanceContext.js";
import {
  leafPortfolioGroupSlugByAccountIds,
  withPortfolioGroupIndex,
} from "./portfolioGroupTree.js";
import { bucketOfAccount, isNwBucketSlug } from "./navTreeModel.js";
import { mortgageSheetPaymentEventsThroughDate } from "./deptoDividendosLedger.js";
import { deptoLedgerForAccount } from "./deptoLedgerFromMovements.js";
import { db, dbInTransaction } from "./db.js";

/**
 * A prior close in the unit is the same anchor-date mark the CLP figure reads, converted at that
 * date's stored rate and the account's side (a USD cash account: its ledger dollars that day, as
 * its perf rows read them); the performance series' month-end close is the fallback for an
 * account with no mark there. The unit's frame keeps the peso's move inside P/L on every row, as
 * the consolidated monthly rows do — the dashboard card and the «Detalle por año» table must read
 * the same year P/L.
 */
function priorCloseInUnitFromMark(
  accountId: number,
  markClp: number | null | undefined,
  anchorYmd: string,
  unit: TsUnit,
  fromPerf: number | undefined
): number | undefined {
  if (markClp == null || !Number.isFinite(markClp)) return fromPerf;
  return accountValueClpToUnitAt(accountId, markClp, anchorYmd, unit) ?? fromPerf;
}

/**
 * A missing leg of a sum: pesos are the ledger's own unit, every row carries them, so a row
 * without one counts zero; in any other unit it is a missing conversion (null).
 */
function missingLegIn(unit: TsUnit): 0 | null {
  return unit === "clp" ? 0 : null;
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
  total: number;
  month: number;
  year: number;
  day: number;
};

/**
 * Aportado on mortgage cards = depto ledger payments (cuotas + prepagos; pie is property
 * capital), not the flows deposit pool — mortgage cash-in carries `flow_kind` mortgage and
 * is excluded there. Null when no ledger (demo/test installs without depto data). In the unit:
 * each payment at its own date's rate (`flowEventInUnit`), like the performance table's flow.
 */
function computeMortgageCardDeposits(
  loanAccountId: number,
  unit: TsUnit,
  todayYmd: string,
  priorMonthEnd: string,
  priorYearEnd: string,
  priorDayAnchor: string | null
): MortgageCardDeposits | null {
  const ledger = deptoLedgerForAccount(loanAccountId);
  if (!ledger.length) return null;
  const events = mortgageSheetPaymentEventsThroughDate(ledger, todayYmd);
  if (!events.length) return null;
  const out: MortgageCardDeposits = { total: 0, month: 0, year: 0, day: 0 };
  for (const e of events) {
    const v = flowEventInUnit({ occurred_on: e.occurred_on, amt: e.pago_clp }, unit);
    out.total += v;
    if (e.occurred_on > priorMonthEnd) out.month += v;
    if (e.occurred_on > priorYearEnd) out.year += v;
    if (priorDayAnchor != null && e.occurred_on > priorDayAnchor) out.day += v;
  }
  return out;
}

/**
 * Net deposits per account in the unit (each event at its own date's rate — `flowEventInUnit`),
 * over the flows deposits page's accounts: the lifetime deposits of the rows whose deposits are
 * not their series' flows.
 */
function netDepositsByAccountInUnit(unit: TsUnit): Map<number, number> {
  if (unit === "clp") return flowsDepositsNetTotalByAccount();
  const accounts = listDepositFlowAccounts(true);
  const eventsByAccount = loadMergedDisplayDepositInflowEvents(accounts.map((a) => a.account_id));
  const totals = new Map<number, number>();
  for (const acc of accounts) {
    let sum = 0;
    for (const e of eventsByAccount.get(acc.account_id) ?? []) {
      if (e.amt === 0) continue;
      sum += flowEventInUnit(e, unit);
    }
    totals.set(acc.account_id, sum);
  }
  return totals;
}

/**
 * Flow-adjusted period returns from the row's FINAL legs (after the CC/mortgage P/L
 * overrides), via the shared `flowAdjustedPct`; every period closes at the row's current
 * value. Total has no prior close, so it reads P/L acumulado ÷ lifetime deposits (the
 * helper's prior-less frame).
 */
function dashboardRowPeriodPcts(frame: RowFrame, unit: TsUnit): Partial<DashboardAccountStats> {
  const pct = (
    delta: number | null | undefined,
    prior: number | null | undefined,
    flow: number | null | undefined
  ) => flowAdjustedPct(delta ?? null, prior ?? null, flow ?? 0, frame.current_value ?? null, unit);
  return {
    pct_day: pct(frame.delta_day, frame.prior_day_close, frame.deposits_day),
    pct_month: pct(frame.delta_month, frame.prior_month_close, frame.deposits_month),
    pct_year: pct(frame.delta_year, frame.prior_year_close, frame.deposits_year),
    pct_total: pct(frame.delta_total, null, frame.deposits),
  };
}

/** A dashboard row as the API sends it: the server-only peso basis left out. */
export type DashboardAccountRowDto = Omit<DashboardAccountStats, "clp_basis">;

export function dashboardAccountRowDto(row: DashboardAccountStats): DashboardAccountRowDto {
  const { clp_basis: _basis, ...rest } = row;
  return rest;
}

/**
 * Dashboard nav cards: account rows with balances and P/L metrics in `unit` (one perf fetch per
 * unit, plus the pesos the structural rules read). Cached for the page bundle's lifetime
 * (`dashboard.page_bundle|account_rows|<unit>`) and shared by its three readers — the home
 * bundle, the nav snapshot and an account page's row — which each built them; built afresh
 * inside a transaction. Callers must not mutate the rows.
 *
 * Each row is its own entry (`dashboard.page_bundle|account_row|<id>|<unit>`) on top of the
 * listing's shared inputs (`account_rows_ctx|<unit>`), so a live-quote tick that moves one price
 * rebuilds only the rows that read it (`cacheDependencies.ts`); the list links every row's
 * inputs, goes with any of them, and is reassembled from the rows still cached.
 */
export function buildDashboardAccountRows(unit: TsUnit): Promise<DashboardAccountStats[]> {
  return getAggregationCached(cacheKeyDashboardAccountRows(`account_rows|${unit}`), () =>
    buildDashboardAccountRowsUncached(unit)
  );
}

/**
 * One account's dashboard row (as sent), the same object the full listing holds (shared cache
 * entry), for a page that shows only its own account: building the whole listing read every
 * account's live price, so the account page refetched on every move (`X-Live-Inputs`). Null when
 * the account is not a dashboard source account.
 */
export function buildDashboardAccountRow(accountId: number, unit: TsUnit): DashboardAccountRowDto | null {
  return withPortfolioGroupIndex(() =>
    withAccountValuationTsCache(() => {
      const ctx = dashboardAccountRowsContext(unit);
      const a = ctx.accounts.find((x) => x.id === accountId);
      if (!a) return null;
      noteSyncDimmingRead();
      const stale = accountIdsWithAnyStaleSyncSource(syncStatusPayload().stale_dimming).has(a.id);
      const row = pageBundleCachedSync(`account_row|${a.id}|${unit}`, () =>
        buildDashboardAccountRowFor(ctx, a, unit)
      );
      return dashboardAccountRowDto({ ...row, sync_stale: stale });
    })
  );
}

/**
 * `build()` cached with the account rows (`dashboard_account_rows` family: built afresh inside a
 * transaction, where a report-only import reads rows it then rolls back).
 */
function pageBundleCachedSync<T>(name: `account_row${string}`, build: () => T): T {
  return getAggregationCached(cacheKeyDashboardAccountRows(name), build);
}

function buildDashboardAccountRowsUncached(unit: TsUnit): Promise<DashboardAccountStats[]> {
  return withPortfolioGroupIndex(() => withAccountValuationTsCache(() => buildDashboardAccountRowsInner(unit)));
}

type DashboardSourceAccount = ReturnType<typeof listDashboardSourceAccounts>[number];

/** What every row of one listing reads: the accounts, their leaves, lifetime deposits, the anchors. */
type DashboardAccountRowsContext = {
  unit: TsUnit;
  accounts: DashboardSourceAccount[];
  leafSlugByAccount: ReturnType<typeof leafPortfolioGroupSlugByAccountIds>;
  /** Lifetime net deposits per account in pesos (the basis) and in the unit. */
  depositsNetClpByAccount: Map<number, number>;
  depositsNetByAccount: Map<number, number>;
  today: string;
  priorMonthEnd: string;
  priorYearEnd: string;
  priorDayYmd: string;
  /** A mortgage card's deposits in a unit (its own property's ledger), once per listing, loan and unit. */
  mortgageCardDeposits: (loanAccountId: number, unit: TsUnit) => MortgageCardDeposits | null;
};

function dashboardAccountRowsContext(unit: TsUnit): DashboardAccountRowsContext {
  return pageBundleCachedSync(`account_rows_ctx|${unit}`, () => {
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
    const computeMortgage = (loanAccountId: number, u: TsUnit) =>
      computeMortgageCardDeposits(loanAccountId, u, today, priorMonthEnd, priorYearEnd, priorDayYmd);
    // Its own entry per loan and unit, so the row that reads it records what it read; inside a
    // transaction (this context is then not cached) a memo on the context.
    const mortgageMemo = new Map<string, MortgageCardDeposits | null>();
    const mortgageCardDeposits = dbInTransaction()
      ? (loanAccountId: number, u: TsUnit) => {
          const key = `${loanAccountId}|${u}`;
          if (!mortgageMemo.has(key)) mortgageMemo.set(key, computeMortgage(loanAccountId, u));
          return mortgageMemo.get(key)!;
        }
      : (loanAccountId: number, u: TsUnit) =>
          pageBundleCachedSync(`account_rows_mortgage_deposits|${loanAccountId}|${u}`, () =>
            computeMortgage(loanAccountId, u)
          );
    // Lifetime deposits for the rows whose deposits are not their series' flows (cards, whose
    // flows are not personal capital; a liability or reference account): the asset rows read
    // theirs from their series.
    const depositsNetClpByAccount = flowsDepositsNetTotalByAccount();
    return {
      unit,
      accounts,
      leafSlugByAccount: leafPortfolioGroupSlugByAccountIds(accounts.map((a) => a.id)),
      depositsNetClpByAccount,
      depositsNetByAccount: unit === "clp" ? depositsNetClpByAccount : netDepositsByAccountInUnit(unit),
      today,
      priorMonthEnd,
      priorYearEnd,
      priorDayYmd,
      mortgageCardDeposits,
    };
  });
}

async function buildDashboardAccountRowsInner(unit: TsUnit): Promise<DashboardAccountStats[]> {
  const ctx = dashboardAccountRowsContext(unit);
  // `stale_dimming`, not `stale`: a source waiting on its publisher (Fintual has not published
  // the expected cuota yet, our poll is current) dims its accounts only once the cuota is overdue —
  // from 18:00 Chile until it lands — never before, when the display holds all the publisher has.
  // Read by the list, not the cached rows: a source's status is not a live-quote input, so a row
  // can outlive it. The list reports the read, and a change of the dimmed set drops it
  // (`syncDimmingWatch.ts`); before that it went only when some row did.
  noteSyncDimmingRead();
  const staleAccountIds = accountIdsWithAnyStaleSyncSource(syncStatusPayload().stale_dimming);
  return ctx.accounts.map((a) => {
    const row = pageBundleCachedSync(`account_row|${a.id}|${unit}`, () => buildDashboardAccountRowFor(ctx, a, unit));
    // Overwrites the placeholder in place, so the row's keys keep their order.
    return { ...row, sync_stale: staleAccountIds.has(a.id) };
  });
}

/** One row's money fields in one unit (see {@link buildDashboardAccountRowFor}). */
type RowFrame = {
  deposits: number | null;
  delta_month: number | null;
  delta_year: number | null;
  delta_total: number | null;
  deposits_month: number | null | undefined;
  deposits_year: number | null | undefined;
  deposits_day: number | null | undefined;
  delta_day: number | null;
  prior_day_close: number | null;
  prior_month_close: number | null | undefined;
  prior_year_close: number | null | undefined;
  current_value: number | null;
};

/** One account's dashboard row; `sync_stale` is a placeholder the list sets. */
function buildDashboardAccountRowFor(
  ctx: DashboardAccountRowsContext,
  a: DashboardSourceAccount,
  unit: TsUnit
): DashboardAccountStats {
  const { leafSlugByAccount, today, priorMonthEnd, priorYearEnd, priorDayYmd, mortgageCardDeposits } = ctx;
  const leafSlug = a.bucket_slug;
  const kindSlug = accountBucketKindSlug(leafSlug);
  const isMortgageRow = kindSlug === "mortgage";
  const isCcRow = kindSlug === "credit_card";
  const portfolioLeafSlug = leafSlugByAccount.get(a.id) ?? null;
  const dashboard_bucket_slug = bucketOfAccount(a.id);
  const metricGroup = dashboard_bucket_slug ?? leafSlug;
  const trackAssetMetrics = isNwBucketSlug(metricGroup);
  // The card's deposits and P/L (month, year, lifetime) are read from the same monthly
  // rows the group tables consolidate — one series, one picker, one sum — so the card and
  // the «Detalle por mes / año» table of the same scope agree by construction, in every
  // unit (a card's USD year P/L keeps the peso's move inside P/L like every table row).
  // The mortgage and credit-card rows read their P/L from the same rows (the card's is
  // its cost of financing per calendar month, `creditCardMonthPerf`, the account page's
  // «Detalle por mes»); their deposits are not the rows' flows — the mortgage's are the
  // depto ledger's payments, and a card's flows are not personal capital.
  const hasPerfRows = trackAssetMetrics || accountIsDebt(a.id);

  // Today's value is the account's one today value for every row, liabilities included —
  // the today mark (`accountMarkClpAtYmd` at today reads it too), the account page header,
  // the current month's performance row and the charts' live last point. The position is
  // asked at Chile today and shared with it, so units-priced accounts (cuota ledgers,
  // Fintual cert funds, crypto) are valued by the same position the row shows.
  const positionMeta = getAccountPositionMeta(a.id, { asOfYmd: today });
  const v = accountTodayValue(a.id, { positionMeta });

  const priorMonthMark = accountMarkClpAtYmd(a.id, priorMonthEnd);
  const priorYearMark = accountMarkClpAtYmd(a.id, priorYearEnd);
  // Mortgage and CC track day marks too (daily UF cost; per-day owed) — their title
  // deltas move daily, P/L stays their own convention.
  const rowTracksDayMetrics = trackAssetMetrics || accountIsDebt(a.id);
  const priorDayMark = rowTracksDayMetrics ? accountMarkClpAtYmd(a.id, priorDayYmd) : null;
  const priorDayClp = priorDayMark?.value_clp ?? null;

  /** The row's money fields in `u`: pesos as the ledger states them, any other unit converted. */
  const frameIn = (u: TsUnit): RowFrame => {
    const mortgagePayments = isMortgageRow ? mortgageCardDeposits(a.id, u) : null;
    const rows: AccountMonthlyPerformanceRow[] = hasPerfRows ? monthlyPerfRowsForAccount(a.id, leafSlug, u) : [];
    const perf: AccountPeriodMetrics | null = hasPerfRows ? accountPeriodMetricsFromMonthlyRows(rows, today) : null;
    const depositsNet = u === ctx.unit ? ctx.depositsNetByAccount : ctx.depositsNetClpByAccount;
    const deposits = mortgagePayments
      ? mortgagePayments.total
      : trackAssetMetrics
        ? perf?.deposits_total ?? missingLegIn(u)
        : depositsNet.get(a.id) ?? missingLegIn(u);
    // Yesterday's stored rate (a USD cash account: its ledger dollars that day).
    const prior_day_close = priorDayClp != null ? accountValueClpToUnitAt(a.id, priorDayClp, priorDayYmd, u) : null;
    const deposits_day = mortgagePayments
      ? mortgagePayments.day
      : trackAssetMetrics
        ? netDepositFlowBetween(a.id, priorDayYmd, today, u)
        : undefined;
    // The unit's frame of the row is the account's value converted once at today's rate and its
    // side (`todayValueInUnit`): a USD cash account reads its ledger dollars, a dollar stock its
    // shares × dollar price, a peso value its pesos at the buy rate (a debt at the sell rate).
    // The perf live row and the charts' live point read the same value, so the card, its table
    // and its chart agree.
    const current_value = v != null ? todayValueInUnit(a.id, v, u) : null;
    // Day Δ = live value vs day-anchor close net of day flows — same identity the daily
    // series uses (pl = delta − flow), so cards and the daily view agree. Both liabilities
    // keep the loss-negative convention (prior − close − payments, as the monthly
    // nominal_pl): a UF uptick is a daily financing loss on the mortgage, an amortizing
    // cuota nets interest+seguros. A card's day cost is the intereses/comisiones charged
    // that day (`ccFinancingCostDaily.ts`) — its purchases and PAGOs are flows, so they
    // cancel out and most days read 0 — and the fx revaluation of what it owes in another
    // currency; in another unit the same cost in it (`ccFinancingCostBetweenInUnit`), the map
    // its monthly rows sum, so the day and the month share one frame.
    const delta_day = isCcRow
      ? -ccFinancingCostBetweenInUnit(a.id, priorDayYmd, today, u)
      : current_value != null && prior_day_close != null
        ? isMortgageRow
          ? prior_day_close - current_value - (deposits_day ?? 0)
          : current_value - prior_day_close - (deposits_day ?? 0)
        : null;
    const fromPerf = (period: "mtd" | "ytd") =>
      trackAssetMetrics ? priorCloseFromPerfRows(rows, period, today) ?? undefined : undefined;
    return {
      deposits,
      delta_month: perf?.delta_month ?? null,
      delta_year: perf?.delta_year ?? null,
      delta_total: perf?.delta_total ?? null,
      deposits_month: mortgagePayments
        ? mortgagePayments.month
        : trackAssetMetrics
          ? perf?.deposits_month ?? missingLegIn(u)
          : undefined,
      deposits_year: mortgagePayments
        ? mortgagePayments.year
        : trackAssetMetrics
          ? perf?.deposits_year ?? missingLegIn(u)
          : undefined,
      deposits_day,
      delta_day,
      prior_day_close,
      prior_month_close: priorCloseInUnitFromMark(a.id, priorMonthMark?.value_clp, priorMonthEnd, u, fromPerf("mtd")),
      prior_year_close: priorCloseInUnitFromMark(a.id, priorYearMark?.value_clp, priorYearEnd, u, fromPerf("ytd")),
      current_value,
    };
  };

  const clpFrame = frameIn("clp");
  const frame = unit === "clp" ? clpFrame : frameIn(unit);
  // The position in the row's unit: its deposits and its value as the row converts them.
  const position = positionSnapshotInUnit(a.id, positionMeta, v, frame.deposits ?? null, unit);
  // A row the unit could not convert (no rate for its balance or its deposits).
  const fx_missing =
    unit === "clp"
      ? undefined
      : (clpFrame.current_value != null && frame.current_value == null) ||
        (clpFrame.deposits !== 0 && frame.deposits == null);
  const row: DashboardAccountStats = {
    account_id: a.id,
    name: a.name,
    group_slug: portfolioLeafSlug ?? leafSlug,
    group_label: a.bucket_label,
    bucket_slug: leafSlug,
    bucket_label: a.bucket_label,
    dashboard_bucket_slug: (dashboard_bucket_slug ?? null) as string,
    deposits: frame.deposits,
    delta_month: frame.delta_month,
    delta_year: frame.delta_year,
    delta_total: frame.delta_total,
    deposits_month: frame.deposits_month,
    deposits_year: frame.deposits_year,
    deposits_day: frame.deposits_day,
    delta_day: frame.delta_day,
    prior_day_close: frame.prior_day_close,
    prior_month_close: frame.prior_month_close,
    prior_year_close: frame.prior_year_close,
    current_value: frame.current_value,
    valuation_as_of: v?.as_of_date ?? null,
    fx_missing,
    notes: a.notes ?? null,
    exclude_from_group_totals: a.exclude_from_group_totals,
    chart_inactive: accountChartInactive(a.id),
    position,
    // Placeholder: the listing sets it (see buildDashboardAccountRowsInner).
    sync_stale: false,
    // What the row is (Rentabilidad, a property's loan): the client picks these (F12).
    has_period_returns: isInvestmentPerformanceAccount(a.id),
    loan_account_id: isPropertyKind(kindSlug) ? loanAccountIdOfProperty(a.id) : null,
    ...dashboardRowPeriodPcts(frame, unit),
    clp_basis: {
      current_value: clpFrame.current_value,
      deposits: clpFrame.deposits ?? 0,
      delta_total: clpFrame.delta_total,
    },
  };
  // Every period % is the account's daily returns compounded (periodPctDailyChain.ts); the
  // one-step Total stays as `pct_total_on_deposits`. Row by row: each reads only its own
  // account's daily series.
  return withDailyChainedAccountRowPcts([row], unit, accountIsDebt)[0]!;
}

/**
 * Nav cards strip + account detail row lookup (no full dashboard totals/charts), in `unit`.
 * Cached with the page bundle's lifetime (`dashboard.page_bundle|nav_snapshot|<unit>`): every
 * invalidation that drops the bundle drops it, so it is what a fresh build would answer; the
 * cached value is the in-flight promise, and a rejected build evicts itself.
 */
export function buildDashboardNavSnapshot(unit: TsUnit): ReturnType<typeof buildDashboardNavSnapshotUncached> {
  return cachedWithPageBundleLifetime(`nav_snapshot|${unit}`, () => buildDashboardNavSnapshotUncached(unit));
}

function cachedWithPageBundleLifetime<T>(name: `nav_${string}`, build: () => Promise<T>): Promise<T> {
  return getAggregationCached(cacheKeyDashboardNav(name), build);
}

/**
 * The liabilities owed today in `unit` (mortgage, credit cards), at today's rate at the debt
 * side (live while the fx day is open), as every value on the page — never the buy rate
 * deposit events use.
 */
export function liabilitiesBreakdownInUnit(asOfYmd: string, unit: TsUnit): {
  mortgage: number | null;
  credit_card: number | null;
} {
  const clp = liabilitiesBreakdownClpAsOf(asOfYmd);
  return {
    mortgage: clpToUnitAt(clp.mortgage_clp, asOfYmd, unit, { side: "debt" }),
    credit_card: clpToUnitAt(clp.credit_card_clp, asOfYmd, unit, { side: "debt" }),
  };
}

/** The listing's rows as the API sends them (notes normalized, the peso basis left out). */
export function dashboardAccountRowsDto(rows: readonly DashboardAccountStats[]): DashboardAccountRowDto[] {
  return rows.map((r) => {
    const dto = dashboardAccountRowDto(r);
    return { ...dto, notes: dto.notes ?? null };
  });
}

/** @heavy One {@link monthlyPerfRowsForAccount} per unit per tracked account (via {@link buildDashboardAccountRows}). */
async function buildDashboardNavSnapshotUncached(unit: TsUnit) {
  const rowsBuilt = await buildDashboardAccountRows(unit);
  const asOfToday = chileCalendarTodayYmd();
  // A netting bucket's card explains its netting with the linked balances footer.
  const dashboard_layout = getDashboardLayoutCards().map((card) =>
    groupNetsLinkedCards(card.slug)
      ? {
          ...card,
          linked_balances: cashSavingsLinkedBalances(asOfToday, unit),
        }
      : card
  );
  const nw_bucket_totals = buildDashboardNwBucketTotals(unit);
  // Nav-strip card metrics, precomputed server-side (see dashboardNavCardMetrics.ts).
  // The Pasivos page renders nav nodes from the liabilities root (DB-driven liability_groups
  // children), so both trees get entries; the liabilities root wins the shared `liabilities` slug.
  const navRoot = getNetWorthNavGroupNode();
  if (!navRoot) throw new Error("nav snapshot: net_worth nav tree missing");
  const liabilitiesRoot = getLiabilitiesNavRootNode();
  if (!liabilitiesRoot) throw new Error("nav snapshot: liabilities nav tree missing");
  const chainedGroupPct = chainedGroupPctResolver(rowsBuilt, unit, accountIsDebt);
  const card_metrics_by_slug = buildNavCardMetricsBySlug({
    navRoots: [navRoot, liabilitiesRoot],
    rows: rowsBuilt,
    bucketTotals: nw_bucket_totals,
    chainedGroupPct,
    unit,
  });
  return {
    schema_version: DTO_SCHEMA_VERSIONS.nav_strip,
    unit,
    accounts: dashboardAccountRowsDto(rowsBuilt),
    liabilities_breakdown: liabilitiesBreakdownInUnit(asOfToday, unit),
    dashboard_layout,
    nw_bucket_totals,
    card_metrics_by_slug,
    ...buildNavValueMapPayload(rowsBuilt, unit, chainedGroupPct),
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
  unit: TsUnit,
  rootSlug: string
): ReturnType<typeof buildDashboardNavContextInner> {
  return cachedWithPageBundleLifetime(`nav_context|${unit}|${rootSlug}`, () =>
    withPortfolioGroupIndex(() => buildDashboardNavContextInner(unit, rootSlug))
  );
}

async function buildDashboardNavContextInner(unit: TsUnit, rootSlug: string) {
  const nav = await timeHeavyAsync(HeavyWork.navContext, () => buildDashboardNavSnapshot(unit));
  const navRoot = getNetWorthNavGroupNode();
  if (!navRoot) throw new Error("nav-context: net_worth nav tree missing");
  const liabilitiesRoot = getLiabilitiesNavRootNode();
  if (!liabilitiesRoot) throw new Error("nav-context: liabilities nav tree missing");
  const scope = navContextScope(rootSlug, [liabilitiesRoot, navRoot], liabilitiesRoot);
  return {
    schema_version: DTO_SCHEMA_VERSIONS.nav_strip,
    unit,
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
