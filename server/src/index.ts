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
  deptoSueciaDashboardSnapshotAt,
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

seedNavTree();

function operationalAccountIdFromReq(req: { params: { id?: string } }): number {
  const raw = Number(req.params.id);
  if (!Number.isFinite(raw)) return NaN;
  return resolveOperationalAccountId(raw);
}

function parseProxyTickersParam(raw: unknown): string[] | null {
  if (raw == null || raw === "") return null;
  const str = String(raw).trim();
  if (!str) return null;
  const tickers = str.split(",").map((t) => t.trim()).filter(Boolean);
  return tickers.length > 0 ? tickers : null;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function isKnownClassTabGroup(group: string): boolean {
  if (group === "inversiones") return true;
  if (isResolvablePortfolioGroupSlug(group)) return true;
  const ag = db.prepare(`SELECT 1 AS o FROM asset_groups WHERE slug = ?`).get(group) as
    | { o: number }
    | undefined;
  return Boolean(ag);
}

/**
 * Account detail + dashboard position row.
 * **AFP:** when we have Σ cuotas and a reputable **valor cuota** (`fund_unit_daily`), **valor hoy** is
 * `cuotas × valor_cuota` so the three columns are consistent. If either is missing, falls back to the latest
 * `valuations` row (e.g. Excel month-end) like other accounts.
 */
function positionSnapshotFromMeta(
  categorySlug: string | null | undefined,
  meta: AccountPositionMeta | null,
  deposits_clp: number,
  latest: { value_clp: number; as_of_date: string } | null | undefined,
  accountId?: number
): DashboardAccountStats["position"] {
  if (meta == null) return null;
  const afp = categorySlug === "afp";
  const crypto = categorySlug === "bitcoin" || categorySlug === "eth";
  const v = latest?.value_clp;
  const units = meta.units;
  const ovc = meta.afp_override_value_clp;
  const mtmMark =
    (afp || crypto) && ovc != null && Number.isFinite(ovc) && (ovc > 0 || (crypto && ovc === 0));
  const value_clp = mtmMark ? ovc : v != null && Number.isFinite(v) ? v : null;
  const value_as_of =
    mtmMark
      ? meta.afp_override_value_as_of ?? null
      : latest?.as_of_date ?? null;
  const value_per_unit_clp =
    afp && meta.afp_override_valor_cuota_clp != null && Number.isFinite(meta.afp_override_valor_cuota_clp)
      ? meta.afp_override_valor_cuota_clp
      : v != null && units != null && units > 0 && Number.isFinite(v) && Number.isFinite(units)
        ? v / units
        : null;
  const equityReturns =
    accountId != null ? equityReturnSnapshot(accountId, deposits_clp, value_clp) : null;
  return {
    ticker: meta.ticker,
    units_kind: meta.units_kind,
    units,
    deposited_clp: deposits_clp,
    value_clp,
    value_as_of,
    value_per_unit_clp,
    ...(equityReturns ?? {}),
  };
}

loadRootDotenv();
ensureAccountSyncSourcesSeeded();

const app = express();
const PORT = Number(process.env.PORT) || 3001;
const HOST = resolveBindHost();

/**
 * Express 4 does not forward async-handler rejections to middleware; on Node ≥15 an
 * unhandled rejection kills the process. Every async route must go through this.
 */
const asyncHandler =
  (fn: (req: express.Request, res: express.Response) => Promise<void>): express.RequestHandler =>
  (req, res, next) => {
    fn(req, res).catch(next);
  };

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

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

/** Recursive portfolio groups (accounts + nested groups) with resolved colors. */
app.get("/api/meta/portfolio-tree", (_req, res) => {
  res.json({ roots: getPortfolioTreeForCharts() });
});

/** Sidebar navigation tree (DB-driven; matches legacy layout). */
app.get("/api/meta/sidebar-nav", (_req, res) => {
  res.json(getSidebarNavPayload());
});

/** Control panel account tree — all portfolio-linked accounts (includes chart-inactive). */
app.get("/api/meta/panel-net-worth-tree", (_req, res) => {
  res.json({ net_worth: getNetWorthNavGroupNode({ includeChartInactiveAccounts: true }) });
});

/** Market instruments for rates charts and marquee configuration. */
app.get("/api/meta/market-display-series", (_req, res) => {
  res.json({ series: listMarketDisplaySeries() });
});

app.get("/api/meta/rates-instruments", (_req, res) => {
  res.json({ instruments: listRatesInstrumentSeries() });
});

app.get("/api/accounts", asyncHandler(async (req, res) => {
  const portfolioGroupSlug =
    typeof req.query.portfolio_group === "string" ? req.query.portfolio_group.trim() : "";
  if (portfolioGroupSlug) {
    if (!isResolvablePortfolioGroupSlug(portfolioGroupSlug)) {
      res.status(400).json({ error: "unknown portfolio_group" });
      return;
    }
    const includeUsd = req.query.include_usd === "1" || req.query.include_usd === "true";
    const rows = await listPortfolioGroupAccountsForApi(portfolioGroupSlug, includeUsd);
    res.json({ accounts: rows });
    return;
  }

  const groupSlug = req.query.group as string | undefined;
  if (!groupSlug) {
    const rows = db
      .prepare(
        `SELECT a.id, a.name, a.notes, a.created_at, a.exclude_from_group_totals, a.color_rgb,
                g.slug AS bucket_slug, g.label AS bucket_label
         FROM accounts a
         INNER JOIN asset_groups g ON g.id = a.asset_group_id
         WHERE (a.notes IS NULL OR a.notes != ?)
           AND g.slug != 'individual_stocks'
           AND a.notes != 'liability_view|credit_card'
         ORDER BY g.sort_order, a.id, a.name`
      )
      .all(NOTE_STOCKS_LEGACY) as Record<string, unknown>[];
    res.json({ accounts: rows });
    return;
  }

  const subRaw = normalizeLegacyTabSubgroup(req.query.subgroup);
  if (subRaw === null) {
    res.status(400).json({ error: "invalid subgroup" });
    return;
  }
  const resolvedSlug =
    resolvePortfolioGroupSlugForLegacyTab(groupSlug, subRaw) ??
    (portfolioGroupBySlug(groupSlug) ? groupSlug : null);
  if (!resolvedSlug) {
    res.status(400).json({ error: "unknown group or subgroup" });
    return;
  }

  const tabRows = listAccountsForGroupTab(resolvedSlug);
  const ids = tabRows.map((r) => r.account_id);
  if (!ids.length) {
    res.json({ accounts: [] });
    return;
  }
  const ph = ids.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT a.id, a.name, a.notes, a.created_at, a.exclude_from_group_totals, a.color_rgb,
              g.slug AS bucket_slug, g.label AS bucket_label
       FROM accounts a
       INNER JOIN asset_groups g ON g.id = a.asset_group_id
       WHERE a.id IN (${ph})
       ORDER BY g.sort_order, a.id, a.name`
    )
    .all(...ids) as Record<string, unknown>[];
  res.json({ accounts: rows });
}));

app.post("/api/accounts", asyncHandler(async (req, res) => {
  const body = req.body as Record<string, unknown>;
  if (body.account != null && typeof body.account === "object") {
    const acc = body.account as Record<string, unknown>;
    try {
      const result = createPanelAccount(body as PanelAccountCreateBody);
      if (result.ticker) {
        await syncEquityEodFromYahoo([result.ticker], { force: true });
      }
      res.status(201).json(result);
    } catch (e) {
      const err = e as Error & { status?: number };
      const status = err.status && err.status >= 400 && err.status < 600 ? err.status : 500;
      res.status(status).json({ error: err.message || "create account failed" });
    }
    return;
  }

  const { asset_group_id, name, notes } = body as {
    asset_group_id?: unknown;
    name?: string;
    notes?: string;
  };
  if (!isPositiveInteger(asset_group_id) || !name?.trim()) {
    res.status(400).json({ error: "asset_group_id and name required" });
    return;
  }
  const r = db
    .prepare(
      `INSERT INTO accounts (asset_group_id, name, notes) VALUES (?, ?, ?)`
    )
    .run(asset_group_id, name.trim(), notes ?? null);
  const id = Number(r.lastInsertRowid);
  db.prepare(`UPDATE accounts SET color_rgb = ? WHERE id = ?`).run(prettyRgbTripletForAccountId(id), id);
  res.status(201).json({ id });
}));

app.delete("/api/accounts/:id", (req, res) => {
  const id = operationalAccountIdFromReq(req);
  if (!Number.isFinite(id) || id <= 0) {
    res.status(400).json({ error: "invalid account id" });
    return;
  }
  const exists = db.prepare(`SELECT 1 AS o FROM accounts WHERE id = ?`).get(id) as { o: number } | undefined;
  if (!exists) {
    res.status(404).json({ error: "account not found" });
    return;
  }
  try {
    const r = db.prepare(`DELETE FROM accounts WHERE id = ?`).run(id);
    res.json({ ok: true, deleted: r.changes });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.toLowerCase().includes("foreign key")) {
      res.status(409).json({
        error:
          "cannot delete account with linked records (movements, valuations, or related references)",
      });
      return;
    }
    res.status(500).json({ error: msg });
  }
});

app.patch("/api/accounts/:id/color", (req, res) => {
  const id = operationalAccountIdFromReq(req);
  if (!Number.isFinite(id) || id <= 0) {
    res.status(400).json({ error: "invalid account id" });
    return;
  }
  const body = req.body as { color_rgb?: unknown };
  const updated = updateAccountColorRgb(id, body.color_rgb);
  if (!updated) {
    const exists = db.prepare(`SELECT 1 AS o FROM accounts WHERE id = ?`).get(id) as { o: number } | undefined;
    if (!exists) {
      res.status(404).json({ error: "account not found" });
      return;
    }
    res.status(400).json({ error: body.color_rgb === null ? "invalid request" : "invalid color_rgb" });
    return;
  }
  res.json(updated);
});

app.patch("/api/accounts/:id/exclude-from-group-totals", (req, res) => {
  const id = operationalAccountIdFromReq(req);
  if (!Number.isFinite(id) || id <= 0) {
    res.status(400).json({ error: "invalid account id" });
    return;
  }
  const body = req.body as { exclude_from_group_totals?: unknown };
  const updated = updateAccountExcludeFromGroupTotals(id, body.exclude_from_group_totals);
  if (!updated) {
    const exists = db.prepare(`SELECT 1 AS o FROM accounts WHERE id = ?`).get(id) as
      | { o: number }
      | undefined;
    if (!exists) {
      res.status(404).json({ error: "account not found" });
      return;
    }
    res.status(400).json({ error: "exclude_from_group_totals must be boolean" });
    return;
  }
  res.json(updated);
});

app.patch("/api/portfolio-groups/:slug/color", (req, res) => {
  const slug = String(req.params.slug ?? "").trim();
  if (!slug) {
    res.status(400).json({ error: "slug required" });
    return;
  }
  const body = req.body as { color_rgb?: unknown };
  const updated = updatePortfolioGroupColorRgb(slug, body.color_rgb);
  if (!updated) {
    const exists = db
      .prepare(`SELECT 1 AS o FROM portfolio_groups WHERE slug = ?`)
      .get(slug) as { o: number } | undefined;
    if (!exists) {
      res.status(404).json({ error: "portfolio group not found" });
      return;
    }
    res.status(400).json({ error: "invalid color_rgb" });
    return;
  }
  res.json(updated);
});

app.get("/api/portfolio-groups/:slug/cc-ledger", (req, res) => {
  const slug = String(req.params.slug ?? "").trim();
  if (!slug || !isResolvablePortfolioGroupSlug(slug)) {
    res.status(404).json({ error: "portfolio group not found" });
    return;
  }
  const extra = parseExtraOffsetsJson(req.query.extraOffsets);
  res.json(creditCardGroupLedgerResponse(slug, extra));
});

app.get("/api/portfolio-groups/:slug/mortgage-ledger", (req, res) => {
  const slug = String(req.params.slug ?? "").trim();
  if (!slug || !isResolvablePortfolioGroupSlug(slug)) {
    res.status(404).json({ error: "portfolio group not found" });
    return;
  }
  res.json(mortgageGroupLedgerResponse(slug));
});

app.get("/api/accounts/:id/valuation-timeseries", (req, res) => {
  const id = operationalAccountIdFromReq(req);
  if (!Number.isFinite(id) || id <= 0) {
    res.status(400).json({ error: "invalid account id" });
    return;
  }
  const includeUsd = req.query.include_usd === "1" || req.query.include_usd === "true";
  const unit: TsUnit = includeUsd ? "usd" : "clp";
  const granularity = req.query.granularity === "daily" ? "daily" : "monthly";
  const payload = getAccountValuationTimeseries(id, unit, { granularity });
  if (!payload) {
    res.status(404).json({ error: "account not found" });
    return;
  }
  res.json(attachColorsToValuationPayload(payload));
});

app.get("/api/accounts/:id/detail-bundle", asyncHandler(async (req, res) => {
  const id = operationalAccountIdFromReq(req);
  if (!Number.isFinite(id) || id <= 0) {
    res.status(400).json({ error: "invalid account id" });
    return;
  }
  const includeUsd = req.query.include_usd === "1" || req.query.include_usd === "true";
  const unit: TsUnit = includeUsd ? "usd" : "clp";
  const granularity = req.query.granularity === "daily" ? "daily" : "monthly";
  let extraOffsets: Record<string, number> = {};
  if (typeof req.query.extraOffsets === "string" && req.query.extraOffsets.trim()) {
    extraOffsets = parseExtraOffsetsJson(req.query.extraOffsets);
  }
  const payload = await buildAccountDetailBundle(id, unit, granularity, extraOffsets);
  if (!payload) {
    res.status(404).json({ error: "account not found" });
    return;
  }
  res.json(payload);
}));

/** Month-on-month P/L from valuations + merged capital flows (not persisted). Empty for `cuenta_corriente`. */
app.get("/api/accounts/:id/performance-monthly", (req, res) => {
  const id = operationalAccountIdFromReq(req);
  if (!Number.isFinite(id) || id <= 0) {
    res.status(400).json({ error: "invalid account id" });
    return;
  }
  const includeUsd = req.query.include_usd === "1" || req.query.include_usd === "true";
  const unit: TsUnit = includeUsd ? "usd" : "clp";
  const payload = getAccountMonthlyPerformance(id, unit);
  if (!payload) {
    res.status(404).json({ error: "account not found" });
    return;
  }
  res.json(payload);
});

/** Cuenta corriente: per-cartola month totals from `checking_cartola_imports` + movements. */
app.get("/api/accounts/:id/checking-cartola-months", (req, res) => {
  const id = operationalAccountIdFromReq(req);
  if (!Number.isFinite(id) || id <= 0) {
    res.status(400).json({ error: "invalid account id" });
    return;
  }
  const payload = getCheckingCartolaMonths(id);
  if (!payload) {
    res.status(400).json({ error: "account is not a cash cartola account (cuenta corriente or cuenta vista)" });
    return;
  }
  res.json(payload);
});

app.put("/api/accounts/:id/checking-ledger-anchor", (req, res) => {
  const accountId = operationalAccountIdFromReq(req);
  if (!Number.isFinite(accountId) || accountId <= 0) {
    res.status(400).json({ error: "invalid account id" });
    return;
  }
  const payload = getCheckingCartolaMonths(accountId);
  if (!payload) {
    res.status(400).json({ error: "account is not a cash cartola account (cuenta corriente or cuenta vista)" });
    return;
  }
  const body = req.body as { clear?: boolean; amount_clp?: number; occurred_on?: string };
  if (body.clear === true) {
    clearCheckingLedgerAnchor(accountId);
    res.json({
      ledger_anchor: null,
      cartola_derived_anchor: getCheckingCartolaMonths(accountId)?.cartola_derived_anchor ?? null,
    });
    return;
  }
  const amount = body.amount_clp;
  const occurredOn = body.occurred_on;
  if (amount == null || !Number.isFinite(amount)) {
    res.status(400).json({ error: "amount_clp required (number, 0 allowed)" });
    return;
  }
  if (!occurredOn || !/^\d{4}-\d{2}-\d{2}$/.test(occurredOn)) {
    res.status(400).json({ error: "occurred_on required (YYYY-MM-DD)" });
    return;
  }
  const saved = upsertCheckingLedgerAnchor(accountId, {
    amount_clp: Math.round(amount),
    occurred_on: occurredOn,
  });
  if (!saved) {
    res.status(400).json({ error: "no cartola saldo final to anchor against" });
    return;
  }
  res.json({
    ledger_anchor: saved,
    cartola_derived_anchor: getCheckingCartolaMonths(accountId)?.cartola_derived_anchor ?? null,
  });
});

app.get("/api/accounts/:id/deposit-inflows", (req, res) => {
  const id = operationalAccountIdFromReq(req);
  if (!Number.isFinite(id) || id <= 0) {
    res.status(400).json({ error: "invalid account id" });
    return;
  }
  const exists = db.prepare(`SELECT 1 AS o FROM accounts WHERE id = ?`).get(id) as { o: number } | undefined;
  if (!exists) {
    res.status(404).json({ error: "account not found" });
    return;
  }
  const bucketSlug = bucketSlugForAccountId(id) ?? "";
  const events = getMergedDepositInflowEventsForAccount(id);
  const displayEvents = getMergedDisplayDepositInflowEventsForAccount(id);
  const stateEvents = getStateContributionInflowEventsForAccount(id);
  const total_clp = totalDepositsClpForAccount(id);
  const display_total_clp = totalDisplayDepositsClpForAccount(id);
  let cumulative_clp = 0;
  const events_with_cumulative = events.map((e) => {
    cumulative_clp += e.amt;
    return { occurred_on: e.occurred_on, amt_clp: e.amt, cumulative_clp };
  });
  let display_cumulative_clp = 0;
  const display_events = displayEvents.map((e) => {
    display_cumulative_clp += e.amt;
    return { occurred_on: e.occurred_on, amt_clp: e.amt, cumulative_clp: display_cumulative_clp };
  });
  let state_cumulative_clp = 0;
  const state_contribution_events = stateEvents.map((e) => {
    state_cumulative_clp += e.amt;
    return { occurred_on: e.occurred_on, amt_clp: e.amt, cumulative_clp: state_cumulative_clp };
  });
  res.json({
    account_id: id,
    total_clp,
    display_total_clp,
    events: events_with_cumulative,
    display_events,
    state_contribution_total_clp: totalStateContributionsClpForAccount(id),
    state_contribution_events,
  });
});

app.get("/api/accounts/:id/summary", asyncHandler(async (req, res) => {
  const id = operationalAccountIdFromReq(req);
  const withdrawals_clp = totalWithdrawalsClpForAccount(id);
  const metaRow = db
    .prepare(
      `SELECT g.slug AS bucket_slug, g.label AS bucket_label, a.name AS account_name, a.notes AS account_notes
       FROM accounts a
       JOIN asset_groups g ON g.id = a.asset_group_id
       WHERE a.id = ?`
    )
    .get(id) as
    | {
        bucket_slug: string;
        bucket_label: string;
        account_name: string;
        account_notes: string | null;
      }
    | undefined;
  const bucketSlug = metaRow?.bucket_slug ?? "";
  const bucketKind = bucketSlug ? accountBucketKindSlug(bucketSlug) : "";
  const dashBucket = dashboardBucketForAssetGroupSlug(bucketSlug) ?? bucketSlug;
  const group_peer_count = (
    db
      .prepare(
        `SELECT COUNT(*) AS c FROM accounts a
         JOIN asset_groups g ON g.id = a.asset_group_id
         WHERE g.slug = ?
           AND (a.notes IS NULL OR a.notes != ?)
           AND g.slug != 'individual_stocks'
           AND COALESCE(a.exclude_from_group_totals, 0) = 0`
      )
      .get(bucketSlug, NOTE_STOCKS_LEGACY) as { c: number }
  ).c;
  const accountRow = accountRowForId(id);
  const deposits_clp = pocketDepositsClpForAccount(id);
  const deposits_full_clp = totalDepositsClpForAccount(id);
  let latest = await latestValuationDisplayForAccount(id, bucketKind || null, {
    notes: metaRow?.account_notes ?? null,
    name: metaRow?.account_name ?? null,
  });
  if (latest == null && bucketKind && !isMovementBalanceCashCategory(bucketKind)) {
    const stored = latestValuationRowOnOrBeforeChileToday(id);
    if (stored?.value_clp != null) latest = stored as { value_clp: number; as_of_date: string };
  }
  const asOfCuotas = latest?.as_of_date ?? chileCalendarTodayYmd();
  const positionMeta = metaRow
    ? getAccountPositionMeta(id, bucketKind, {
        afpCuotasAsOfYmd: bucketKind === "afp" ? asOfCuotas : undefined,
        accountNotes: metaRow.account_notes,
        accountName: metaRow.account_name,
      })
    : null;
  const position = positionSnapshotFromMeta(
    bucketKind || null,
    positionMeta,
    deposits_clp,
    latest ?? undefined,
    id
  );
  let latest_valuation_clp = latest?.value_clp ?? null;
  let latest_valuation_date = latest?.as_of_date ?? null;
  if (
    metaRow &&
    (bucketKind === "afp" ||
      (metaRow.account_notes?.startsWith("import:fintual|cert|key=") ?? false) ||
      accountUsesEquityMtm(id)) &&
    position?.value_clp != null
  ) {
    latest_valuation_clp = position.value_clp;
    if (position.value_as_of != null) latest_valuation_date = position.value_as_of;
  }
  res.json({
    account_id: id,
    bucket_slug: bucketSlug || null,
    group_slug: dashBucket,
    group_label: metaRow?.bucket_label ?? null,
    group_peer_count,
    deposits_clp,
    deposits_full_clp: accountUsesEquityMtm(id) ? deposits_full_clp : undefined,
    dividends_reinvested_clp: accountUsesEquityMtm(id)
      ? totalDividendsReinvestedClpForAccount(id)
      : undefined,
    withdrawals_clp,
    latest_valuation_clp,
    latest_valuation_date,
    position,
    movement_create: accountRow ? movementCreateSchemaForAccount(accountRow) : null,
    book_ledger_edit: bookLedgerEditSchemaForAccount(id),
    mortgage_payment_create: mortgagePaymentCreateSchemaForAccount(id),
  });
}));

app.get("/api/accounts/:id/movements", (req, res) => {
  const id = operationalAccountIdFromReq(req);
  const rows = listAccountMovementsForApi(id);
  res.json({ movements: rows });
});

/** Inmuebles: dividendos sheet snapshot from SQLite (`depto_dividendos_sheet_rows`, filled at import:excel). */
app.get("/api/accounts/:id/mortgage-ledger", (req, res) => {
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
  if (bucketSlug === "property" || bucketSlug === "mortgage") {
    const sheetRowsAll = loadDeptoDividendosSheetLedgerFromDb();
    const sheetRows =
      bucketSlug === "mortgage"
        ? sheetRowsAll.filter((r) => isDeptoMortgagePaymentCuota(r.cuota))
        : sheetRowsAll;
    const payment_scenarios = buildDeptoPaymentScenarioRows(sheetRowsAll);
    res.json({
      account_id: id,
      has_sheet_rows: sheetRowsAll.length > 0,
      meta: sheetRowsAll.length > 0 ? mortgageMetaFromSheetRows(sheetRowsAll) : null,
      rows: sheetRows,
      payment_scenarios,
    });
    return;
  }
  res.json({
    account_id: id,
    has_sheet_rows: false,
    meta: null,
    rows: [] as unknown[],
  });
});

app.post("/api/accounts/:id/mortgage-payments/preview", (req, res) => {
  const id = operationalAccountIdFromReq(req);
  try {
    const input = parseMortgagePaymentBody(req.body as Record<string, unknown>);
    const preview = previewMortgagePayment(id, input);
    res.json(preview);
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

app.post("/api/accounts/:id/mortgage-payments", (req, res) => {
  const id = operationalAccountIdFromReq(req);
  try {
    const input = parseMortgagePaymentBody(req.body as Record<string, unknown>);
    const result = commitMortgagePayment(id, input);
    res.status(201).json(result);
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

/** Tarjeta de crédito: cupos desde SQLite (`cc_installment_*` o estados PDF); sin lectura runtime del CSV. */
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

app.patch("/api/accounts/:id/credit-card-config", (req, res) => {
  const id = operationalAccountIdFromReq(req);
  const body = req.body as Record<string, unknown>;
  const start =
    body.billing_cycle_start_day != null ? Number(body.billing_cycle_start_day) : undefined;
  const end =
    body.billing_cycle_end_day !== undefined
      ? body.billing_cycle_end_day == null
        ? null
        : Number(body.billing_cycle_end_day)
      : undefined;
  if (start != null && (!Number.isFinite(start) || start < 1 || start > 31)) {
    res.status(400).json({ error: "invalid billing_cycle_start_day" });
    return;
  }
  if (end != null && end !== undefined && (!Number.isFinite(end) || end < 1 || end > 31)) {
    res.status(400).json({ error: "invalid billing_cycle_end_day" });
    return;
  }
  patchCreditCardBillingConfig(id, {
    billing_cycle_start_day: start,
    billing_cycle_end_day: end,
  });
  recomputeCcBillingMonthBalances(id);
  res.json({ billing_config: loadCreditCardBillingConfig(id) });
});

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

app.get("/api/fx/latest", (_req, res) => {
  const row = db
    .prepare(`SELECT date, clp_per_usd FROM fx_daily WHERE date <= ? ORDER BY date DESC LIMIT 1`)
    .get(chileCalendarTodayYmd()) as { date: string; clp_per_usd: number } | undefined;
  res.json(row ?? null);
});

app.get("/api/fx/coverage", (_req, res) => {
  res.json(buildFxCoverage());
});

app.get("/api/fx/bid-ask/gaps", (_req, res) => {
  res.json({ gaps: listFxBidAskGaps() });
});

/** Upsert directional FX: body { date, buy_clp_per_usd, sell_clp_per_usd } */
app.post("/api/fx/bid-ask", (req, res) => {
  const { date, buy_clp_per_usd, sell_clp_per_usd } = req.body as {
    date?: string;
    buy_clp_per_usd?: number;
    sell_clp_per_usd?: number;
  };
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    res.status(400).json({ error: "date (YYYY-MM-DD) required" });
    return;
  }
  if (
    buy_clp_per_usd == null ||
    sell_clp_per_usd == null ||
    !Number.isFinite(buy_clp_per_usd) ||
    !Number.isFinite(sell_clp_per_usd) ||
    buy_clp_per_usd <= 0 ||
    sell_clp_per_usd <= 0
  ) {
    res.status(400).json({ error: "positive buy_clp_per_usd and sell_clp_per_usd required" });
    return;
  }
  if (buy_clp_per_usd < sell_clp_per_usd) {
    res.status(400).json({ error: "buy_clp_per_usd must be >= sell_clp_per_usd" });
    return;
  }
  try {
    const row = upsertManualFxBidAskRow(date, buy_clp_per_usd, sell_clp_per_usd);
    res.json({ ok: true, row });
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

app.get("/api/fx", (_req, res) => {
  const rows = db
    .prepare(`SELECT date, clp_per_usd FROM fx_daily ORDER BY date DESC LIMIT 365`)
    .all();
  res.json({ rates: rows });
});

/** Upsert FX: body { date: 'YYYY-MM-DD', clp_per_usd: number } */
app.post("/api/fx", (req, res) => {
  const { date, clp_per_usd } = req.body as { date?: unknown; clp_per_usd?: unknown };
  if (!isYmdString(date)) {
    res.status(400).json({ error: "date must be YYYY-MM-DD" });
    return;
  }
  if (!isPositiveFiniteNumber(clp_per_usd)) {
    res.status(400).json({ error: "positive clp_per_usd required" });
    return;
  }
  db.prepare(
    `INSERT INTO fx_daily (date, clp_per_usd) VALUES (?, ?)
     ON CONFLICT(date) DO UPDATE SET clp_per_usd = excluded.clp_per_usd`
  ).run(date, clp_per_usd);
  res.json({ ok: true });
});

app.get("/api/uf/latest", (_req, res) => {
  const row = db
    .prepare(`SELECT date, clp_per_uf FROM uf_daily WHERE date <= ? ORDER BY date DESC LIMIT 1`)
    .get(chileCalendarTodayYmd()) as { date: string; clp_per_uf: number } | undefined;
  res.json(row ?? null);
});

app.get("/api/uf", (_req, res) => {
  const rows = db.prepare(`SELECT date, clp_per_uf FROM uf_daily ORDER BY date DESC LIMIT 500`).all();
  res.json({ rates: rows });
});

/** Upsert UF (CLF): body { date: 'YYYY-MM-DD', clp_per_uf: number } CLP per 1 UF */
app.post("/api/uf", (req, res) => {
  const { date, clp_per_uf } = req.body as { date?: unknown; clp_per_uf?: unknown };
  if (!isYmdString(date)) {
    res.status(400).json({ error: "date must be YYYY-MM-DD" });
    return;
  }
  if (!isPositiveFiniteNumber(clp_per_uf)) {
    res.status(400).json({ error: "positive clp_per_uf required" });
    return;
  }
  db.prepare(
    `INSERT INTO uf_daily (date, clp_per_uf) VALUES (?, ?)
     ON CONFLICT(date) DO UPDATE SET clp_per_uf = excluded.clp_per_uf`
  ).run(date, clp_per_uf);
  res.json({ ok: true });
});

app.get("/api/market-series", (_req, res) => {
  res.json(getMarketSeriesPayload());
});

app.get("/api/market-ticker", (_req, res) => {
  try {
    res.json(getMarketTickerPayload());
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : "market_ticker_failed" });
  }
});

app.get("/api/watchlist", async (_req, res) => {
  try {
    res.json(await getWatchlistPayload());
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : "watchlist_failed" });
  }
});

app.patch("/api/watchlist/:id", (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id) || id <= 0) {
    res.status(400).json({ error: "invalid id" });
    return;
  }
  const body = req.body as { show_in_marquee?: number; sort_order?: number };
  try {
    res.json(patchWatchlistRow(id, body));
  } catch (e) {
    const msg = e instanceof Error ? e.message : "watchlist_patch_failed";
    res.status(400).json({ error: msg });
  }
});

app.post("/api/watchlist", (req, res) => {
  const ticker = typeof req.body?.ticker === "string" ? req.body.ticker : "";
  if (!ticker.trim()) {
    res.status(400).json({ error: "ticker required" });
    return;
  }
  try {
    res.status(201).json(addManualWatchlistTicker(ticker));
  } catch (e) {
    const msg = e instanceof Error ? e.message : "watchlist_add_failed";
    const status = msg.includes("already") ? 409 : 400;
    res.status(status).json({ error: msg });
  }
});

app.delete("/api/watchlist/:id", (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id) || id <= 0) {
    res.status(400).json({ error: "invalid id" });
    return;
  }
  try {
    deleteManualWatchlistRow(id);
    res.json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "watchlist_delete_failed";
    res.status(400).json({ error: msg });
  }
});

app.get("/api/flows/deposits", (_req, res) => {
  res.json(buildFlowsDepositsPayload());
});

app.get("/api/flows/deposits/reconciliation", (_req, res) => {
  try {
    res.json(buildDepositsReconciliationPayload());
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.get("/api/income", (_req, res) => {
  res.json(buildFlowsCheckingIncomePayload());
});

app.post("/api/income", (req, res) => {
  const { amount_clp, received_on, source, note } = req.body as {
    amount_clp?: unknown;
    received_on?: unknown;
    source?: string;
    note?: string;
  };
  if (!isFiniteNumber(amount_clp)) {
    res.status(400).json({ error: "amount_clp must be a finite number" });
    return;
  }
  if (!isYmdString(received_on)) {
    res.status(400).json({ error: "received_on must be YYYY-MM-DD" });
    return;
  }
  const r = db
    .prepare(
      `INSERT INTO income_entries (amount_clp, received_on, source, note) VALUES (?, ?, ?, ?)`
    )
    .run(amount_clp, received_on, source ?? null, note ?? null);
  res.status(201).json({ id: Number(r.lastInsertRowid) });
});

app.patch("/api/work-earnings/:id", (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id) || id <= 0) {
    res.status(400).json({ error: "invalid id" });
    return;
  }
  const body = req.body as {
    earning_type?: PayrollEarningType;
    movement_id?: number | null;
  };
  if (body.earning_type != null && body.earning_type !== "salary" && body.earning_type !== "severance") {
    res.status(400).json({ error: "earning_type must be salary or severance" });
    return;
  }
  if (body.movement_id !== undefined && body.movement_id != null) {
    if (!Number.isFinite(body.movement_id) || body.movement_id <= 0) {
      res.status(400).json({ error: "invalid movement_id" });
      return;
    }
    try {
      assertMovementEligibleForPayrollLink(
        body.movement_id,
        listPayrollLinkCandidates()
      );
    } catch (e) {
      res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
      return;
    }
  }
  try {
    const row = updatePayrollWorkEarning(id, {
      earning_type: body.earning_type,
      movement_id: body.movement_id,
    });
    res.json(row);
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

app.patch("/api/income/movements/:movement_id", (req, res) => {
  const movementId = Number(req.params.movement_id);
  if (!Number.isFinite(movementId) || movementId <= 0) {
    res.status(400).json({ error: "invalid movement_id" });
    return;
  }
  const body = req.body as {
    income_kind?: CheckingIncomeKind;
    excluded?: boolean;
    force_include?: boolean;
    note?: string | null;
  };
  if (
    body.income_kind != null &&
    body.income_kind !== "salary" &&
    body.income_kind !== "severance" &&
    body.income_kind !== "other" &&
    body.income_kind !== "parent_gift"
  ) {
    res.status(400).json({
      error: "income_kind must be salary, severance, other, or parent_gift",
    });
    return;
  }
  if (
    body.income_kind === undefined &&
    body.excluded === undefined &&
    body.force_include === undefined &&
    body.note === undefined
  ) {
    res.status(400).json({ error: "income_kind, excluded, force_include, or note required" });
    return;
  }
  try {
    if (body.excluded === false) {
      restoreCheckingIncomeMovement(movementId);
      res.json({
        movement_id: movementId,
        excluded: false,
        force_include: false,
        income_kind: null,
        note: null,
      });
      return;
    }
    if (body.force_include === false) {
      clearCheckingIncomeForceInclude(movementId);
      res.json({
        movement_id: movementId,
        excluded: false,
        force_include: false,
        income_kind: null,
        note: null,
      });
      return;
    }
    const row = upsertCheckingIncomeMovementOverride(movementId, {
      income_kind: body.income_kind,
      excluded: body.excluded,
      force_include: body.force_include,
      note: body.note,
    });
    res.json({
      movement_id: row.movement_id,
      excluded: row.is_excluded === 1,
      force_include: row.force_include === 1,
      income_kind: row.income_kind,
      note: row.note,
    });
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

app.post("/api/income/movements/:movement_id/force-include", (req, res) => {
  const movementId = Number(req.params.movement_id);
  if (!Number.isFinite(movementId) || movementId <= 0) {
    res.status(400).json({ error: "invalid movement_id" });
    return;
  }
  try {
    const row = upsertCheckingIncomeMovementOverride(movementId, { force_include: true });
    res.json({
      ok: true,
      movement_id: row.movement_id,
      force_include: true,
    });
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

app.post("/api/income/movements/:movement_id/restore", (req, res) => {
  const movementId = Number(req.params.movement_id);
  if (!Number.isFinite(movementId) || movementId <= 0) {
    res.status(400).json({ error: "invalid movement_id" });
    return;
  }
  try {
    restoreCheckingIncomeMovement(movementId);
    res.json({ ok: true, movement_id: movementId });
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

app.get("/api/expenses", (_req, res) => {
  const rows = db
    .prepare(
      `SELECT id, amount_clp, spent_on, category, note, import_batch_id, expense_account_id
       FROM expense_entries ORDER BY spent_on DESC, id DESC`
    )
    .all();
  res.json({ expenses: rows });
});

app.get("/api/flows/expenses/credit-card", (req, res) => {
  const proxyTickers = parseProxyTickersParam(req.query.proxy_tickers);
  res.json(buildFlowsCreditCardExpensesPayload(proxyTickers ?? undefined));
});

app.get("/api/flows/expenses/credit-card/financing-links", (_req, res) => {
  res.json({ links: listCcFacturadoFinancingLinks() });
});

app.post("/api/flows/expenses/credit-card/financing-links", (req, res) => {
  const body = req.body as {
    financed_account_id?: number;
    financed_billing_month?: string;
    financing?: { account_id?: number; purchase_key?: string }[];
  };
  const financedAccountId = Number(body.financed_account_id);
  const financedBillingMonth = String(body.financed_billing_month ?? "").trim();
  const financing = (body.financing ?? [])
    .map((f) => ({ account_id: Number(f.account_id), purchase_key: String(f.purchase_key ?? "").trim() }))
    .filter((f) => Number.isFinite(f.account_id) && f.account_id > 0 && f.purchase_key.length > 0);
  if (!Number.isFinite(financedAccountId) || financedAccountId <= 0 || !financedBillingMonth) {
    res.status(400).json({ error: "financed_account_id and financed_billing_month required" });
    return;
  }
  try {
    const link = upsertCcFacturadoFinancingLink({
      financedAccountId,
      financedBillingMonth,
      financing,
    });
    res.json({ ok: true, id: link.id });
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : "link failed" });
  }
});

app.delete("/api/flows/expenses/credit-card/financing-links/:id", (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id) || id <= 0) {
    res.status(400).json({ error: "invalid link id" });
    return;
  }
  deleteCcFacturadoFinancingLink(id);
  res.status(204).send();
});

app.get("/api/flows/expenses/real-estate", (_req, res) => {
  res.json(buildRealEstateExpensesPayload());
});

app.get("/api/flows/expenses/real-estate/candidates", (req, res) => {
  const expenseEntryId = Number(req.query.expense_entry_id);
  if (!Number.isFinite(expenseEntryId) || expenseEntryId <= 0) {
    res.status(400).json({ error: "expense_entry_id required" });
    return;
  }
  res.json({ candidates: listRealEstateLinkCandidates(expenseEntryId) });
});

app.put("/api/flows/expenses/real-estate/links", (req, res) => {
  const body = req.body as { expense_entry_id?: number; purchase_key?: string };
  const expenseEntryId = Number(body.expense_entry_id);
  const purchaseKey = String(body.purchase_key ?? "").trim();
  if (!Number.isFinite(expenseEntryId) || expenseEntryId <= 0 || !purchaseKey) {
    res.status(400).json({ error: "expense_entry_id and purchase_key required" });
    return;
  }
  try {
    const link = manualLinkRealEstateExpense(expenseEntryId, purchaseKey);
    res.json(link);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "link failed";
    res.status(400).json({ error: msg });
  }
});

app.delete("/api/flows/expenses/real-estate/links/:expenseEntryId", (req, res) => {
  const expenseEntryId = Number(req.params.expenseEntryId);
  if (!Number.isFinite(expenseEntryId) || expenseEntryId <= 0) {
    res.status(400).json({ error: "invalid expense entry id" });
    return;
  }
  try {
    unmatchRealEstateExpense(expenseEntryId);
    res.status(204).send();
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unmatch failed";
    res.status(400).json({ error: msg });
  }
});

app.patch("/api/flows/expenses/credit-card/purchase-notes", (req, res) => {
  const body = req.body as {
    account_id?: number;
    purchase_key?: string;
    statement_line_id?: number;
    notes?: string | null;
  };
  const accountId = Number(body.account_id);
  if (!Number.isFinite(accountId) || accountId <= 0) {
    res.status(400).json({ error: "invalid account_id" });
    return;
  }
  let purchaseKey = String(body.purchase_key ?? "").trim();
  const statementLineId = Number(body.statement_line_id);
  if (!purchaseKey && Number.isFinite(statementLineId) && statementLineId > 0) {
    purchaseKey = resolveCcExpensePurchaseKey(statementLineId);
  }
  if (!purchaseKey) {
    res.status(400).json({ error: "purchase_key or statement_line_id required" });
    return;
  }
  try {
    const result = setCcExpensePurchaseNote({
      accountId,
      purchaseKey,
      notes: body.notes,
    });
    res.json({ account_id: accountId, purchase_key: purchaseKey, notes: result.notes });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "save failed";
    console.error("PATCH /api/flows/expenses/credit-card/purchase-notes", {
      body: req.body,
      error: msg,
      stack: e instanceof Error ? e.stack : undefined,
    });
    res.status(400).json({ error: msg });
  }
});

app.put("/api/flows/expenses/credit-card/purchase-big-group", (req, res) => {
  const body = req.body as {
    account_id?: number;
    purchase_key?: string;
    group_slug?: string | null;
  };
  const accountId = Number(body.account_id);
  if (!Number.isFinite(accountId) || accountId <= 0) {
    res.status(400).json({ error: "invalid account_id" });
    return;
  }
  const purchaseKey = String(body.purchase_key ?? "").trim();
  if (!purchaseKey) {
    res.status(400).json({ error: "purchase_key required" });
    return;
  }
  try {
    const result = setCcExpensePurchaseBigGroup({
      accountId,
      purchaseKey,
      groupSlug: body.group_slug,
    });
    res.json({
      account_id: accountId,
      purchase_key: purchaseKey,
      group_slug: result.group_slug,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "save failed";
    res.status(400).json({ error: msg });
  }
});

app.post("/api/flows/expenses/credit-card/big-groups", (req, res) => {
  const body = req.body as { label?: string };
  const label = String(body.label ?? "").trim();
  if (!label) {
    res.status(400).json({ error: "label required" });
    return;
  }
  try {
    const group = createCcExpenseBigGroup(label);
    res.status(201).json(group);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "create failed";
    res.status(400).json({ error: msg });
  }
});

app.patch("/api/flows/expenses/credit-card/big-groups/:slug", (req, res) => {
  const slug = String(req.params.slug ?? "").trim();
  const body = req.body as { label?: string };
  const label = String(body.label ?? "").trim();
  if (!slug || !label) {
    res.status(400).json({ error: "slug and label required" });
    return;
  }
  try {
    const group = renameCcExpenseBigGroup(slug, label);
    res.json(group);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "rename failed";
    res.status(400).json({ error: msg });
  }
});

app.delete("/api/flows/expenses/credit-card/big-groups/:slug", (req, res) => {
  const slug = String(req.params.slug ?? "").trim();
  if (!slug) {
    res.status(400).json({ error: "slug required" });
    return;
  }
  try {
    deleteCcExpenseBigGroup(slug);
    res.status(204).send();
  } catch (e) {
    const msg = e instanceof Error ? e.message : "delete failed";
    res.status(400).json({ error: msg });
  }
});

app.patch("/api/flows/expenses/credit-card/lines/:lineId/category", (req, res) => {
  const route = "PATCH /api/flows/expenses/credit-card/lines/:lineId/category";
  const lineId = Number(req.params.lineId);
  if (!Number.isFinite(lineId) || lineId === 0) {
    console.error(route, { lineId: req.params.lineId, reason: "line id must be non-zero finite" });
    res.status(400).json({ error: "invalid line id" });
    return;
  }
  const body = req.body as {
    category_slug?: string;
    unique?: boolean;
    clear_category?: boolean;
    source?: "cc" | "checking" | "manual";
  };
  const categorySlug = body.category_slug != null ? String(body.category_slug).trim() : "";
  const unique = !!body.unique;
  const clearCategory = body.clear_category === true;
  try {
    if (body.source === "manual") {
      res.status(400).json({ error: "manual expense entries are not editable" });
      return;
    }
    if (lineId < 0) {
      // Plan gastos lines encode purchaseId as -(3_000_000_000 + purchaseId*1000 + cuotaIndex).
      // Simple negative statement line ids encode purchaseId as -lineId directly.
      const purchaseId = purchaseIdFromPlanGastosLineId(lineId) ?? -lineId;
      const result = assignCcExpenseCategoryForManualLedgerInstallmentPurchase({
        purchaseId,
        unique,
        categorySlug: categorySlug || null,
        clearCategory,
      });
      res.json(result);
      return;
    }
    const bodySource = body.source;
    const source =
      bodySource === "checking" || bodySource === "cc" || bodySource === "manual"
        ? bodySource
        : undefined;
    const result = assignFlowExpenseLineCategory({
      lineId,
      source,
      unique,
      categorySlug: categorySlug || null,
      clearCategory,
    });
    res.json(result);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "assign failed";
    console.error(route, {
      lineId,
      body: req.body,
      error: msg,
      stack: e instanceof Error ? e.stack : undefined,
    });
    res.status(400).json({ error: msg });
  }
});

app.post("/api/expenses", (req, res) => {
  const { amount_clp, spent_on, category, note } = req.body as {
    amount_clp?: unknown;
    spent_on?: unknown;
    category?: string;
    note?: string;
  };
  if (!isPositiveFiniteNumber(amount_clp)) {
    res.status(400).json({ error: "positive amount_clp required" });
    return;
  }
  if (!isYmdString(spent_on)) {
    res.status(400).json({ error: "spent_on must be YYYY-MM-DD" });
    return;
  }
  try {
    const categorySlug = validateManualExpenseCategorySlug(category);
    const normalizedNote = normalizeManualExpenseNote(note);
    const r = db
      .prepare(
        `INSERT INTO expense_entries (amount_clp, spent_on, category, note) VALUES (?, ?, ?, ?)`
      )
      .run(amount_clp, spent_on, categorySlug, normalizedNote);
    res.status(201).json({ id: Number(r.lastInsertRowid) });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "invalid expense";
    res.status(400).json({ error: msg });
  }
});

/** Stale external sources + last sync state (AFP / Fintual / BCentral BDE). */
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
