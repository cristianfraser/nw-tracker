/** Global sync status/force, import-sync admin, messages, bank-statement stub. Split verbatim from index.ts; paths unchanged. */
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

export function registerSyncRoutes(app: express.Express): void {
app.get("/api/sync/status", (_req, res) => {
  res.json({
    ...syncStatusPayload(),
    scheduler: getGlobalSyncSchedulerSnapshot(),
    last_sync_at: lastSyncRunCreatedAt(),
  });
});

app.post("/api/sync/force-stale", (req, res) => {
  const source = typeof req.body?.source === "string" ? req.body.source.trim() : "";
  if (isLegacyEquityEodSyncSource(source)) {
    forceSyncSourceStale("stocks_nyse");
    forceSyncSourceStale("crypto_eod");
  } else if (!isGlobalSyncSource(source)) {
    res.status(400).json({ error: "invalid_source" });
    return;
  } else {
    forceSyncSourceStale(source);
  }
  notifyGlobalSyncScheduler();
  res.json({
    ...syncStatusPayload(),
    scheduler: getGlobalSyncSchedulerSnapshot(),
    last_sync_at: lastSyncRunCreatedAt(),
  });
});

app.get("/api/import-sync/document-coverage", (_req, res) => {
  res.json(buildImportSyncDocumentCoveragePayload());
});

app.get("/api/import-sync/generic-unique-merchants", (_req, res) => {
  res.json({ merchants: listCcExpenseGenericUniqueMerchants() });
});

app.post("/api/import-sync/generic-unique-merchants", (req, res) => {
  const raw = req.body?.merchant;
  if (typeof raw !== "string") {
    res.status(400).json({ error: "merchant required" });
    return;
  }
  const merchantKey = normalizeCcExpenseMerchantKey(raw);
  if (!merchantKey) {
    res.status(400).json({ error: "merchant required" });
    return;
  }
  try {
    const row = createCcExpenseGenericUniqueMerchant(merchantKey);
    const backfill = backfillGenericTransferUniquePurchases();
    res.json({ row, backfill });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    res.status(msg.includes("already exists") ? 409 : 400).json({ error: msg });
  }
});

app.patch("/api/import-sync/generic-unique-merchants/:id", (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: "invalid id" });
    return;
  }
  const raw = req.body?.merchant;
  if (typeof raw !== "string") {
    res.status(400).json({ error: "merchant required" });
    return;
  }
  const merchantKey = normalizeCcExpenseMerchantKey(raw);
  if (!merchantKey) {
    res.status(400).json({ error: "merchant required" });
    return;
  }
  try {
    const row = updateCcExpenseGenericUniqueMerchant(id, merchantKey);
    const backfill = backfillGenericTransferUniquePurchases();
    res.json({ row, backfill });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const status = msg === "not found" ? 404 : msg.includes("already exists") ? 409 : 400;
    res.status(status).json({ error: msg });
  }
});

app.delete("/api/import-sync/generic-unique-merchants/:id", (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: "invalid id" });
    return;
  }
  try {
    deleteCcExpenseGenericUniqueMerchant(id);
    res.status(204).send();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    res.status(msg === "not found" ? 404 : 400).json({ error: msg });
  }
});

app.get("/api/messages/unread-count", (_req, res) => {
  res.json({ count: unreadNotificationCount() });
});

app.get("/api/messages", (req, res) => {
  const kind = req.query.kind === "log" ? "log" : "notification";
  res.json({ messages: listAppMessages(kind) });
});

app.post("/api/messages/mark-read", (_req, res) => {
  const marked = markAllNotificationsRead();
  res.json({ marked });
});

/** Placeholder for future bank CSV / PDF pipeline */
app.post("/api/imports/bank-statement", (req, res) => {
  const { filename, raw_text } = req.body as { filename?: unknown; raw_text?: unknown };
  if (!isOptionalString(filename) || !isOptionalString(raw_text)) {
    res.status(400).json({ error: "filename and raw_text must be strings" });
    return;
  }
  const r = db
    .prepare(
      `INSERT INTO import_batches (kind, filename, status, raw_text) VALUES ('bank_statement', ?, 'pending', ?)`
    )
    .run(filename ?? null, raw_text ?? null);
  res.status(201).json({ id: Number(r.lastInsertRowid), status: "pending" });
});

/**
 * Terminal error handler: route throws (sync or via asyncHandler) return JSON instead of
 * Express's default HTML stack-trace page, and the process stays up.
 */
}
