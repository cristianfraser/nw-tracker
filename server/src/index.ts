import cors from "cors";
import express from "express";
import { httpRequestLogMiddleware } from "./httpRequestLog.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  isResolvablePortfolioGroupSlug,
  normalizeLegacyTabSubgroup,
  portfolioGroupBySlug,
  resolvePortfolioGroupSlugForLegacyTab,
} from "./portfolioGroupTree.js";
import {
  getMergedDepositInflowEventsForAccount,
  getMergedDisplayDepositInflowEventsForAccount,
  getStateContributionInflowEventsForAccount,
  totalDepositsClpForAccount,
  totalDisplayDepositsClpForAccount,
  totalStateContributionsClpForAccount,
  totalWithdrawalsClpForAccount,
} from "./accountDeposits.js";
import { movementFlowTypeFromRow, movementFlowTypeLabel } from "./movementFlowType.js";
import { accountRowForId } from "./accountRowForMovement.js";
import { bookLedgerEditSchemaForAccount } from "./accountBookLedgerEdit.js";
import {
  commitMortgagePayment,
  mortgagePaymentCreateSchemaForAccount,
  parseMortgagePaymentBody,
  previewMortgagePayment,
} from "./mortgagePaymentCreate.js";
import { movementCreateSchemaForAccount, validateMovementCreate } from "./movementUnitsPolicy.js";
import { listAccountMovementsForApi } from "./accountMovementsApi.js";
import { getAccountPositionMeta } from "./accountPosition.js";
import { accountUsesEquityMtm } from "./brokerageEquityMtm.js";
import {
  equityReturnSnapshot,
  pocketDepositsClpForAccount,
  totalDividendsReinvestedClpForAccount,
} from "./equityDividendReinvested.js";
import { accountUsesCryptoMtm } from "./cryptoValuation.js";
import { accountCountsTowardGroupTotals } from "./accountGroupTotals.js";
import { syncEquityEodFromYahoo } from "./equityEodSync.js";
import {
  createPanelAccount,
  type PanelAccountCreateBody,
} from "./createPanelAccount.js";
import { NOTE_STOCKS_LEGACY, type DashboardAccountStats } from "./brokerageAcciones.js";
import { accountChartInactive } from "./accountChartInactive.js";
import { reconcileDashboardCardMetrics } from "./dashboardCardMetricsReconcile.js";
import {
  isDeptoMortgagePaymentCuota,
  loadDeptoDividendosSheetLedgerFromDb,
  mortgageMetaFromSheetRows,
  noteIsDeptoPiePayment,
} from "./deptoDividendosLedger.js";
import { buildDeptoPaymentScenarioRows } from "./mortgageScenarioPayments.js";
import { fxMonthEndForBalanceUsd } from "./fxRates.js";
import { buildFxCoverage } from "./fxCoverage.js";
import { listFxBidAskGaps, upsertManualFxBidAskRow } from "./fxBidAskGaps.js";
import { attachColorsToValuationPayload, prettyRgbTripletForAccountId } from "./chartColorRgb.js";
import { updateAccountColorRgb, updatePortfolioGroupColorRgb } from "./entityColors.js";
import { updateAccountExcludeFromGroupTotals } from "./accountExcludeFromGroupTotals.js";
import { accountBucketKindSlug, accountKindSlugForAccountId, bucketSlugForAccountId } from "./accountBucket.js";
import { dashboardBucketForAssetGroupSlug } from "./assetGroupTree.js";
import { db } from "./db.js";
import { listRatesInstrumentSeries, listMarketDisplaySeries } from "./marketDisplaySeries.js";
import {
  creditCardLiabilityLinkRowsForCashCard,
  linkedCreditCardClpForCashCardAsOf,
} from "./liabilityTree.js";
import {
  getNetWorthNavGroupNode,
  getPortfolioTreeForCharts,
  getSidebarNavPayload,
} from "./navTree.js";
import { getDashboardLayoutCards } from "./dashboardLayout.js";
import { portfolioGroupColorRgbBySlug } from "./portfolioGroups.js";
import { resolveOperationalAccountId } from "./accountSource.js";
import {
  clearAggregationCache,
  invalidateAggregationForAccountDate,
} from "./aggregationCache.js";
import { supersedeImportedCheckingRowsForTransfer } from "./checkingTransferLegReconcile.js";
import { seedNavTree } from "./seedNavTree.js";
import { chileCalendarTodayYmd } from "./chileDate.js";
import {
  latestDisplayedBalanceForAccount,
  latestValuationRowOnOrBeforeChileToday,
} from "./valuationLatest.js";
import type { AccountPositionMeta } from "./accountPosition.js";
import { getMarketSeriesPayload } from "./marketSeries.js";
import { getMarketTickerPayload } from "./marketTicker.js";
import {
  addManualWatchlistTicker,
  deleteManualWatchlistRow,
  getWatchlistPayload,
  patchWatchlistRow,
} from "./watchlist.js";
import { liabilitiesBreakdownClpAsOf } from "./valuationTimeseries.js";
import {
  getAccountValuationTimeseries,
  getDashboardValuationTimeseries,
  getGroupValuationTimeseries,
  listAccountsForGroupTab,
  listLiabilitiesTabAccountRows,
  type TsUnit,
} from "./valuationTimeseries.js";
import {
  getAccountMonthlyPerformance,
  getGroupMonthlyPerformanceSeries,
  getStocksLifetimeEarningsSeries,
} from "./accountPerformance.js";
import {
  buildDashboardNavContext,
  buildDashboardNavSnapshot,
  latestValuationDisplayForAccount,
} from "./dashboardAccounts.js";
import { listPortfolioGroupAccountsForApi } from "./portfolioGroupAccountsApi.js";
import { buildDashboardPageBundle } from "./dashboardPageBundle.js";
import { buildDashboardPagePayload } from "./dashboardPagePayload.js";
import { buildAccountDetailBundle } from "./accountDetailBundle.js";
import {
  getGroupConsolidatedMonthlyPage,
  getGroupConsolidatedTables,
} from "./groupConsolidatedTables.js";
import { buildGroupFlows, buildAccountFlows, type FlowsFilters } from "./flowsApi.js";
import { parsePageParams } from "./pagination.js";
import {
  convertStatementLineToInstallmentPurchase,
  deleteManualCcInstallmentPurchase,
  updateManualCcInstallmentPurchase,
} from "./ccInstallmentManual.js";
import { deleteCcWebPasteStatementLine } from "./ccStatementLineDelete.js";
import { patchCreditCardBillingConfig, recomputeCcBillingMonthBalances } from "./ccBillingBalances.js";
import {
  checkingMovementBalanceLive,
  clearCheckingLedgerAnchor,
  isCheckingLedgerAnchorNote,
  maybeSyncCheckingLedgerAnchor,
  upsertCheckingLedgerAnchor,
} from "./checkingCartolaBalances.js";
import { isMovementBalanceCashCategory } from "./movementBalanceCashAccounts.js";
import { getCheckingCartolaMonths } from "./checkingCartolaMonthSummary.js";
import { loadCreditCardBillingConfig } from "./ccBillingMonth.js";
import { creditCardInstallmentsResponse, parseExtraOffsetsJson } from "./creditCardInstallments.js";
import { getCcProxyTickers, setCcProxyTickers } from "./ccInvestmentProxy.js";
import { creditCardGroupLedgerResponse } from "./creditCardGroupLedger.js";
import { mortgageGroupLedgerResponse } from "./mortgageGroupLedger.js";
import { documentImportSpecsForAccount } from "./accountDocumentRegistry.js";
import {
  importAccountDocument,
  importCcStatementPdfUpload,
  importCcWebPaste,
  importCuentaVistaWebPaste,
  importCheckingCartolaXlsx,
  importCheckingRecentXlsx,
} from "./accountImports.js";
import { uploadFields, uploadSingle } from "./uploadMiddleware.js";
import { resolveCfraserCsvDir, resolveDeptoDividendosCsvPath } from "./cfraserPaths.js";
import { buildDepositsReconciliationPayload } from "./flowsDepositsReconciliation.js";
import {
  buildFlowsDepositsPayload,
  depositClpToUsdAtDate,
  inversionesBrokerageDepositsSeries,
  flowsDepositsNetInPeriodByAccount,
  flowsDepositsNetTotalByAccount,
  flowsDepositsNetTotalUsdByAccount,
} from "./flowsDeposits.js";
import { assignCcExpenseCategoryForManualLedgerInstallmentPurchase } from "./ccExpenseCategories.js";
import { purchaseIdFromPlanGastosLineId } from "./ccInstallmentPlanGastosLines.js";
import { assignFlowExpenseLineCategory } from "./assignFlowExpenseLineCategory.js";
import { resolveCcExpensePurchaseKey } from "./ccExpenseCategories.js";
import { setCcExpensePurchaseNote } from "./ccExpensePurchaseNotes.js";
import {
  createCcExpenseBigGroup,
  deleteCcExpenseBigGroup,
  renameCcExpenseBigGroup,
  setCcExpensePurchaseBigGroup,
} from "./ccExpenseBigGroups.js";
import { buildFlowsCreditCardExpensesPayload } from "./flowsCreditCardExpenses.js";
import {
  deleteCcFacturadoFinancingLink,
  listCcFacturadoFinancingLinks,
  upsertCcFacturadoFinancingLink,
} from "./ccFacturadoFinancingLinksDb.js";
import { buildFlowsCheckingIncomePayload } from "./flowsCheckingInflows.js";
import {
  type CheckingIncomeKind,
  clearCheckingIncomeForceInclude,
  restoreCheckingIncomeMovement,
  upsertCheckingIncomeMovementOverride,
} from "./flowsCheckingIncomeOverrides.js";
import {
  updatePayrollWorkEarning,
  type PayrollEarningType,
} from "./flowsPayrollWorkEarnings.js";
import {
  assertMovementEligibleForPayrollLink,
  listPayrollLinkCandidates,
} from "./payrollWorkEarningsLinking.js";
import {
  normalizeManualExpenseNote,
  validateManualExpenseCategorySlug,
} from "./flowsManualExpenses.js";
import {
  buildRealEstateExpensesPayload,
  listRealEstateLinkCandidates,
} from "./flowsRealEstateExpenses.js";
import {
  manualLinkRealEstateExpense,
  unmatchRealEstateExpense,
} from "./realEstateExpenseMatching.js";
import {
  listAppMessages,
  markAllNotificationsRead,
  unreadNotificationCount,
} from "./appMessages.js";
import {
  forceSyncSourceStale,
  isGlobalSyncSource,
  isLegacyEquityEodSyncSource,
  syncStatusPayload,
} from "./globalSyncStale.js";
import { buildImportSyncDocumentCoveragePayload } from "./importSyncDocumentCoverage.js";
import {
  createCcExpenseGenericUniqueMerchant,
  deleteCcExpenseGenericUniqueMerchant,
  listCcExpenseGenericUniqueMerchants,
  updateCcExpenseGenericUniqueMerchant,
} from "./ccExpenseGenericUniqueMerchants.js";
import { normalizeCcExpenseMerchantKey } from "./ccExpenseCategories.js";
import { backfillGenericTransferUniquePurchases } from "./ccExpenseGenericTransferBackfill.js";
import { lastSyncRunCreatedAt } from "./syncRunLog.js";
import {
  getGlobalSyncSchedulerSnapshot,
  notifyGlobalSyncScheduler,
  startGlobalSyncScheduler,
} from "./globalSyncScheduler.js";
import { startLiveMarketQuotesScheduler } from "./liveMarketQuotesScheduler.js";
import { loadRootDotenv } from "./rootDotenv.js";
import { ensureAccountSyncSourcesSeeded } from "./accountSyncSources.js";
import {
  isFiniteNumber,
  isOptionalString,
  isPositiveFiniteNumber,
  isPositiveInteger,
  isYmdString,
} from "./requestValidation.js";
import {
  resolveBindHost,
  resolveCorsOrigins,
  sharedAuthPasswordFromEnv,
  sharedPasswordAuthMiddleware,
} from "./httpSecurity.js";
import { startDashboardCacheWarmer } from "./dashboardCacheWarmer.js";
import { startDbBackupScheduler } from "./dbBackupScheduler.js";
import { registerMetaRoutes } from "./routes/meta.js";
import { registerAccountsRoutes } from "./routes/accounts.js";
import { registerMortgageRoutes } from "./routes/mortgage.js";
import { registerCreditCardRoutes } from "./routes/creditCard.js";
import { registerMovementsRoutes } from "./routes/movements.js";
import { registerDashboardRoutes } from "./routes/dashboard.js";
import { registerMarketRoutes } from "./routes/market.js";
import { registerFlowsRoutes } from "./routes/flows.js";
import { registerSyncRoutes } from "./routes/sync.js";

