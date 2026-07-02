/** Home dashboard bundles, valuation timeseries, group tables/flows/performance. Split verbatim from index.ts; paths unchanged. */
import cors from "cors";
import express from "express";
import { httpRequestLogMiddleware } from "../httpRequestLog.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  isResolvablePortfolioGroupSlug,
  normalizeLegacyTabSubgroup,
  portfolioGroupBySlug,
  resolvePortfolioGroupSlugForLegacyTab,
} from "../portfolioGroupTree.js";
import {
  getMergedDepositInflowEventsForAccount,
  getMergedDisplayDepositInflowEventsForAccount,
  getStateContributionInflowEventsForAccount,
  totalDepositsClpForAccount,
  totalDisplayDepositsClpForAccount,
  totalStateContributionsClpForAccount,
  totalWithdrawalsClpForAccount,
} from "../accountDeposits.js";
import { movementFlowTypeFromRow, movementFlowTypeLabel } from "../movementFlowType.js";
import { accountRowForId } from "../accountRowForMovement.js";
import { bookLedgerEditSchemaForAccount } from "../accountBookLedgerEdit.js";
import {
  commitMortgagePayment,
  mortgagePaymentCreateSchemaForAccount,
  parseMortgagePaymentBody,
  previewMortgagePayment,
} from "../mortgagePaymentCreate.js";
import { movementCreateSchemaForAccount, validateMovementCreate } from "../movementUnitsPolicy.js";
import { listAccountMovementsForApi } from "../accountMovementsApi.js";
import { getAccountPositionMeta } from "../accountPosition.js";
import { accountUsesEquityMtm } from "../brokerageEquityMtm.js";
import {
  equityReturnSnapshot,
  pocketDepositsClpForAccount,
  totalDividendsReinvestedClpForAccount,
} from "../equityDividendReinvested.js";
import { accountUsesCryptoMtm } from "../cryptoValuation.js";
import { accountCountsTowardGroupTotals } from "../accountGroupTotals.js";
import { syncEquityEodFromYahoo } from "../equityEodSync.js";
import {
  createPanelAccount,
  type PanelAccountCreateBody,
} from "../createPanelAccount.js";
import { NOTE_STOCKS_LEGACY, type DashboardAccountStats } from "../brokerageAcciones.js";
import { accountChartInactive } from "../accountChartInactive.js";
import { reconcileDashboardCardMetrics } from "../dashboardCardMetricsReconcile.js";
import {
  deptoSueciaDashboardSnapshotAt,
  isDeptoMortgagePaymentCuota,
  loadDeptoDividendosSheetLedgerFromDb,
  mortgageMetaFromSheetRows,
  noteIsDeptoPiePayment,
} from "../deptoDividendosLedger.js";
import { buildDeptoPaymentScenarioRows } from "../mortgageScenarioPayments.js";
import { fxMonthEndForBalanceUsd } from "../fxRates.js";
import { buildFxCoverage } from "../fxCoverage.js";
import { listFxBidAskGaps, upsertManualFxBidAskRow } from "../fxBidAskGaps.js";
import { attachColorsToValuationPayload, prettyRgbTripletForAccountId } from "../chartColorRgb.js";
import { updateAccountColorRgb, updatePortfolioGroupColorRgb } from "../entityColors.js";
import { updateAccountExcludeFromGroupTotals } from "../accountExcludeFromGroupTotals.js";
import { accountBucketKindSlug, accountKindSlugForAccountId, bucketSlugForAccountId } from "../accountBucket.js";
import { dashboardBucketForAssetGroupSlug } from "../assetGroupTree.js";
import { db } from "../db.js";
import { listRatesInstrumentSeries, listMarketDisplaySeries } from "../marketDisplaySeries.js";
import {
  creditCardLiabilityLinkRowsForCashCard,
  linkedCreditCardClpForCashCardAsOf,
} from "../liabilityTree.js";
import {
  getNetWorthNavGroupNode,
  getPortfolioTreeForCharts,
  getSidebarNavPayload,
} from "../navTree.js";
import { getDashboardLayoutCards } from "../dashboardLayout.js";
import { portfolioGroupColorRgbBySlug } from "../portfolioGroups.js";
import { resolveOperationalAccountId } from "../accountSource.js";
import {
  clearAggregationCache,
  invalidateAggregationForAccountDate,
} from "../aggregationCache.js";
import { supersedeImportedCheckingRowsForTransfer } from "../checkingTransferLegReconcile.js";
import { seedNavTree } from "../seedNavTree.js";
import { chileCalendarTodayYmd } from "../chileDate.js";
import {
  latestDisplayedBalanceForAccount,
  latestValuationRowOnOrBeforeChileToday,
} from "../valuationLatest.js";
import type { AccountPositionMeta } from "../accountPosition.js";
import { getMarketSeriesPayload } from "../marketSeries.js";
import { getMarketTickerPayload } from "../marketTicker.js";
import {
  addManualWatchlistTicker,
  deleteManualWatchlistRow,
  getWatchlistPayload,
  patchWatchlistRow,
} from "../watchlist.js";
import { liabilitiesBreakdownClpAsOf } from "../valuationTimeseries.js";
import {
  getAccountValuationTimeseries,
  getDashboardValuationTimeseries,
  getGroupValuationTimeseries,
  listAccountsForGroupTab,
  listLiabilitiesTabAccountRows,
  type TsUnit,
} from "../valuationTimeseries.js";
import {
  getAccountMonthlyPerformance,
  getGroupMonthlyPerformanceSeries,
  getStocksLifetimeEarningsSeries,
} from "../accountPerformance.js";
import {
  buildDashboardNavContext,
  buildDashboardNavSnapshot,
  latestValuationDisplayForAccount,
} from "../dashboardAccounts.js";
import { listPortfolioGroupAccountsForApi } from "../portfolioGroupAccountsApi.js";
import { buildDashboardPageBundle } from "../dashboardPageBundle.js";
import { buildDashboardPagePayload } from "../dashboardPagePayload.js";
import { buildAccountDetailBundle } from "../accountDetailBundle.js";
import {
  getGroupConsolidatedMonthlyPage,
  getGroupConsolidatedTables,
} from "../groupConsolidatedTables.js";
import { buildGroupFlows, buildAccountFlows, type FlowsFilters } from "../flowsApi.js";
import { parsePageParams } from "../pagination.js";
import {
  convertStatementLineToInstallmentPurchase,
  deleteManualCcInstallmentPurchase,
  updateManualCcInstallmentPurchase,
} from "../ccInstallmentManual.js";
import { deleteCcWebPasteStatementLine } from "../ccStatementLineDelete.js";
import { patchCreditCardBillingConfig, recomputeCcBillingMonthBalances } from "../ccBillingBalances.js";
import {
  checkingMovementBalanceLive,
  clearCheckingLedgerAnchor,
  isCheckingLedgerAnchorNote,
  maybeSyncCheckingLedgerAnchor,
  upsertCheckingLedgerAnchor,
} from "../checkingCartolaBalances.js";
import { isMovementBalanceCashCategory } from "../movementBalanceCashAccounts.js";
import { getCheckingCartolaMonths } from "../checkingCartolaMonthSummary.js";
import { loadCreditCardBillingConfig } from "../ccBillingMonth.js";
import { creditCardInstallmentsResponse, parseExtraOffsetsJson } from "../creditCardInstallments.js";
import { getCcProxyTickers, setCcProxyTickers } from "../ccInvestmentProxy.js";
import { creditCardGroupLedgerResponse } from "../creditCardGroupLedger.js";
import { mortgageGroupLedgerResponse } from "../mortgageGroupLedger.js";
import { documentImportSpecsForAccount } from "../accountDocumentRegistry.js";
import {
  importAccountDocument,
  importCcStatementPdfUpload,
  importCcWebPaste,
  importCuentaVistaWebPaste,
  importCheckingCartolaXlsx,
  importCheckingRecentXlsx,
} from "../accountImports.js";
import { uploadFields, uploadSingle } from "../uploadMiddleware.js";
import { resolveCfraserCsvDir, resolveDeptoDividendosCsvPath } from "../cfraserPaths.js";
import { buildDepositsReconciliationPayload } from "../flowsDepositsReconciliation.js";
import {
  buildFlowsDepositsPayload,
  depositClpToUsdAtDate,
  inversionesBrokerageDepositsSeries,
  flowsDepositsNetInPeriodByAccount,
  flowsDepositsNetTotalByAccount,
  flowsDepositsNetTotalUsdByAccount,
} from "../flowsDeposits.js";
import { assignCcExpenseCategoryForManualLedgerInstallmentPurchase } from "../ccExpenseCategories.js";
import { purchaseIdFromPlanGastosLineId } from "../ccInstallmentPlanGastosLines.js";
import { assignFlowExpenseLineCategory } from "../assignFlowExpenseLineCategory.js";
import { resolveCcExpensePurchaseKey } from "../ccExpenseCategories.js";
import { setCcExpensePurchaseNote } from "../ccExpensePurchaseNotes.js";
import {
  createCcExpenseBigGroup,
  deleteCcExpenseBigGroup,
  renameCcExpenseBigGroup,
  setCcExpensePurchaseBigGroup,
} from "../ccExpenseBigGroups.js";
import { buildFlowsCreditCardExpensesPayload } from "../flowsCreditCardExpenses.js";
import {
  deleteCcFacturadoFinancingLink,
  listCcFacturadoFinancingLinks,
  upsertCcFacturadoFinancingLink,
} from "../ccFacturadoFinancingLinksDb.js";
import { buildFlowsCheckingIncomePayload } from "../flowsCheckingInflows.js";
import {
  type CheckingIncomeKind,
  clearCheckingIncomeForceInclude,
  restoreCheckingIncomeMovement,
  upsertCheckingIncomeMovementOverride,
} from "../flowsCheckingIncomeOverrides.js";
import {
  updatePayrollWorkEarning,
  type PayrollEarningType,
} from "../flowsPayrollWorkEarnings.js";
import {
  assertMovementEligibleForPayrollLink,
  listPayrollLinkCandidates,
} from "../payrollWorkEarningsLinking.js";
import {
  normalizeManualExpenseNote,
  validateManualExpenseCategorySlug,
} from "../flowsManualExpenses.js";
import {
  buildRealEstateExpensesPayload,
  listRealEstateLinkCandidates,
} from "../flowsRealEstateExpenses.js";
import {
  manualLinkRealEstateExpense,
  unmatchRealEstateExpense,
} from "../realEstateExpenseMatching.js";
import {
  listAppMessages,
  markAllNotificationsRead,
  unreadNotificationCount,
} from "../appMessages.js";
import {
  forceSyncSourceStale,
  isGlobalSyncSource,
  isLegacyEquityEodSyncSource,
  syncStatusPayload,
} from "../globalSyncStale.js";
import { buildImportSyncDocumentCoveragePayload } from "../importSyncDocumentCoverage.js";
import {
  createCcExpenseGenericUniqueMerchant,
  deleteCcExpenseGenericUniqueMerchant,
  listCcExpenseGenericUniqueMerchants,
  updateCcExpenseGenericUniqueMerchant,
} from "../ccExpenseGenericUniqueMerchants.js";
import { normalizeCcExpenseMerchantKey } from "../ccExpenseCategories.js";
import { backfillGenericTransferUniquePurchases } from "../ccExpenseGenericTransferBackfill.js";
import { lastSyncRunCreatedAt } from "../syncRunLog.js";
import {
  getGlobalSyncSchedulerSnapshot,
  notifyGlobalSyncScheduler,
  startGlobalSyncScheduler,
} from "../globalSyncScheduler.js";
import { startLiveMarketQuotesScheduler } from "../liveMarketQuotesScheduler.js";
import { loadRootDotenv } from "../rootDotenv.js";
import { ensureAccountSyncSourcesSeeded } from "../accountSyncSources.js";
import {
  isFiniteNumber,
  isOptionalString,
  isPositiveFiniteNumber,
  isPositiveInteger,
  isYmdString,
} from "../requestValidation.js";
import {
  resolveBindHost,
  resolveCorsOrigins,
  sharedAuthPasswordFromEnv,
  sharedPasswordAuthMiddleware,
} from "../httpSecurity.js";
import { startDashboardCacheWarmer } from "../dashboardCacheWarmer.js";
import { startDbBackupScheduler } from "../dbBackupScheduler.js";
import {
  asyncHandler,
  isKnownClassTabGroup,
  operationalAccountIdFromReq,
  parseProxyTickersParam,
  positionSnapshotFromMeta,
} from "./shared.js";

