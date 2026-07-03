/** Credit-card installments, purchases, statement lines, web-paste/PDF imports, config. Split verbatim from index.ts; paths unchanged. */
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
import { recomputeCcBillingMonthBalances } from "../ccBillingBalances.js";
import {
  applyCreditCardConfigPatch,
  getCreditCardAccountConfig,
  isCreditCardAccountId,
  listOperationalCreditCards,
  parseCreditCardConfigPatch,
} from "../ccAccountConfig.js";
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

export function registerCreditCardRoutes(app: express.Express): void {
app.get("/api/accounts/:id/cc-installments", (req, res) => {
  const id = operationalAccountIdFromReq(req);
  if (!Number.isFinite(id) || id <= 0) {
    res.status(400).json({ error: "invalid account id" });
    return;
  }
  const bucketSlug = bucketSlugForAccountId(id);
  if (!bucketSlug) {
    res.status(404).json({ error: "account not found" });
    return;
  }
  if (accountKindSlugForAccountId(id) !== "credit_card") {
    res.json({
      account_id: id,
      has_installment_ledger: false,
      has_imported_statements: false,
      meta: null,
      purchases: [],
      purchases_completed: [],
      months: [],
      totals: {
        total_remaining_principal_clp: 0,
        next_calendar_month_total_clp: null,
        next_calendar_month: null,
      },
    });
    return;
  }
  const extra = parseExtraOffsetsJson(req.query.extraOffsets);
  const proxyTickers = parseProxyTickersParam(req.query.proxy_tickers);
  res.json(creditCardInstallmentsResponse(id, extra, proxyTickers ?? undefined));
});

app.get("/api/cc-proxy-tickers", (_req, res) => {
  res.json({ tickers: getCcProxyTickers() });
});

app.put("/api/cc-proxy-tickers", (req, res) => {
  const body = req.body as Record<string, unknown>;
  if (!Array.isArray(body.tickers) || !body.tickers.every((t) => typeof t === "string")) {
    res.status(400).json({ error: "tickers must be an array of strings" });
    return;
  }
  const tickers = (body.tickers as string[]).map((t) => t.trim()).filter(Boolean);
  if (tickers.length === 0) {
    res.status(400).json({ error: "tickers must not be empty" });
    return;
  }
  setCcProxyTickers(tickers);
  res.json({ tickers });
});

app.patch("/api/accounts/:id/cc-purchases/:purchaseId", (req, res) => {
  const id = operationalAccountIdFromReq(req);
  const purchaseId = Number(req.params.purchaseId);
  if (!Number.isFinite(purchaseId) || purchaseId <= 0) {
    res.status(400).json({ error: "invalid purchase id" });
    return;
  }
  const body = req.body as Record<string, unknown>;
  try {
    updateManualCcInstallmentPurchase(id, purchaseId, {
      purchase_date: body.purchase_date != null ? String(body.purchase_date) : undefined,
      total_amount_clp:
        body.total_amount_clp != null ? Number(body.total_amount_clp) : undefined,
      cuotas_totales: body.cuotas_totales != null ? Number(body.cuotas_totales) : undefined,
      merchant: body.merchant != null ? String(body.merchant) : undefined,
      description: body.description != null ? String(body.description) : undefined,
    });
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : "update failed" });
  }
});

app.delete("/api/accounts/:id/cc-purchases/:purchaseId", (req, res) => {
  const id = operationalAccountIdFromReq(req);
  const purchaseId = Number(req.params.purchaseId);
  if (!Number.isFinite(purchaseId) || purchaseId <= 0) {
    res.status(400).json({ error: "invalid purchase id" });
    return;
  }
  try {
    deleteManualCcInstallmentPurchase(id, purchaseId);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : "delete failed" });
  }
});

app.delete("/api/accounts/:id/cc-statement-lines/:lineId", (req, res) => {
  const id = operationalAccountIdFromReq(req);
  const lineId = Number(req.params.lineId);
  if (!Number.isFinite(lineId) || lineId <= 0) {
    res.status(400).json({ error: "invalid statement line id" });
    return;
  }
  try {
    deleteCcWebPasteStatementLine(id, lineId);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : "delete failed" });
  }
});

app.post("/api/accounts/:id/cc-statement-lines/:lineId/make-installment", (req, res) => {
  const id = operationalAccountIdFromReq(req);
  const lineId = Number(req.params.lineId);
  if (!Number.isFinite(lineId) || lineId <= 0) {
    res.status(400).json({ error: "invalid statement line id" });
    return;
  }
  const cuotas = Number(req.body?.cuotas_totales);
  if (!Number.isFinite(cuotas) || cuotas <= 0) {
    res.status(400).json({ error: "cuotas_totales must be a positive number" });
    return;
  }
  try {
    const result = convertStatementLineToInstallmentPurchase(id, lineId, cuotas);
    res.json({ ok: true, purchase_id: result.id });
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : "conversion failed" });
  }
});

app.get("/api/accounts/:id/import-specs", (req, res) => {
  const id = operationalAccountIdFromReq(req);
  if (!Number.isFinite(id) || id <= 0) {
    res.status(400).json({ error: "invalid account id" });
    return;
  }
  const bucketSlug = bucketSlugForAccountId(id);
  const bucketKind = bucketSlug ? accountBucketKindSlug(bucketSlug) : "";
  res.json({
    account_id: id,
    bucket_slug: bucketSlug,
    document_imports: documentImportSpecsForAccount(id),
    supports_cc_web_paste: bucketKind === "credit_card",
    supports_cc_statement_pdf: bucketKind === "credit_card",
    supports_checking_recent_xlsx: bucketKind === "cuenta_corriente",
    supports_checking_cartola_xlsx: bucketKind === "cuenta_corriente",
    supports_cuenta_vista_web_paste: bucketKind === "cuenta_vista",
  });
});

