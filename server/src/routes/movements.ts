/** Manual movement create, valuations upsert, aggregation cache clear. Split verbatim from index.ts; paths unchanged. */
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

export function registerMovementsRoutes(app: express.Express): void {
app.post("/api/accounts/:id/movements", (req, res) => {
  const accountId = operationalAccountIdFromReq(req);
  const account = accountRowForId(accountId);
  if (!account) {
    res.status(404).json({ error: "Account not found." });
    return;
  }
  const validated = validateMovementCreate(account, req.body as Record<string, unknown>, accountId);
  if (!validated.ok) {
    res.status(validated.status).json({ error: validated.error });
    return;
  }
  if (validated.mode === "transfer") {
    const r = db
      .prepare(
        `INSERT INTO movements (
           account_id, from_account_id, to_account_id, amount_clp, occurred_on, note,
           units_delta, flow_kind, amount_usd, ticker
         ) VALUES (NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        validated.from_account_id,
        validated.to_account_id,
        validated.amount_clp,
        validated.occurred_on,
        validated.note,
        validated.units_delta,
        validated.flow_kind,
        validated.amount_usd,
        validated.ticker
      );
    const id = Number(r.lastInsertRowid);
    invalidateAggregationForAccountDate(validated.from_account_id, validated.occurred_on);
    invalidateAggregationForAccountDate(validated.to_account_id, validated.occurred_on);
    // Reverse dedup: if a matching checking bank row was already imported, this transfer supersedes it.
    const superseded = supersedeImportedCheckingRowsForTransfer(
      validated.from_account_id,
      validated.to_account_id,
      validated.amount_clp,
      validated.occurred_on
    );
    res.status(201).json({
      id,
      from_account_id: validated.from_account_id,
      to_account_id: validated.to_account_id,
      units_delta: validated.units_delta,
      flow_kind: validated.flow_kind,
      superseded_imported_checking_ids: superseded.removed_ids,
    });
    return;
  }
  if (validated.mode === "brokerage") {
    const r = db
      .prepare(
        `INSERT INTO movements (account_id, amount_clp, occurred_on, note, units_delta, flow_kind, amount_usd, ticker)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        accountId,
        validated.amount_clp,
        validated.occurred_on,
        validated.note,
        validated.units_delta,
        validated.flow_kind,
        validated.amount_usd,
        validated.ticker
      );
    invalidateAggregationForAccountDate(accountId, validated.occurred_on);
    res.status(201).json({
      id: Number(r.lastInsertRowid),
      units_delta: validated.units_delta,
      flow_kind: validated.flow_kind,
    });
    return;
  }
  const { amount_clp, occurred_on, note, units_delta } = validated;
  const r = db
    .prepare(
      `INSERT INTO movements (account_id, amount_clp, occurred_on, note, units_delta) VALUES (?, ?, ?, ?, ?)`
    )
    .run(accountId, amount_clp, occurred_on, note, units_delta);
  const bucketKind = accountBucketKindSlug(account.bucket_slug);
  if (!isCheckingLedgerAnchorNote(note)) {
    maybeSyncCheckingLedgerAnchor(accountId, bucketKind);
  }
  invalidateAggregationForAccountDate(accountId, occurred_on);
  res.status(201).json({ id: Number(r.lastInsertRowid), units_delta });
});

app.get("/api/accounts/:id/valuations", (req, res) => {
  const id = operationalAccountIdFromReq(req);
  const rows = db
    .prepare(
      `SELECT id, as_of_date, value_clp FROM valuations WHERE account_id = ? ORDER BY as_of_date DESC`
    )
    .all(id);
  res.json({ valuations: rows });
});

app.post("/api/accounts/:id/valuations", (req, res) => {
  const accountId = operationalAccountIdFromReq(req);
  const { as_of_date, value_clp } = req.body as { as_of_date?: unknown; value_clp?: unknown };
  // Validate BEFORE the write: dates are compared lexically everywhere, so one malformed
  // as_of_date row poisons every on-or-before lookup for this account.
  if (!isYmdString(as_of_date)) {
    res.status(400).json({ error: "as_of_date must be YYYY-MM-DD" });
    return;
  }
  if (!isFiniteNumber(value_clp)) {
    res.status(400).json({ error: "value_clp must be a finite number" });
    return;
  }
  db.prepare(
    `INSERT INTO valuations (account_id, as_of_date, value_clp) VALUES (?, ?, ?)
     ON CONFLICT(account_id, as_of_date) DO UPDATE SET value_clp = excluded.value_clp`
  ).run(accountId, as_of_date, value_clp);
  invalidateAggregationForAccountDate(accountId, as_of_date);
  res.json({ ok: true });
});

app.post("/api/panel/cache/aggregation/clear", (_req, res) => {
  clearAggregationCache();
  res.json({ ok: true });
});

/** Home/group card strip shape only (accounts + layout; no valuation TS). */
}
