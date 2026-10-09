import { useMemo } from "react";
import { useTranslation } from "../../i18n";
import { LineChartPanel, MonthlyPerformanceComboChart } from "../../components/charts/lazyCharts";
import { AccountFlowsSection } from "../../components/account/AccountFlowsSection";
import { DailyPerfDetailTable } from "../../components/account/DailyPerfDetailTable";
import { MonthlyPerfDetailTable } from "../../components/account/MonthlyPerfDetailTable";
import { buildDailyValuationBlock } from "../../dailySeriesChart";
import { buildDailyPerfComboPoints } from "../../dailyPerfCombo";
import { useDailySeries } from "../../queries/hooks";
import { timeRangeToDays } from "../../timeRange";
import { useSurfacePrefs } from "../../surfaceDisplayPrefs";
import { SurfaceControls } from "../../components/ui/SurfaceControls";
import { PeriodReturnsWithBenchmark } from "../../components/perf/PeriodReturnsTable";
import { CheckingCartolaMonthTable } from "./CheckingCartolaMonthTable";
import { CheckingLedgerAnchorForm } from "../../components/account/CheckingLedgerAnchorForm";
import { Table } from "../../components/ui/Table";
import { Loadable } from "../../components/ui/Loadable";
import { formatClp, formatGroupedDecimal, formatInstrumentUnits, formatPct } from "../../format";
import { cn } from "../../cn";
import { AccountBrokerageMovementsForm } from "../../components/account/AccountBrokerageMovementsForm";
import { AccountUsdCashMovementsForm } from "../../components/account/AccountUsdCashMovementsForm";
import { AccountClpCashMovementsForm } from "../../components/account/AccountClpCashMovementsForm";
import { AccountUnitsFlowForm } from "../../components/account/AccountUnitsFlowForm";
import { AccountBookLedgerSection } from "../../components/account/AccountBookLedgerSection";
import { MortgagePaymentForm } from "../../components/account/MortgagePaymentForm";
import { MortgagePrepaymentSection } from "../../components/account/MortgagePrepaymentSection";
import { AccountImportSection } from "../../components/account/AccountImportSection";
import {
  supportsBrokerageMovements,
  supportsUsdCashMovements,
  supportsClpCashMovements,
  supportsUnitsFlowMovements,
} from "../../accountMovementCreate";
import { supportsBookLedgerEdit } from "../../accountBookLedgerEdit";
import { AccountDetailSharedLayout } from "./AccountDetailSharedLayout";
import { ExportToolbarButton } from "../../components/export/ExportModal";
import { DeptoAccountSummaryCards } from "./DeptoAccountSummaryCards";
import { DeptoPaymentScenarioTable, MortgageDividendosTable } from "./MortgageTables";
import type { AccountDetailPageData } from "./useAccountDetailPageData";
import {
  MONTHLY_PERF_COLLAPSED,
  isDeptoMortgageCategory,
  isDeptoPropertyCategory,
  mayHavePeriodReturns,
  movementUnitsKind,
  tickerLabelFromCategory,
} from "./shared";
import styles from "../AccountDetailPage.module.css";

type Props = {
  data: AccountDetailPageData;
};

