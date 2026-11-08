/**
 * The server's own declarations of the API DTOs must fit the shared ones in
 *  (docs/untangle-plan.md F8): typecheck-only, generated.
 */
import { describe, expect, it } from "vitest";
import type * as Dto from "nw-tracker-contracts/dto";
import type { AccountPositionSnapshot as S_AccountPositionSnapshot } from "../accountPosition.js";
import type { EquityBrokerHolding as S_EquityBrokerHolding } from "../equityBrokerHoldings.js";
import type { FxCoverage as S_FxCoverage } from "../fxCoverage.js";
import type { FxConversionWarningCode as S_FxConversionWarningCode, FxConversionWarning as S_FxConversionWarning } from "../fxConversionWarnings.js";
import type { FxBidAskGapRow as S_FxBidAskGapRow } from "../fxBidAskGaps.js";
import type { CcCloseSource as S_CcCloseSource } from "../cards/facturacion.js";
import type { UpcomingPaymentKind as S_UpcomingPaymentKind } from "../upcomingPayments.js";
import type { CcCuotaPurchaseKind as S_CcCuotaPurchaseKind } from "../ccCuotaPurchaseKinds.js";
import type { CcInstallmentPurchaseComputed as S_CcInstallmentPurchaseComputed, CcCuotaProgressCuota as S_CcCuotaProgressCuota, CcCuotaProgress as S_CcCuotaProgress, CcInstallmentMonthBreakdown as S_CcInstallmentMonthBreakdown, CcInstallmentCalendarMonthRow as S_CcInstallmentMonthRow } from "../cards/planTypes.js";
import type { CcFacturadoBarSegments as S_CcFacturadoBarSegments, CcHistorialChartPoint as S_CcHistorialChartPoint } from "../creditCardChartSeries.js";
import type { CcCupoEntry as S_CcCupoEntry, CreditCardAccountConfigDto as S_CreditCardAccountConfigDto } from "../ccAccountConfig.js";
import type { AccountMonthlyPerformanceRow as S_AccountMonthlyPerformanceRow } from "../accountPerformance.js";
import type { MortgagePaymentCreateSchema as S_MortgagePaymentCreateSchema, MortgagePaymentPreviewResponse as S_MortgagePaymentPreviewResponse } from "../mortgagePaymentCreate.js";
import type { CheckingLedgerAnchorDto as S_CheckingLedgerAnchorDto, CartolaDerivedAnchorDto as S_CartolaDerivedAnchorDto } from "../checkingCartolaBalances.js";
import type { CheckingCartolaMonthsResponse as S_CheckingCartolaMonthsResponse } from "../checkingCartolaMonthSummary.js";
import type { UnclassifiedGroup as S_UnclassifiedGroup, GroceryProductRow as S_GroceryProductRow, GroceryReceiptItemRow as S_GroceryReceiptItemRow, ProductHistoryRow as S_ProductHistoryRow, GroceryBaseUnit as S_GroceryBaseUnit, GroceryProductAliasConfigRow as S_GroceryProductAliasConfigRow, GroceryProductDetail as S_GroceryProductDetail, GroceryBrandRow as S_GroceryBrandRow } from "../groceryProducts.js";
import type { GroceryReceiptSource as S_GroceryReceiptSource } from "../storeReceiptApply.js";
import type { GroupMonthlyPerformanceBarAccount as S_GroupMonthlyPerformanceBarAccount } from "../groupMonthlyPlSeries.js";
import type { DashboardChartShapeLine as S_DashboardChartShapeLine, DashboardChartShape as S_DashboardChartShape } from "../valuationTimeseries.js";
import type { InversionesPerfPoint as S_InversionesPerfPoint } from "../inversionesPerfSeries.js";
import type { ConsolidatedMonthlyPerfRow as S_ConsolidatedMonthlyPerfRow } from "../groupMonthlyPerfConsolidation.js";
import type { GroupConsolidatedTablesResponse as S_GroupConsolidatedTablesResponse, GroupPeriodReturnsResponse as S_GroupPeriodReturnsResponse, GroupConsolidatedMonthlyPageResponse as S_GroupConsolidatedMonthlyPageResponse } from "../groupConsolidatedTables.js";
import type { FlowsApiRow as S_FlowsApiRow, FlowsFilterOptions as S_FlowsFilterOptions, FlowsPageResponse as S_FlowsPageResponse } from "../flowsApi.js";
import type { ChartBucketLineMetaDto as S_ChartBucketLineMetaDto, NavNodeChartBucketsDto as S_NavNodeChartBucketsDto } from "../groupChartBuckets.js";
import type { NavTreeNodeDto as S_NavTreeNodeDto } from "../navTree.js";
import type { DashboardLayoutCardRow as S_DashboardLayoutCardRow } from "../dashboardLayout.js";
import type { NavCardMetricsVariantDto as S_NavCardMetricsVariantDto, NavCardAmountDto as S_NavCardAmountDto, NavCardValueDto as S_NavCardValueDto, NavCardMetricsDto as S_NavCardMetricsDto, NavLiquidatedRowsDto as S_NavLiquidatedRowsDto } from "../dashboardNavCardMetrics.js";
import type { NavValueMapHoldingDto as S_NavValueMapHoldingDto, NavValueMapNodeDto as S_NavValueMapNodeDto } from "../navValueMap.js";
import type { NetWorthAthDto as S_NetWorthAthDto, NetWorthAthByPeriod as S_NetWorthAthByPeriod } from "../netWorthAllTimeHigh.js";
import type { PeriodReturnKey as S_PeriodReturnKey, PeriodReturnCell as S_PeriodReturnCell, PeriodReturnsPayload as S_PeriodReturnsPayload } from "../periodReturns.js";
import type { BenchmarkComparisonCell as S_BenchmarkComparisonCell, BenchmarkComparisonPayload as S_BenchmarkComparisonPayload } from "../benchmarkComparison.js";
import type { PrepaymentRow as S_PrepaymentRow, MortgagePrepaymentComparison as S_MortgagePrepaymentComparison } from "../mortgagePrepaymentComparison.js";
import type { DeptoMortgageSheetRow as S_DeptoMortgageSheetRow, DeptoPaymentScenarioTerm as S_DeptoPaymentScenarioTerm, DeptoPaymentScenarioCell as S_DeptoPaymentScenarioCell, DeptoPaymentScenarioRow as S_DeptoPaymentScenarioRow } from "../deptoDividendosLedger.js";
import type { MortgageCardLine as S_MortgageCardLine, MortgageCardMatchStatus as S_MortgageCardMatchStatus, MortgagePaymentCardMatch as S_MortgagePaymentCardMatch } from "../mortgagePaymentCardMatch.js";
import type { DepositFlowCategory as S_DepositFlowCategory, FlowDepositRow as S_FlowDepositRow, FlowDepositChartPoint as S_FlowDepositChartPoint } from "../flowsDeposits.js";
import type { FlowsPlBucketSlug as S_FlowsPlBucketSlug, FlowsPlChartPoint as S_FlowsPlChartPoint, FlowsPlAccountRow as S_FlowsPlAccountRow, FlowsPlBucketBlock as S_FlowsPlBucketBlock } from "../flowsPl.js";
import type { FlowsOverviewRow as S_FlowsOverviewRow, FlowsOverviewTotals as S_FlowsOverviewTotals, FlowsIncomeAggregates as S_FlowsIncomeAggregates } from "../flowsOverview.js";
import type { RealEstateChartSeriesDto as S_RealEstateChartSeriesDto, RealEstateChartScopeDto as S_RealEstateChartScopeDto, RealEstateExpenseLinkDto as S_RealEstateExpenseLinkDto, RealEstateBillSlot as S_RealEstateBillSlot, RealEstateUnlinkedPurchaseDto as S_RealEstateUnlinkedPurchaseDto, RealEstatePlaceDto as S_RealEstatePlaceDto, RealEstateExpenseAccountBlock as S_RealEstateExpenseAccountBlock, RealEstateLinkCandidateDto as S_RealEstateLinkCandidateDto } from "../flowsRealEstateExpenses.js";
import type { FlowCcExpenseMonthRow as S_FlowCcExpenseMonthRow, FlowCcExpenseChartPoint as S_FlowCcExpenseChartPoint, FlowCcExpenseLineSource as S_FlowCcExpenseLineSource, FlowCcExpenseLineRow as S_FlowCcExpenseLineRow, FlowCcExpenseCategoryChartPoint as S_FlowCcExpenseCategoryChartPoint } from "../flowsExpenses.js";
import type { ExpenseLineOrigin as S_ExpenseLineOrigin } from "../ccExpenseOriginLabel.js";
import type { CcFacturadoFinancingLink as S_CcFacturadoFinancingLink } from "../ccFacturadoFinancingLinksDb.js";
import type { ExpenseLinkLabel as S_ExpenseLinkLabel } from "../expenseDisplayNames.js";
import type { ManualExpenseInput as S_ManualExpenseInput } from "../flowsManualExpenses.js";
import type { ExpenseDepositLinkDto as S_ExpenseDepositLinkDto } from "../expenseDepositLinks.js";
import type { DepositReconciliationStatus as S_DepositReconciliationStatus, DepositReconciliationRow as S_DepositReconciliationRow, DepositReconciliationStatusTotals as S_DepositReconciliationStatusTotals, DepositReconciliationByMonth as S_DepositReconciliationByMonth, DepositRedemptionStatus as S_DepositRedemptionStatus, DepositRedemptionRow as S_DepositRedemptionRow, DepositManualAssertionStatus as S_DepositManualAssertionStatus, DepositManualAssertionRow as S_DepositManualAssertionRow } from "../flowsDepositsReconciliation.js";
import type { ExpenseYearMonthlyAverage as S_ExpenseYearMonthlyAverage, FlowsExpensesGastosView as S_FlowsExpensesGastosView, BigGroupUsage as S_BigGroupUsage } from "../flowsExpensesGastos.js";
import type { AdditionalCardsPeriodRow as S_AdditionalCardsPeriodRow, AdditionalCardsSummary as S_AdditionalCardsSummary } from "../additionalCardReimbursements.js";
import type { FlowCheckingIncomeLine as S_FlowCheckingIncomeLine, IncomeAutoFilterReason as S_IncomeAutoFilterReason, FlowFilteredCheckingIncomeLine as S_FlowFilteredCheckingIncomeLine, FlowManualIncomeLine as S_FlowManualIncomeLine } from "../flowsCheckingInflows.js";
import type { FlowExcludedCheckingIncomeLine as S_FlowExcludedCheckingIncomeLine } from "../flowsCheckingIncomeOverrides.js";
import type { PayslipCheckName as S_PayslipCheckName, PayslipCheck as S_PayslipCheck, PayslipChecksRow as S_PayslipChecksRow } from "../payslipChecks.js";
import type { PayrollBreakdownField as S_PayrollBreakdownField, PayrollBreakdownValues as S_PayrollBreakdownValues, PayrollBreakdownRow as S_PayrollBreakdownRow, PayrollBreakdownPayload as S_PayrollBreakdownPayload } from "../payrollBreakdown.js";
import type { PayrollEarningType as S_PayrollEarningType, FlowWorkEarningRow as S_FlowWorkEarningRow } from "../flowsPayrollWorkEarnings.js";
import type { UsageReportWindow as S_UsageReportWindow, UsagePageRow as S_UsagePageRow, UsageNotFoundPath as S_UsageNotFoundPath, UsageEndpointRow as S_UsageEndpointRow, UsageReport as S_UsageReport, UsageEndpointTrendPoint as S_UsageEndpointTrendPoint, UsageEndpointTrend as S_UsageEndpointTrend } from "../usageReport.js";
import type { MarketDisplaySeriesRow as S_MarketDisplaySeriesRow, MarketTickerValue as S_MarketTickerValue } from "../marketDisplaySeries.js";
import type { WatchlistChanges as S_WatchlistChanges } from "../watchlistStats.js";
import type { WatchlistCompositeHoldingRow as S_WatchlistCompositeHoldingRow } from "../watchlistCompositeHoldings.js";
import type { WatchlistRow as S_WatchlistRow, WatchlistSymbolSearchResult as S_WatchlistSymbolSearchResult } from "../watchlist.js";
import type { ProjectionParams as S_ProjectionParams } from "../projections.js";
import type { WealthCountry as S_WealthCountry } from "../wealthDistributions.js";
import type { WealthBenchmarkCountry as S_WealthBenchmarkCountry, WealthPercentileCell as S_WealthPercentileCell, WealthPercentileYearRow as S_WealthPercentileYearRow } from "../wealthPercentile.js";
import type { MirrorLegDto as S_MirrorLegDto, MirrorPairAlternative as S_MirrorPairAlternative, MirrorPairCandidate as S_MirrorPairCandidate, RejectedMirrorPair as S_RejectedMirrorPair } from "../movementMirrorPairs.js";
import type { MirrorPairRef as S_MirrorPairRef } from "../movementMirrorConvert.js";
import type { SyncSourceDisplayStatus as S_SyncSourceDisplayStatus, SyncSourceStatusRow as S_SyncSourceStatusRow } from "../globalSyncStale.js";
import type { SyncSourceDayKind as S_SyncSourceDayKind } from "../syncSourceSchedule.js";
import type { SyncPublisherLag as S_SyncPublisherLag } from "../publisherSchedule.js";
import type { ImportSyncDocumentKind as S_ImportSyncDocumentKind, CcStatementCoverageCurrency as S_CcStatementCoverageCurrency, ImportSyncDocumentAccount as S_ImportSyncDocumentAccount, ImportSyncDocumentCell as S_ImportSyncDocumentCell } from "../importSyncDocumentCoverage.js";
import type { ExpenseGenericUniqueMerchantRow as S_ExpenseGenericUniqueMerchantRow } from "../expenseGenericUniqueMerchants.js";
import type { IngestRunStatus as S_IngestRunStatus } from "../ingestRuns.js";
import type { JobWaitView as S_JobWaitView, JobView as S_JobView } from "../jobQueueView.js";
import type { JobStatus as S_JobStatus } from "../jobQueuePolicy.js";