export function registerDashboardRoutes(app: express.Express): void {
app.get("/api/dashboard/nav-snapshot", asyncHandler(async (req, res) => {
  const includeUsd = req.query.include_usd === "1" || req.query.include_usd === "true";
  res.json(await buildDashboardNavSnapshot(includeUsd));
}));

/** Group/account nav strip: accounts + liabilities links + overview (one round-trip). */
app.get("/api/dashboard/nav-context", asyncHandler(async (req, res) => {
  const includeUsd = req.query.include_usd === "1" || req.query.include_usd === "true";
  const unit: TsUnit = includeUsd ? "usd" : "clp";
  res.json(await buildDashboardNavContext(includeUsd, unit));
}));

/** Home dashboard: one response (dash + valuation TS + FX + group perf). */
app.get("/api/dashboard/page-bundle", asyncHandler(async (req, res) => {
  const includeUsd = req.query.include_usd === "1" || req.query.include_usd === "true";
  const unit: TsUnit = includeUsd ? "usd" : "clp";
  res.json(await buildDashboardPageBundle(unit));
}));

app.get("/api/dashboard", asyncHandler(async (req, res) => {
  const includeUsd = req.query.include_usd === "1" || req.query.include_usd === "true";
  res.json(await buildDashboardPagePayload(includeUsd));
}));

/**
 * Valuation time series: main dashboard (no `group`) or per-class tab (`group=retirement|brokerage|…`).
 * Query: include_usd / include_uf → unit (main dashboard UI only uses CLP+USD; UF kept for other consumers).
 */
app.get("/api/dashboard/valuation-timeseries", (req, res) => {
  const includeUsd = req.query.include_usd === "1" || req.query.include_usd === "true";
  const includeUf = req.query.include_uf === "1" || req.query.include_uf === "true";
  const unit: TsUnit = includeUsd ? "usd" : includeUf ? "uf" : "clp";

  const portfolioGroup =
    typeof req.query.portfolio_group === "string" ? req.query.portfolio_group.trim() : "";
  const group = typeof req.query.group === "string" ? req.query.group.trim() : "";
  if (portfolioGroup || group) {
    const subRaw = group ? normalizeLegacyTabSubgroup(req.query.subgroup) : undefined;
    if (subRaw === null) {
      res.status(400).json({ error: "invalid subgroup" });
      return;
    }
    const tabSlug = portfolioGroup
      ? portfolioGroup
      : resolvePortfolioGroupSlugForLegacyTab(group, subRaw) ??
        (portfolioGroupBySlug(group) ? group : null);
    if (!tabSlug || !isKnownClassTabGroup(tabSlug)) {
      res.status(400).json({ error: "unknown group slug" });
      return;
    }
    res.json(
      attachColorsToValuationPayload(getGroupValuationTimeseries(tabSlug, unit, undefined))
    );
    return;
  }

  res.json(attachColorsToValuationPayload(getDashboardValuationTimeseries(unit)));
});

/** SPY+VEA merged: monthly Δ (sum) and cumulative earnings since first month (derived). */
app.get("/api/dashboard/stocks-earnings-monthly", (req, res) => {
  const includeUsd = req.query.include_usd === "1" || req.query.include_usd === "true";
  const unit: TsUnit = includeUsd ? "usd" : "clp";
  res.json(getStocksLifetimeEarningsSeries(unit));
});

/** Group consolidated tables: per-account monthly perf + movements in one response. */
app.get("/api/groups/:slug/consolidated-tables", (req, res) => {
  const slug = typeof req.params.slug === "string" ? req.params.slug.trim() : "";
  if (!isKnownClassTabGroup(slug)) {
    res.status(400).json({ error: "unknown group slug" });
    return;
  }
  const subRaw = normalizeLegacyTabSubgroup(req.query.subgroup);
  if (subRaw === null) {
    res.status(400).json({ error: "invalid subgroup" });
    return;
  }
  const tabSlug =
    resolvePortfolioGroupSlugForLegacyTab(slug, subRaw) ??
    (isResolvablePortfolioGroupSlug(slug) ? slug : null);
  if (!tabSlug || !isKnownClassTabGroup(tabSlug)) {
    res.status(400).json({ error: "unknown group slug" });
    return;
  }
  const includeUsd = req.query.include_usd === "1" || req.query.include_usd === "true";
  const unit: TsUnit = includeUsd ? "usd" : "clp";
  res.json(getGroupConsolidatedTables(tabSlug, unit, undefined));
});

/** Server-paginated consolidated detalle-por-mes rows (dashboard net_worth table). */
app.get("/api/groups/:slug/consolidated-monthly", (req, res) => {
  const slug = typeof req.params.slug === "string" ? req.params.slug.trim() : "";
  if (!isKnownClassTabGroup(slug)) {
    res.status(400).json({ error: "unknown group slug" });
    return;
  }
  const subRaw = normalizeLegacyTabSubgroup(req.query.subgroup);
  if (subRaw === null) {
    res.status(400).json({ error: "invalid subgroup" });
    return;
  }
  const tabSlug =
    resolvePortfolioGroupSlugForLegacyTab(slug, subRaw) ??
    (isResolvablePortfolioGroupSlug(slug) ? slug : null);
  if (!tabSlug || !isKnownClassTabGroup(tabSlug)) {
    res.status(400).json({ error: "unknown group slug" });
    return;
  }
  const periodRaw = typeof req.query.period === "string" ? req.query.period : "month";
  if (periodRaw !== "month" && periodRaw !== "year") {
    res.status(400).json({ error: "invalid period" });
    return;
  }
  const includeUsd = req.query.include_usd === "1" || req.query.include_usd === "true";
  const unit: TsUnit = includeUsd ? "usd" : "clp";
  const { page, pageSize } = parsePageParams(req.query as Record<string, unknown>, 12);
  res.json(getGroupConsolidatedMonthlyPage(tabSlug, unit, periodRaw, page, pageSize));
});

/** Paginated + filtered flows for a group (server-side). */
app.get("/api/groups/:slug/flows", (req, res) => {
  const slug = typeof req.params.slug === "string" ? req.params.slug.trim() : "";
  if (!isKnownClassTabGroup(slug)) {
    res.status(400).json({ error: "unknown group slug" });
    return;
  }
  const subRaw = normalizeLegacyTabSubgroup(req.query.subgroup);
  if (subRaw === null) {
    res.status(400).json({ error: "invalid subgroup" });
    return;
  }
  const tabSlug =
    resolvePortfolioGroupSlugForLegacyTab(slug, subRaw) ??
    (isResolvablePortfolioGroupSlug(slug) ? slug : null);
  if (!tabSlug || !isKnownClassTabGroup(tabSlug)) {
    res.status(400).json({ error: "unknown group slug" });
    return;
  }
  const { page, pageSize } = parsePageParams(req.query as Record<string, unknown>, 20);
  const filters: FlowsFilters = {};
  if (typeof req.query.year === "string" && req.query.year.trim()) filters.year = req.query.year.trim();
  if (typeof req.query.type === "string" && req.query.type.trim()) filters.type = req.query.type.trim();
  if (req.query.account_id) {
    const aid = Number(req.query.account_id);
    if (Number.isFinite(aid) && aid > 0) filters.account_id = aid;
  }
  if (typeof req.query.category === "string" && req.query.category.trim()) filters.category = req.query.category.trim();
  if (typeof req.query.q === "string" && req.query.q.trim()) filters.q = req.query.q.trim();
  res.json(buildGroupFlows(tabSlug, filters, page, pageSize));
});

/** Paginated + filtered flows for a single account (server-side). */
app.get("/api/accounts/:id/flows", (req, res) => {
  const id = operationalAccountIdFromReq(req);
  if (!Number.isFinite(id) || id <= 0) {
    res.status(400).json({ error: "invalid account id" });
    return;
  }
  const { page, pageSize } = parsePageParams(req.query as Record<string, unknown>, 20);
  const filters: FlowsFilters = {};
  if (typeof req.query.year === "string" && req.query.year.trim()) filters.year = req.query.year.trim();
  if (typeof req.query.type === "string" && req.query.type.trim()) filters.type = req.query.type.trim();
  if (typeof req.query.q === "string" && req.query.q.trim()) filters.q = req.query.q.trim();
  if (req.query.personal_only === "1" || req.query.personal_only === "true") filters.personal_only = true;
  const result = buildAccountFlows(id, filters, page, pageSize);
  if (!result) {
    res.status(404).json({ error: "account not found" });
    return;
  }
  res.json(result);
});

/** Per-class tab: month P/L bars per account + combined YTD area + ΣΔ line (derived, not stored). */
app.get("/api/groups/:slug/performance-monthly", (req, res) => {
  const slug = typeof req.params.slug === "string" ? req.params.slug.trim() : "";
  if (!isKnownClassTabGroup(slug)) {
    res.status(400).json({ error: "unknown group slug" });
    return;
  }
  const subRaw = normalizeLegacyTabSubgroup(req.query.subgroup);
  if (subRaw === null) {
    res.status(400).json({ error: "invalid subgroup" });
    return;
  }
  const tabSlug =
    resolvePortfolioGroupSlugForLegacyTab(slug, subRaw) ??
    (isResolvablePortfolioGroupSlug(slug) ? slug : null);
  if (!tabSlug || !isKnownClassTabGroup(tabSlug)) {
    res.status(400).json({ error: "unknown group slug" });
    return;
  }
  const includeUsd = req.query.include_usd === "1" || req.query.include_usd === "true";
  const unit: TsUnit = includeUsd ? "usd" : "clp";
  res.json(getGroupMonthlyPerformanceSeries(tabSlug, unit, undefined));
});

}