export function StandardAccountDetailPage({ data }: Props) {
  const { t } = useTranslation();
  const {
    id,
    summary,
    ts,
    depositInflows,
    mortgageLedger,
    displayUnit,
    valuationPrefs,
    perfPrefs,
    monthlyPerfRows,
    periodReturns,
    ytdChartPoints,
    accChartPoints,
    valuationBlockForChart,
    accountChartTheme,
    checkingCartolaMonths,
  } = data;

  // The page data is not in (or is held prior-unit data): sections render their frame, dimmed.
  const loading = data.contentLoading;
  // Capability forms (movement_create / book_ledger_edit / mortgage_payment_create) stay hidden
  // until the bundle states them: a wrong form is worse than a late one.
  const usdCashCapability = supportsUsdCashMovements(summary.movement_create);
  // The USD-cash frame needs no capability: the placeholder's category (`usd`) is enough to draw it.
  const isUsdCashAccount = usdCashCapability || (loading && summary.category_slug === "usd");
  const showUsdCashMovementsForm = usdCashCapability;
  const showClpCashMovementsForm = supportsClpCashMovements(summary.movement_create);
  const showBrokerageMovementsForm =
    supportsBrokerageMovements(summary.movement_create) && !isUsdCashAccount && !showClpCashMovementsForm;
  const showBookLedgerEdit = supportsBookLedgerEdit(summary.book_ledger_edit);
  const showUnitsFlowForm = supportsUnitsFlowMovements(summary.movement_create);
  const unitsFlowUnitLabel = showUnitsFlowForm
    ? summary.movement_create?.unit_label ?? "unidades"
    : null;

  const valuationIsDaily = valuationPrefs.period === "day";
  const perfIsDaily = perfPrefs.period === "day";
  // Detalle table período (independent of the charts); tables always cover full history.
  const detallePrefs = useSurfacePrefs(
    `account.${summary.account_id || "pending"}.detalle`,
    "month",
    "total"
  );
  const isDaily = detallePrefs.period === "day";
  const detalleDailySeries = useDailySeries(
    { accountId: summary.account_id },
    displayUnit,
    0,
    isDaily && summary.account_id > 0
  );
  // Day view: per-session line + detalle por día, fetched lazily while a D control is on.
  const dailySeries = useDailySeries(
    { accountId: summary.account_id },
    displayUnit,
    timeRangeToDays(valuationPrefs.range),
    valuationIsDaily
  );
  const perfDailySeries = useDailySeries(
    { accountId: summary.account_id },
    displayUnit,
    timeRangeToDays(perfPrefs.range),
    perfIsDaily
  );
  const dailyValuationBlock = useMemo(() => {
    if (!valuationIsDaily) return null;
    return buildDailyValuationBlock(dailySeries.data, valuationBlockForChart ?? ts.accounts);
  }, [valuationIsDaily, dailySeries.data, valuationBlockForChart, ts.accounts]);
  // A Diario surface also waits on its own daily series (first fetch or a held prior one).
  const valuationLoading =
    loading || (valuationIsDaily && (dailySeries.isPending || dailySeries.isPlaceholderData));
  const perfLoading =
    loading || (perfIsDaily && (perfDailySeries.isPending || perfDailySeries.isPlaceholderData));
  const detalleDailyLoading = detalleDailySeries.isPending || detalleDailySeries.isPlaceholderData;
  const valuationControls = (
    <SurfaceControls
      period={valuationPrefs.period}
      onPeriodChange={valuationPrefs.setPeriod}
      range={valuationPrefs.range}
      onRangeChange={valuationPrefs.setRange}
    />
  );
  const perfControls = (
    <SurfaceControls
      period={perfPrefs.period}
      onPeriodChange={perfPrefs.setPeriod}
      range={perfPrefs.range}
      onRangeChange={perfPrefs.setRange}
    />
  );

  // Day view P/L bars: one bar account (this account), so a single build serves both combos —
  // `nominal_pl`/`delta_month` are the same daily P/L and the two areas ride along.
  const dailyPerfPoints = useMemo(() => {
    if (!perfIsDaily || !perfDailySeries.data?.points.length || !monthlyPerfRows.length) return null;
    const line = perfDailySeries.data.accounts?.find((l) => l.account_id === summary.account_id);
    if (!line?.pl) return null;
    return buildDailyPerfComboPoints({
      series: perfDailySeries.data,
      lines: [line],
      barAccounts: [{ account_id: summary.account_id, bar_data_key: "nominal_pl" }],
      monthlyPointsAsc: [...monthlyPerfRows].reverse().map((r) => ({
        as_of_date: r.as_of_date,
        ytd_nominal_pl: r.ytd_nominal_pl ?? 0,
        accumulated_earnings: r.cumulative_nominal_pl ?? 0,
      })),
      ytdKey: "ytd_nominal_pl",
      totalKey: "delta_month",
    });
  }, [perfIsDaily, perfDailySeries.data, monthlyPerfRows, summary.account_id]);

  const isMovementCartolaAccount = summary.category_slug === "cuenta_corriente" || summary.category_slug === "cuenta_vista";
  const showMonthlyPerformance =
    !isMovementCartolaAccount && summary.category_slug !== "cuenta_ahorro_vivienda";
  const isAfpAccount = summary.category_slug === "afp";
  const isAfcAccount = summary.category_slug === "afc";
  // Cuota-ledger accounts (AFP, AFC): the perf table reads contributions in cuotas.
  const isCuotaLedgerAccount = isAfpAccount || isAfcAccount;
  const isMortgageAccount = isDeptoMortgageCategory(summary.category_slug);
  const isPropertyAccount = isDeptoPropertyCategory(summary.category_slug);
  const isDeptoAccount = isMortgageAccount || isPropertyAccount;
  const showMortgagePaymentForm =
    isMortgageAccount && summary.mortgage_payment_create != null;
  const showPositionBlock = !isMovementCartolaAccount && !isDeptoAccount && !isUsdCashAccount;
  const showPeriodReturns =
    periodReturns === undefined
      ? mayHavePeriodReturns(data.accountDashRow)
      : periodReturns !== null;
  const showEquityReturnColumns = summary.position?.dividends_clp != null;
  // Shown only when the ticker is held through more than one cash account (broker).
  const brokerHoldings = summary.position?.brokers ?? [];

  return (
    <AccountDetailSharedLayout
      toolbar={<ExportToolbarButton exportPath={`/api/accounts/${summary.account_id}/export.xlsx`} />}
      title={ts.name}
      accountId={summary.account_id}
      accountMetricsAgg={data.accountMetricsAgg}
      displayUnit={displayUnit}
      heroClp={
        displayUnit === "usd"
          ? 0
          : data.accountDashRow?.current_value_clp ??
          summary.latest_valuation_clp ??
          0
      }
      heroApiUsd={
        displayUnit === "usd" ? data.accountDashRow?.current_value_usd ?? data.chartUsdVal : null
      }
      dash={data.dash}
      accountNavChildren={data.accountNavChildren}
      loading={loading || data.dashIsPlaceholder}
    >
      {/* Self-gates on the server's import specs (a capability): hidden until they arrive. */}
      <AccountImportSection accountId={summary.account_id} displayUnit={displayUnit} />

      {isDeptoAccount ? (
        <DeptoAccountSummaryCards
          variant={isMortgageAccount ? "mortgage" : "property"}
          ledger={mortgageLedger}
          summary={summary}
          monthlyPerfRows={monthlyPerfRows}
          accountDashRow={data.accountDashRow}
          loading={loading}
        />
      ) : null}

      {showPositionBlock ? (
        <Loadable loading={loading} className={styles.positionBlock}>
          <h2 className={styles.sectionTitleCompact}>{t("accountDetail.position.title")}</h2>
          <Table
            header={
              <thead>
                <tr>
                  <th>{t("accountDetail.position.colTicker")}</th>
                  <th>{t("accountDetail.position.colUnits")}</th>
                  <th>
                    {showEquityReturnColumns
                      ? t("accountDetail.equityPosition.depositedPocket")
                      : t("accountDetail.position.colDeposited")}
                  </th>
                  {showEquityReturnColumns ? (
                    <th>{t("accountDetail.equityPosition.dividends")}</th>
                  ) : null}
                  <th>{t("accountDetail.position.colValueToday")}</th>
                  <th>{t("accountDetail.position.colValueDate")}</th>
                  <th>{t("accountDetail.position.colValuePerUnit")}</th>
                  {showEquityReturnColumns ? (
                    <>
                      <th>{t("accountDetail.equityPosition.totalReturn")}</th>
                      <th>{t("accountDetail.equityPosition.returnOnDeposited")}</th>
                    </>
                  ) : null}
                </tr>
              </thead>
            }
          >
            <tr>
              <td className="mono">
                {summary.position?.ticker ?? tickerLabelFromCategory(summary.category_slug)}
              </td>
              <td className="mono">
                {summary.position?.units != null && Number.isFinite(summary.position.units)
                  ? formatInstrumentUnits(
                    summary.position.units,
                    summary.position.units_kind ?? movementUnitsKind(summary.category_slug)
                  )
                  : "—"}
              </td>
              <td className="mono">{formatClp(summary.position?.deposited_clp ?? summary.deposits_clp)}</td>
              {showEquityReturnColumns ? (
                <td className="mono">{formatClp(summary.position?.dividends_clp ?? 0)}</td>
              ) : null}
              <td className="mono">
                {(() => {
                  const v = summary.position?.value_clp ?? summary.latest_valuation_clp;
                  return v != null ? formatClp(v) : "—";
                })()}
              </td>
              <td className="muted">
                {summary.position?.value_as_of ?? summary.latest_valuation_date ?? "—"}
              </td>
              <td className="mono">
                {summary.position?.value_per_unit_clp != null
                  ? formatClp(summary.position.value_per_unit_clp)
                  : "—"}
              </td>
              {showEquityReturnColumns ? (
                <>
                  <td className="mono">
                    {summary.position?.total_return_clp != null
                      ? formatClp(summary.position.total_return_clp)
                      : "—"}
                  </td>
                  <td className="mono">
                    {summary.position?.return_on_deposited_pct != null
                      ? formatPct(summary.position.return_on_deposited_pct * 100)
                      : "—"}
                  </td>
                </>
              ) : null}
            </tr>
          </Table>
          {brokerHoldings.length >= 2 ? (
            <>
              <h3 className={cn(styles.sectionTitleCompact, styles.marginTopBase)}>
                {t("accountDetail.brokerHoldings.title")}
              </h3>
              <p className="muted">{t("accountDetail.brokerHoldings.hint")}</p>
              <Table
                header={
                  <thead>
                    <tr>
                      <th>{t("accountDetail.brokerHoldings.colAccount")}</th>
                      <th>{t("accountDetail.brokerHoldings.colUnits")}</th>
                      <th>{t("accountDetail.brokerHoldings.colShare")}</th>
                      <th>{t("accountDetail.brokerHoldings.colValue")}</th>
                    </tr>
                  </thead>
                }
              >
                {brokerHoldings.map((h) => (
                  <tr key={h.cash_account_id ?? "none"}>
                    <td>{h.cash_account_name ?? t("accountDetail.brokerHoldings.noCashAccount")}</td>
                    <td className="mono">
                      {formatInstrumentUnits(h.units, summary.position?.units_kind ?? "shares")}
                    </td>
                    <td className="mono">{formatPct(h.share * 100)}</td>
                    <td className="mono">{h.value_clp != null ? formatClp(h.value_clp) : "—"}</td>
                  </tr>
                ))}
              </Table>
            </>
          ) : null}
        </Loadable>
      ) : null}

      {isUsdCashAccount ? (
        <Loadable loading={loading} className={styles.positionBlock}>
          <h2 className={styles.sectionTitleCompact}>{t("accountDetail.usdCash.positionTitle")}</h2>
          <Table
            header={
              <thead>
                <tr>
                  <th>{t("accountDetail.usdCash.balanceUsd")}</th>
                  <th>{t("accountDetail.usdCash.balanceClp")}</th>
                  <th>{t("accountDetail.usdCash.asOf")}</th>
                </tr>
              </thead>
            }
          >
            <tr>
              <td className="mono">
                {data.accountDashRow?.current_value_usd != null
                  ? formatGroupedDecimal(data.accountDashRow.current_value_usd, 2)
                  : "—"}
              </td>
              <td className="mono">
                {formatClp(
                  data.accountDashRow?.current_value_clp ?? summary.latest_valuation_clp ?? 0
                )}
              </td>
              <td className="muted">
                {summary.latest_valuation_date ?? "—"}
              </td>
            </tr>
          </Table>
        </Loadable>
      ) : null}

      <div className={cn("chart-grid", "chart-grid--full-line", styles.chartBlock)}>
        <LineChartPanel
          title={t("charts.valuationAndDeposits")}
          block={dailyValuationBlock ?? valuationBlockForChart ?? ts.accounts}
          displayUnit={displayUnit}
          xAxisGranularity={
            dailyValuationBlock ? "day" : valuationPrefs.period === "year" ? "year" : "month"
          }
          timeRange={valuationPrefs.range}
          controls={valuationControls}
          trimLeadingInactive={!isMovementCartolaAccount}
          loading={valuationLoading}
        />
      </div>

      {isMovementCartolaAccount ? (
        <>
          <h2 className={styles.sectionTitleSpaced}>{t("accountDetail.monthlyDetailTitle")}</h2>
          {/* An edit form whose copy reads «no cartola» on empty anchors: hidden until they are known. */}
          {loading && checkingCartolaMonths == null ? null : (
            <CheckingLedgerAnchorForm
              accountId={summary.account_id}
              displayUnit={displayUnit}
              ledgerAnchor={checkingCartolaMonths?.ledger_anchor ?? null}
              cartolaDerivedAnchor={checkingCartolaMonths?.cartola_derived_anchor ?? null}
            />
          )}
          <CheckingCartolaMonthTable
            rows={checkingCartolaMonths?.rows ?? []}
            accountId={summary.account_id}
            importedMonthCount={checkingCartolaMonths?.imported_months.length ?? 0}
            collapsedVisibleRows={MONTHLY_PERF_COLLAPSED}
            loading={loading}
          />
        </>
      ) : null}

      {showMonthlyPerformance ? (
        <>
          <h2 className={styles.sectionTitleSpaced}>{t("accountDetail.monthlyPerfComputedTitle")}</h2>
          {/* undefined = still loading (the table frames itself unless the card row's bucket rules it out); null = the server states none. */}
          {showPeriodReturns ? (
            <>
              <h3 className={styles.subsectionTitleTight}>{t("periodReturns.title")}</h3>
              <PeriodReturnsWithBenchmark
                data={periodReturns ?? null}
                displayUnit={displayUnit}
                scope={{ accountId: summary.account_id }}
                surfaceId={`account.${summary.account_id}.returns`}
                loading={loading}
              />
            </>
          ) : null}
          {monthlyPerfRows.length === 0 && !loading ? (
            <p className="muted">{t("accountDetail.monthlyPerfNotEnough")}</p>
          ) : (
            <>
              <div className={cn("chart-grid", "chart-grid--full-line", styles.chartBlock)}>
                <MonthlyPerformanceComboChart
                  title={t("accountDetail.plMonthlyVsYtdTitle")}
                  titleAs="h3"
                  points={dailyPerfPoints ?? ytdChartPoints}
                  displayUnit={displayUnit}
                  xAxisGranularity={
                    dailyPerfPoints ? "day" : perfPrefs.period === "year" ? "year" : "month"
                  }
                  timeRange={perfPrefs.range}
                  controls={perfControls}
                  barSeries={[
                    {
                      dataKey: "nominal_pl",
                      name: isMortgageAccount
                        ? t("accountDetail.financingCostMonth")
                        : t("accountDetail.deltaMonthNominal"),
                      color: accountChartTheme.bar,
                    },
                  ]}
                  areaKey="ytd_nominal_pl"
                  areaName="YTD"
                  areaFill={accountChartTheme.areaFill}
                  areaStroke={accountChartTheme.areaStroke}
                  loading={perfLoading}
                />
              </div>
              <div className={cn("chart-grid", "chart-grid--full-line", styles.chartBlockLoose)}>
                <MonthlyPerformanceComboChart
                  title={t("accountDetail.monthlyDeltaAndAccumTitle")}
                  titleAs="h3"
                  points={dailyPerfPoints ?? accChartPoints}
                  displayUnit={displayUnit}
                  xAxisGranularity={
                    dailyPerfPoints ? "day" : perfPrefs.period === "year" ? "year" : "month"
                  }
                  timeRange={perfPrefs.range}
                  controls={perfControls}
                  barSeries={[
                    {
                      dataKey: "delta_month",
                      name: isMortgageAccount
                        ? t("accountDetail.financingCostMonth")
                        : t("accountDetail.monthlyDelta"),
                      color: accountChartTheme.bar,
                    },
                  ]}
                  areaKey="accumulated_earnings"
                  areaName={t("dashboard.sections.accumulatedEarnings")}
                  areaFill={accountChartTheme.areaFill}
                  areaStroke={accountChartTheme.areaStroke}
                  alternateYearAreaStripes={false}
                  loading={perfLoading}
                />
              </div>
              <div className="chart-panel-title-row">
                <h3 className={styles.subsectionTitleMid} style={{ marginBottom: 0 }}>
                  {t(
                    isDaily
                      ? "accountDetail.dailyDetailTitle"
                      : detallePrefs.period === "year"
                        ? "accountDetail.yearlyDetailTitle"
                        : "accountDetail.monthlyDetailTitle"
                  )}
                </h3>
                <SurfaceControls
                  period={detallePrefs.period}
                  onPeriodChange={detallePrefs.setPeriod}
                />
              </div>
              {isDaily ? (
                <DailyPerfDetailTable
                  series={detalleDailySeries.data}
                  displayUnit={displayUnit}
                  dimClosedDays
                  loading={detalleDailyLoading}
                />
              ) : (
                <MonthlyPerfDetailTable
                  key={`${id}-${displayUnit}-mp-detail`}
                  rows={monthlyPerfRows}
                  displayUnit={displayUnit}
                  period={detallePrefs.period === "year" ? "year" : "month"}
                  isMortgageAccount={isMortgageAccount}
                  isAfpAccount={isCuotaLedgerAccount}
                  movementUnitsKind={movementUnitsKind}
                  loading={loading}
                />
              )}
            </>
          )}
        </>
      ) : null}

      {/* While the ledger loads a depto account shows its tables' frame (no «sheet empty» copy). */}
      {(mortgageLedger.has_sheet_rows && mortgageLedger.rows.length > 0) ||
      (loading && isDeptoAccount) ? (
        <Loadable loading={loading}>
          {showMortgagePaymentForm && summary.mortgage_payment_create ? (
            <MortgagePaymentForm
              accountId={summary.account_id}
              displayUnit={displayUnit}
              schema={summary.mortgage_payment_create}
            />
          ) : null}
          <MortgageDividendosTable
            ledger={mortgageLedger}
            variant={isMortgageAccount ? "mortgage" : "property"}
            loading={loading}
          />
          {(mortgageLedger.payment_scenarios && mortgageLedger.payment_scenarios.length > 0) ||
          loading ? (
            <DeptoPaymentScenarioTable rows={mortgageLedger.payment_scenarios ?? []} loading={loading} />
          ) : null}
          {isMortgageAccount ? (
            <MortgagePrepaymentSection accountId={summary.account_id} displayUnit={displayUnit} />
          ) : null}
        </Loadable>
      ) : isDeptoAccount ? (
        !mortgageLedger.has_sheet_rows ? (
          <p className={cn("muted", styles.marginTopBase)}>
            {t("account.creditCard.mortgageSheetEmpty")}
          </p>
        ) : null
      ) : null}

      {/* The state bonus only exists on APV accounts: while loading they show the table's frame. */}
      {depositInflows.state_contribution_events.length > 0 ||
      (loading && summary.category_slug === "apv") ? (
        <Loadable loading={loading}>
          <h2 className={styles.sectionTitle}>{t("accountDetail.stateContribution.title")}</h2>
          <Table
            header={
              <thead>
                <tr>
                  <th>{t("accountDetail.stateContribution.colDate")}</th>
                  <th>{t("accountDetail.stateContribution.colAmount")}</th>
                  <th>{t("accountDetail.stateContribution.colAccumulated")}</th>
                </tr>
              </thead>
            }
          >
            {depositInflows.state_contribution_events.map((e, idx) => (
              <tr key={`state-${e.occurred_on}-${idx}`}>
                <td>{e.occurred_on}</td>
                <td className="mono">{formatClp(e.amt_clp)}</td>
                <td className="mono muted">{formatClp(e.cumulative_clp)}</td>
              </tr>
            ))}
          </Table>
        </Loadable>
      ) : null}

      {showBookLedgerEdit ? (
        <AccountBookLedgerSection
          accountId={summary.account_id}
          displayUnit={displayUnit}
        />
      ) : null}

      <AccountFlowsSection
        addMovementsForm={
          showUsdCashMovementsForm ? (
            <AccountUsdCashMovementsForm
              accountId={summary.account_id}
              displayUnit={displayUnit}
            />
          ) : showClpCashMovementsForm ? (
            <AccountClpCashMovementsForm
              accountId={summary.account_id}
              displayUnit={displayUnit}
            />
          ) : showBrokerageMovementsForm ? (
            <AccountBrokerageMovementsForm
              accountId={summary.account_id}
              ticker={summary.position?.ticker ?? null}
              quoteCurrency={summary.equity_quote_currency ?? null}
              displayUnit={displayUnit}
            />
          ) : showUnitsFlowForm && unitsFlowUnitLabel ? (
            <AccountUnitsFlowForm
              accountId={summary.account_id}
              unitLabel={unitsFlowUnitLabel}
              displayUnit={displayUnit}
            />
          ) : null
        }
        accountId={summary.account_id}
        movementUnitsKind={movementUnitsKind}
      />
    </AccountDetailSharedLayout>
  );
}