seedNavTree();

loadRootDotenv();
ensureAccountSyncSourcesSeeded();

const app = express();
const PORT = Number(process.env.PORT) || 3001;
const HOST = resolveBindHost();


/** Safety net for rejections outside routes (schedulers catch their own; this logs stragglers). */
process.on("unhandledRejection", (reason) => {
  console.error(
    "[process] unhandled rejection:",
    reason instanceof Error ? (reason.stack ?? reason.message) : reason
  );
});

app.use(cors({ origin: resolveCorsOrigins() }));
app.use(httpRequestLogMiddleware);
const authPassword = sharedAuthPasswordFromEnv();
if (authPassword) {
  app.use(sharedPasswordAuthMiddleware(authPassword));
  console.log("auth: shared-password mode enabled (AUTH_PASSWORD set)");
}
app.use(express.json({ limit: "2mb" }));

/** Route registration order preserves the original monolithic file's order. */
registerMetaRoutes(app);
registerAccountsRoutes(app);
registerMortgageRoutes(app);
registerCreditCardRoutes(app);
registerMovementsRoutes(app);
registerDashboardRoutes(app);
registerMarketRoutes(app);
registerFlowsRoutes(app);
registerSyncRoutes(app);

app.use(
  (err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(
      `[api] route error: ${err instanceof Error ? (err.stack ?? msg) : msg}`
    );
    if (res.headersSent) return;
    res.status(500).json({ error: msg });
  }
);

app.listen(PORT, HOST, () => {
  console.log(`nw-tracker API http://${HOST}:${PORT}`);
  startGlobalSyncScheduler();
  startLiveMarketQuotesScheduler();
  startDbBackupScheduler();
  startDashboardCacheWarmer();
});