app.post("/api/accounts/:id/imports/cc-web-paste", (req, res) => {
  const id = operationalAccountIdFromReq(req);
  const text = typeof req.body?.text === "string" ? req.body.text : "";
  if (!text.trim()) {
    res.status(400).json({ error: "text is required" });
    return;
  }
  try {
    res.json(importCcWebPaste(id, text));
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : "import failed" });
  }
});

app.post("/api/accounts/:id/imports/cuenta-vista-web-paste", (req, res) => {
  const id = operationalAccountIdFromReq(req);
  const text = typeof req.body?.text === "string" ? req.body.text : "";
  if (!text.trim()) {
    res.status(400).json({ error: "text is required" });
    return;
  }
  try {
    res.json(importCuentaVistaWebPaste(id, text));
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : "import failed" });
  }
});

app.post(
  "/api/accounts/:id/imports/cc-statement-pdf",
  uploadFields([
    { name: "clp", maxCount: 1 },
    { name: "usd", maxCount: 1 },
    { name: "file", maxCount: 2 },
  ]) as unknown as express.RequestHandler,
  (req, res) => {
    const id = operationalAccountIdFromReq(req);
    const files = req.files as Record<string, { originalname: string; buffer: Buffer }[]> | undefined;
    const uploads: { originalname: string; buffer: Buffer }[] = [];
    for (const key of ["clp", "usd", "file"] as const) {
      for (const f of files?.[key] ?? []) {
        uploads.push({ originalname: f.originalname, buffer: f.buffer });
      }
    }
    if (!uploads.length) {
      res.status(400).json({ error: "Upload at least one PDF (field clp, usd, or file)" });
      return;
    }
    try {
      res.json(importCcStatementPdfUpload(id, uploads));
    } catch (e) {
      res.status(400).json({ error: e instanceof Error ? e.message : "import failed" });
    }
  }
);

app.post(
  "/api/accounts/:id/imports/checking-recent-xlsx",
  uploadSingle("file") as unknown as express.RequestHandler,
  (req, res) => {
    const id = operationalAccountIdFromReq(req);
    const f = req.file;
    if (!f) {
      res.status(400).json({ error: "file is required" });
      return;
    }
    try {
      res.json(importCheckingRecentXlsx(id, f.buffer, f.originalname));
    } catch (e) {
      res.status(400).json({ error: e instanceof Error ? e.message : "import failed" });
    }
  }
);

app.post(
  "/api/accounts/:id/imports/checking-cartola-xlsx",
  uploadSingle("file") as unknown as express.RequestHandler,
  (req, res) => {
    const id = operationalAccountIdFromReq(req);
    const f = req.file;
    if (!f) {
      res.status(400).json({ error: "file is required" });
      return;
    }
    const replaceMonth =
      typeof req.query.replaceMonth === "string" ? req.query.replaceMonth : undefined;
    try {
      res.json(importCheckingCartolaXlsx(id, f.buffer, f.originalname, { replaceMonth }));
    } catch (e) {
      res.status(400).json({ error: e instanceof Error ? e.message : "import failed" });
    }
  }
);

app.post(
  "/api/accounts/:id/imports/document",
  uploadSingle("file") as unknown as express.RequestHandler,
  (req, res) => {
    const id = operationalAccountIdFromReq(req);
    const f = req.file;
    const type = typeof req.body?.type === "string" ? req.body.type : "";
    if (!f) {
      res.status(400).json({ error: "file is required" });
      return;
    }
    if (!type) {
      res.status(400).json({ error: "type is required" });
      return;
    }
    try {
      res.json(
        importAccountDocument(id, type as "afp_uno_cert", f.buffer, f.originalname, f.mimetype)
      );
    } catch (e) {
      res.status(400).json({ error: e instanceof Error ? e.message : "import failed" });
    }
  }
);

app.get("/api/accounts/:id/credit-card-config", (req, res) => {
  const id = operationalAccountIdFromReq(req);
  if (!isCreditCardAccountId(id)) {
    res.status(404).json({ error: "not a credit-card account" });
    return;
  }
  res.json({ config: getCreditCardAccountConfig(id) });
});

app.patch("/api/accounts/:id/credit-card-config", (req, res) => {
  const id = operationalAccountIdFromReq(req);
  if (!isCreditCardAccountId(id)) {
    res.status(404).json({ error: "not a credit-card account" });
    return;
  }
  let patch;
  try {
    patch = parseCreditCardConfigPatch(req.body);
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : "invalid body" });
    return;
  }
  const result = applyCreditCardConfigPatch(id, patch);
  if (result.billingCycleChanged) recomputeCcBillingMonthBalances(id);
  res.json({
    config: result.config,
    billing_config: loadCreditCardBillingConfig(id),
  });
});

/** Operational credit cards (Tarjetas de crédito page): masters + config + current balance. */
app.get("/api/credit-cards", (_req, res) => {
  res.json({ cards: listOperationalCreditCards() });
});

}