type Fits<S extends D, D> = [S, D];

/**
 * Not listed: `GroceryReceiptRow` (the server reads `source` as a plain string; the stored values
 * are the `GroceryReceiptSource` union) and the generic `Paginated`.
 */
export type ServerDtosFitContracts = [
  Fits<S_AccountPositionSnapshot, Dto.AccountPositionSnapshot>,
  Fits<S_EquityBrokerHolding, Dto.EquityBrokerHolding>,
  Fits<S_FxCoverage, Dto.FxCoverage>,
  Fits<S_FxConversionWarningCode, Dto.FxConversionWarningCode>,
  Fits<S_FxConversionWarning, Dto.FxConversionWarning>,
  Fits<S_FxBidAskGapRow, Dto.FxBidAskGapRow>,
  Fits<S_CcCloseSource, Dto.CcCloseSource>,
  Fits<S_UpcomingPaymentKind, Dto.UpcomingPaymentKind>,
  Fits<S_CcCuotaPurchaseKind, Dto.CcCuotaPurchaseKind>,
  Fits<S_CcInstallmentPurchaseComputed, Dto.CcInstallmentPurchaseComputed>,
  Fits<S_CcCuotaProgressCuota, Dto.CcCuotaProgressCuota>,
  Fits<S_CcCuotaProgress, Dto.CcCuotaProgress>,
  Fits<S_CcInstallmentMonthBreakdown, Dto.CcInstallmentMonthBreakdown>,
  Fits<S_CcInstallmentMonthRow, Dto.CcInstallmentMonthRow>,
  Fits<S_CcFacturadoBarSegments, Dto.CcFacturadoBarSegments>,
  Fits<S_CcHistorialChartPoint, Dto.CcHistorialChartPoint>,
  Fits<S_CcCupoEntry, Dto.CcCupoEntry>,
  Fits<S_CreditCardAccountConfigDto, Dto.CreditCardAccountConfigDto>,
  Fits<S_AccountMonthlyPerformanceRow, Dto.AccountMonthlyPerformanceRow>,
  Fits<S_MortgagePaymentCreateSchema, Dto.MortgagePaymentCreateSchema>,
  Fits<S_MortgagePaymentPreviewResponse, Dto.MortgagePaymentPreviewResponse>,
  Fits<S_CheckingLedgerAnchorDto, Dto.CheckingLedgerAnchorDto>,
  Fits<S_CartolaDerivedAnchorDto, Dto.CartolaDerivedAnchorDto>,
  Fits<S_CheckingCartolaMonthsResponse, Dto.CheckingCartolaMonthsResponse>,
  Fits<S_UnclassifiedGroup, Dto.UnclassifiedGroup>,
  Fits<S_GroceryProductRow, Dto.GroceryProductRow>,
  Fits<S_GroceryReceiptItemRow, Dto.GroceryReceiptItemRow>,
  Fits<S_ProductHistoryRow, Dto.ProductHistoryRow>,
  Fits<S_GroceryBaseUnit, Dto.GroceryBaseUnit>,
  Fits<S_GroceryProductAliasConfigRow, Dto.GroceryProductAliasConfigRow>,
  Fits<S_GroceryProductDetail, Dto.GroceryProductDetail>,
  Fits<S_GroceryBrandRow, Dto.GroceryBrandRow>,
  Fits<S_GroceryReceiptSource, Dto.GroceryReceiptSource>,
  Fits<S_GroupMonthlyPerformanceBarAccount, Dto.GroupMonthlyPerformanceBarAccount>,
  Fits<S_DashboardChartShapeLine, Dto.DashboardChartShapeLine>,
  Fits<S_DashboardChartShape, Dto.DashboardChartShape>,
  Fits<S_InversionesPerfPoint, Dto.InversionesPerfPoint>,
  Fits<S_ConsolidatedMonthlyPerfRow, Dto.ConsolidatedMonthlyPerfRow>,
  Fits<S_GroupConsolidatedTablesResponse, Dto.GroupConsolidatedTablesResponse>,
  Fits<S_GroupPeriodReturnsResponse, Dto.GroupPeriodReturnsResponse>,
  Fits<S_GroupConsolidatedMonthlyPageResponse, Dto.GroupConsolidatedMonthlyPageResponse>,
  Fits<S_FlowsApiRow, Dto.FlowsApiRow>,
  Fits<S_FlowsFilterOptions, Dto.FlowsFilterOptions>,
  Fits<S_FlowsPageResponse, Dto.FlowsPageResponse>,
  Fits<S_ChartBucketLineMetaDto, Dto.ChartBucketLineMetaDto>,
  Fits<S_NavNodeChartBucketsDto, Dto.NavNodeChartBucketsDto>,
  Fits<S_NavTreeNodeDto, Dto.NavTreeNodeDto>,
  Fits<S_DashboardLayoutCardRow, Dto.DashboardLayoutCardRow>,
  Fits<S_NavCardMetricsVariantDto, Dto.NavCardMetricsVariantDto>,
  Fits<S_NavCardAmountDto, Dto.NavCardAmountDto>,
  Fits<S_NavCardValueDto, Dto.NavCardValueDto>,
  Fits<S_NavCardMetricsDto, Dto.NavCardMetricsDto>,
  Fits<S_NavLiquidatedRowsDto, Dto.NavLiquidatedRowsDto>,
  Fits<S_NavValueMapHoldingDto, Dto.NavValueMapHoldingDto>,
  Fits<S_NavValueMapNodeDto, Dto.NavValueMapNodeDto>,
  Fits<S_NetWorthAthDto, Dto.NetWorthAthDto>,
  Fits<S_NetWorthAthByPeriod, Dto.NetWorthAthByPeriod>,
  Fits<S_PeriodReturnKey, Dto.PeriodReturnKey>,
  Fits<S_PeriodReturnCell, Dto.PeriodReturnCell>,
  Fits<S_PeriodReturnsPayload, Dto.PeriodReturnsPayload>,
  Fits<S_BenchmarkComparisonCell, Dto.BenchmarkComparisonCell>,
  Fits<S_BenchmarkComparisonPayload, Dto.BenchmarkComparisonPayload>,
  Fits<S_PrepaymentRow, Dto.PrepaymentRow>,
  Fits<S_MortgagePrepaymentComparison, Dto.MortgagePrepaymentComparison>,
  Fits<S_DeptoMortgageSheetRow, Dto.DeptoMortgageSheetRow>,
  Fits<S_DeptoPaymentScenarioTerm, Dto.DeptoPaymentScenarioTerm>,
  Fits<S_DeptoPaymentScenarioCell, Dto.DeptoPaymentScenarioCell>,
  Fits<S_DeptoPaymentScenarioRow, Dto.DeptoPaymentScenarioRow>,
  Fits<S_MortgageCardLine, Dto.MortgageCardLine>,
  Fits<S_MortgageCardMatchStatus, Dto.MortgageCardMatchStatus>,
  Fits<S_MortgagePaymentCardMatch, Dto.MortgagePaymentCardMatch>,
  Fits<S_DepositFlowCategory, Dto.DepositFlowCategory>,
  Fits<S_FlowDepositRow, Dto.FlowDepositRow>,
  Fits<S_FlowDepositChartPoint, Dto.FlowDepositChartPoint>,
  Fits<S_FlowsPlBucketSlug, Dto.FlowsPlBucketSlug>,
  Fits<S_FlowsPlChartPoint, Dto.FlowsPlChartPoint>,
  Fits<S_FlowsPlAccountRow, Dto.FlowsPlAccountRow>,
  Fits<S_FlowsPlBucketBlock, Dto.FlowsPlBucketBlock>,
  Fits<S_FlowsOverviewRow, Dto.FlowsOverviewRow>,
  Fits<S_FlowsOverviewTotals, Dto.FlowsOverviewTotals>,
  Fits<S_FlowsIncomeAggregates, Dto.FlowsIncomeAggregates>,
  Fits<S_RealEstateChartSeriesDto, Dto.RealEstateChartSeriesDto>,
  Fits<S_RealEstateChartScopeDto, Dto.RealEstateChartScopeDto>,
  Fits<S_RealEstateExpenseLinkDto, Dto.RealEstateExpenseLinkDto>,
  Fits<S_RealEstateBillSlot, Dto.RealEstateBillSlot>,
  Fits<S_RealEstateUnlinkedPurchaseDto, Dto.RealEstateUnlinkedPurchaseDto>,
  Fits<S_RealEstatePlaceDto, Dto.RealEstatePlaceDto>,
  Fits<S_RealEstateExpenseAccountBlock, Dto.RealEstateExpenseAccountBlock>,
  Fits<S_RealEstateLinkCandidateDto, Dto.RealEstateLinkCandidateDto>,
  Fits<S_FlowCcExpenseMonthRow, Dto.FlowCcExpenseMonthRow>,
  Fits<S_FlowCcExpenseChartPoint, Dto.FlowCcExpenseChartPoint>,
  Fits<S_FlowCcExpenseLineSource, Dto.FlowCcExpenseLineSource>,
  Fits<S_FlowCcExpenseLineRow, Dto.FlowCcExpenseLineRow>,
  Fits<S_FlowCcExpenseCategoryChartPoint, Dto.FlowCcExpenseCategoryChartPoint>,
  Fits<S_ExpenseLineOrigin, Dto.ExpenseLineOrigin>,
  Fits<S_CcFacturadoFinancingLink, Dto.CcFacturadoFinancingLink>,
  Fits<S_ExpenseLinkLabel, Dto.ExpenseLinkLabel>,
  Fits<S_ManualExpenseInput, Dto.ManualExpenseInput>,
  Fits<S_ExpenseDepositLinkDto, Dto.ExpenseDepositLinkDto>,
  Fits<S_DepositReconciliationStatus, Dto.DepositReconciliationStatus>,
  Fits<S_DepositReconciliationRow, Dto.DepositReconciliationRow>,
  Fits<S_DepositReconciliationStatusTotals, Dto.DepositReconciliationStatusTotals>,
  Fits<S_DepositReconciliationByMonth, Dto.DepositReconciliationByMonth>,
  Fits<S_DepositRedemptionStatus, Dto.DepositRedemptionStatus>,
  Fits<S_DepositRedemptionRow, Dto.DepositRedemptionRow>,
  Fits<S_DepositManualAssertionStatus, Dto.DepositManualAssertionStatus>,
  Fits<S_DepositManualAssertionRow, Dto.DepositManualAssertionRow>,
  Fits<S_ExpenseYearMonthlyAverage, Dto.ExpenseYearMonthlyAverage>,
  Fits<S_FlowsExpensesGastosView, Dto.FlowsExpensesGastosView>,
  Fits<S_BigGroupUsage, Dto.BigGroupUsage>,
  Fits<S_AdditionalCardsPeriodRow, Dto.AdditionalCardsPeriodRow>,
  Fits<S_AdditionalCardsSummary, Dto.AdditionalCardsSummary>,
  Fits<S_FlowCheckingIncomeLine, Dto.FlowCheckingIncomeLine>,
  Fits<S_IncomeAutoFilterReason, Dto.IncomeAutoFilterReason>,
  Fits<S_FlowFilteredCheckingIncomeLine, Dto.FlowFilteredCheckingIncomeLine>,
  Fits<S_FlowManualIncomeLine, Dto.FlowManualIncomeLine>,
  Fits<S_FlowExcludedCheckingIncomeLine, Dto.FlowExcludedCheckingIncomeLine>,
  Fits<S_PayslipCheckName, Dto.PayslipCheckName>,
  Fits<S_PayslipCheck, Dto.PayslipCheck>,
  Fits<S_PayslipChecksRow, Dto.PayslipChecksRow>,
  Fits<S_PayrollBreakdownField, Dto.PayrollBreakdownField>,
  Fits<S_PayrollBreakdownValues, Dto.PayrollBreakdownValues>,
  Fits<S_PayrollBreakdownRow, Dto.PayrollBreakdownRow>,
  Fits<S_PayrollBreakdownPayload, Dto.PayrollBreakdownPayload>,
  Fits<S_PayrollEarningType, Dto.PayrollEarningType>,
  Fits<S_FlowWorkEarningRow, Dto.FlowWorkEarningRow>,
  Fits<S_UsageReportWindow, Dto.UsageReportWindow>,
  Fits<S_UsagePageRow, Dto.UsagePageRow>,
  Fits<S_UsageNotFoundPath, Dto.UsageNotFoundPath>,
  Fits<S_UsageEndpointRow, Dto.UsageEndpointRow>,
  Fits<S_UsageReport, Dto.UsageReport>,
  Fits<S_UsageEndpointTrendPoint, Dto.UsageEndpointTrendPoint>,
  Fits<S_UsageEndpointTrend, Dto.UsageEndpointTrend>,
  Fits<S_MarketDisplaySeriesRow, Dto.MarketDisplaySeriesRow>,
  Fits<S_MarketTickerValue, Dto.MarketTickerValue>,
  Fits<S_WatchlistChanges, Dto.WatchlistChanges>,
  Fits<S_WatchlistCompositeHoldingRow, Dto.WatchlistCompositeHoldingRow>,
  Fits<S_WatchlistRow, Dto.WatchlistRow>,
  Fits<S_WatchlistSymbolSearchResult, Dto.WatchlistSymbolSearchResult>,
  Fits<S_ProjectionParams, Dto.ProjectionParams>,
  Fits<S_WealthCountry, Dto.WealthCountry>,
  Fits<S_WealthBenchmarkCountry, Dto.WealthBenchmarkCountry>,
  Fits<S_WealthPercentileCell, Dto.WealthPercentileCell>,
  Fits<S_WealthPercentileYearRow, Dto.WealthPercentileYearRow>,
  Fits<S_MirrorLegDto, Dto.MirrorLegDto>,
  Fits<S_MirrorPairAlternative, Dto.MirrorPairAlternative>,
  Fits<S_MirrorPairCandidate, Dto.MirrorPairCandidate>,
  Fits<S_RejectedMirrorPair, Dto.RejectedMirrorPair>,
  Fits<S_MirrorPairRef, Dto.MirrorPairRef>,
  Fits<S_SyncSourceDisplayStatus, Dto.SyncSourceDisplayStatus>,
  Fits<S_SyncSourceStatusRow, Dto.SyncSourceStatusRow>,
  Fits<S_SyncSourceDayKind, Dto.SyncSourceDayKind>,
  Fits<S_SyncPublisherLag, Dto.SyncPublisherLag>,
  Fits<S_ImportSyncDocumentKind, Dto.ImportSyncDocumentKind>,
  Fits<S_CcStatementCoverageCurrency, Dto.CcStatementCoverageCurrency>,
  Fits<S_ImportSyncDocumentAccount, Dto.ImportSyncDocumentAccount>,
  Fits<S_ImportSyncDocumentCell, Dto.ImportSyncDocumentCell>,
  Fits<S_ExpenseGenericUniqueMerchantRow, Dto.ExpenseGenericUniqueMerchantRow>,
  Fits<S_IngestRunStatus, Dto.IngestRunStatus>,
  Fits<S_JobWaitView, Dto.JobWaitView>,
  Fits<S_JobView, Dto.JobView>,
  Fits<S_JobStatus, Dto.JobStatus>,
];

describe("server DTO declarations", () => {
  it("fit the shared contracts DTOs (checked by tsc)", () => {
    expect(true).toBe(true);
  });
});
