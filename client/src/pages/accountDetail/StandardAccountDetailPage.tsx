import { useMemo } from "react";
import { Trans, useTranslation } from "../../i18n";
import { MonthlyPerformanceComboChart } from "../../components/charts/MonthlyPerformanceComboChart";
import { AccountFlowsSection } from "../../components/account/AccountFlowsSection";
import { DailyPerfDetailTable } from "../../components/account/DailyPerfDetailTable";
import { MonthlyPerfDetailTable } from "../../components/account/MonthlyPerfDetailTable";
import { buildDailyValuationBlock } from "../../dailySeriesChart";
import { useDisplayPreferences } from "../../context/DisplayPreferencesContext";
import { useDailySeries } from "../../queries/hooks";
import { PeriodReturnsStrip } from "../../components/perf/PeriodReturnsStrip";
import { CheckingCartolaMonthTable } from "./CheckingCartolaMonthTable";
import { CheckingLedgerAnchorForm } from "../../components/account/CheckingLedgerAnchorForm";
import { Table } from "../../components/ui/Table";
import { LineChartPanel } from "../../components/charts/ValuationLineCharts";
import { formatClp, formatGroupedDecimal, formatInstrumentUnits, formatPct } from "../../format";
import { cn } from "../../cn";
import { AccountBrokerageMovementsForm } from "../../components/account/AccountBrokerageMovementsForm";
import { AccountUsdCashMovementsForm } from "../../components/account/AccountUsdCashMovementsForm";
import { AccountClpCashMovementsForm } from "../../components/account/AccountClpCashMovementsForm";
import { AccountUnitsFlowForm } from "../../components/account/AccountUnitsFlowForm";
import { AccountBookLedgerSection } from "../../components/account/AccountBookLedgerSection";
import { MortgagePaymentForm } from "../../components/account/MortgagePaymentForm";
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
    metricsPeriod,
    xAxisGranularity,
    monthlyPerfErr,
    monthlyPerfRows,
    periodReturns,
    ytdChartPoints,
    accChartPoints,
    valuationBlockForChart,
    accountChartTheme,
    checkingCartolaMonths,
    extraCcOffsets,
  } = data;

  const isUsdCashAccount = supportsUsdCashMovements(summary.movement_create);
  const showUsdCashMovementsForm = isUsdCashAccount;
  const showClpCashMovementsForm = supportsClpCashMovements(summary.movement_create);
  const showBrokerageMovementsForm =
    supportsBrokerageMovements(summary.movement_create) && !isUsdCashAccount && !showClpCashMovementsForm;
  const showBookLedgerEdit = supportsBookLedgerEdit(summary.book_ledger_edit);
  const showUnitsFlowForm = supportsUnitsFlowMovements(summary.movement_create);
  const unitsFlowUnitLabel = showUnitsFlowForm
    ? summary.movement_create?.unit_label ?? "unidades"
    : null;
  const extraCcOffsetsKey = JSON.stringify(extraCcOffsets);

  const { dailySessions } = useDisplayPreferences();
  const isDaily = metricsPeriod === "day";
  // Day view: per-session line + detalle por día, fetched lazily while the D toggle is on.
  const dailySeries = useDailySeries(
    { accountId: summary.account_id },
    displayUnit,
    dailySessions,
    isDaily
  );
  const dailyValuationBlock = useMemo(() => {
    if (!isDaily) return null;
    return buildDailyValuationBlock(dailySeries.data, valuationBlockForChart ?? ts.accounts);
  }, [isDaily, dailySeries.data, valuationBlockForChart, ts.accounts]);

  const isMovementCartolaAccount = summary.category_slug === "cuenta_corriente" || summary.category_slug === "cuenta_vista";
  const showMonthlyPerformance =
    !isMovementCartolaAccount && summary.category_slug !== "cuenta_ahorro_vivienda";
  const isAfpAccount = summary.category_slug === "afp";
  const isMortgageAccount = isDeptoMortgageCategory(summary.category_slug);
  const isPropertyAccount = isDeptoPropertyCategory(summary.category_slug);
  const isDeptoAccount = isMortgageAccount || isPropertyAccount;
  const showMortgagePaymentForm =
    isMortgageAccount && summary.mortgage_payment_create != null;
  const showManualEntryForm =
    showBrokerageMovementsForm ||
    showUsdCashMovementsForm ||
    showClpCashMovementsForm ||
    showBookLedgerEdit ||
    showUnitsFlowForm ||
    showMortgagePaymentForm;
  const showPositionBlock =
    !data.contentLoading && !isMovementCartolaAccount && !isDeptoAccount && !isUsdCashAccount;
  const showEquityReturnColumns = summary.position?.dividends_clp != null;
  const ccChartsFromParsedLedger =
    summary.category_slug === "credit_card" && data.ccLedger.has_installment_ledger;

  return (
    <AccountDetailSharedLayout
      toolbar={<ExportToolbarButton exportPath={`/api/accounts/${summary.account_id}/export.xlsx`} />}
      title={ts.name}
      accountColorRgb={data.accountColorRgb}
      pageColorTarget={data.pageColorTarget}
      accountId={summary.account_id}
      accountName={ts.name}
      accountTitleDelta={data.accountTitleDelta}
      accountMetricsAgg={data.accountMetricsAgg}
      displayUnit={displayUnit}
      metricsPeriod={metricsPeriod}
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
      loading={data.contentLoading}
    >
      {(isMovementCartolaAccount || isAfpAccount) && (
        <AccountImportSection accountId={summary.account_id} displayUnit={displayUnit} />
      )}

      {isDeptoAccount && !data.contentLoading ? (
        <DeptoAccountSummaryCards
          variant={isMortgageAccount ? "mortgage" : "property"}
          ledger={mortgageLedger}
          summary={summary}
          monthlyPerfRows={monthlyPerfRows}
          accountDashRow={data.accountDashRow}
        />
      ) : null}

      {showPositionBlock ? (
        <div className={styles.positionBlock}>
          <h2 className={styles.sectionTitleCompact}>{t("accountDetail.position.title")}</h2>
          <p className={cn("muted", styles.proseMutedXs)}>
            <Trans
              i18nKey="accountDetail.positionHint"
              components={{ 1: <span className="mono" /> }}
            />
            {isAfpAccount ? (
              <Trans
                i18nKey="accountDetail.positionHintAfp"
                components={{
                  1: <span className="mono" />,
                  2: <span className="mono" />,
                  3: <span className="mono" />,
                  4: <span className="mono" />,
                  5: <span className="mono" />,
                }}
              />
            ) : null}
          </p>
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
        </div>
      ) : null}

      {isUsdCashAccount && !data.contentLoading ? (
        <div className={styles.positionBlock}>
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
        </div>
      ) : null}

      <div className={cn("chart-grid", "chart-grid--full-line", styles.chartBlock)}>
        <LineChartPanel
          title={t("charts.valuationAndDeposits")}
          block={dailyValuationBlock ?? valuationBlockForChart ?? ts.accounts}
          displayUnit={displayUnit}
          xAxisGranularity={dailyValuationBlock ? "day" : xAxisGranularity}
          trimLeadingInactive={!isMovementCartolaAccount}
        />
      </div>

      {isMovementCartolaAccount ? (
        <>
          <h2 className={styles.sectionTitleSpaced}>{t("accountDetail.monthlyDetailTitle")}</h2>
          <p className={cn("muted", styles.proseSmTight)}>
            {t("accountDetail.checking.cartolaMonthHint")}
          </p>
          <CheckingLedgerAnchorForm
            accountId={summary.account_id}
            displayUnit={displayUnit}
            extraCcOffsetsKey={extraCcOffsetsKey}
            ledgerAnchor={checkingCartolaMonths?.ledger_anchor ?? null}
            cartolaDerivedAnchor={checkingCartolaMonths?.cartola_derived_anchor ?? null}
          />
          <CheckingCartolaMonthTable
            rows={checkingCartolaMonths?.rows ?? []}
            importedMonthCount={checkingCartolaMonths?.imported_months.length ?? 0}
            collapsedVisibleRows={MONTHLY_PERF_COLLAPSED}
          />
        </>
      ) : null}

      {showMonthlyPerformance ? (
        <>
          <h2 className={styles.sectionTitleSpaced}>{t("accountDetail.monthlyPerfComputedTitle")}</h2>
          <p className={cn("muted", styles.proseMutedXs)}>
            <Trans
              i18nKey="accountDetail.monthlyPerfIntro"
              components={{ 1: <strong />, 3: <strong /> }}
            />
            {isMortgageAccount ? (
              <Trans
                i18nKey="accountDetail.monthlyPerfMortgageNote"
                components={{ 1: <strong /> }}
              />
            ) : null}
            {ccChartsFromParsedLedger ? (
              <>{t("accountDetail.monthlyPerfCcLedgerNote")}</>
            ) : (
              <> {t("accountDetail.sameBaseAsValuation")}</>
            )}
            <Trans
              i18nKey="accountDetail.monthlyPerfUnit"
              values={{ unit: displayUnit === "usd" ? "USD" : "CLP" }}
              components={{ 1: <strong /> }}
            />
          </p>
          {periodReturns != null ? (
            <>
              <h3 className={styles.subsectionTitleTight}>{t("periodReturns.title")}</h3>
              <p className={cn("muted", styles.proseMutedXs)}>{t("periodReturns.hint")}</p>
              <PeriodReturnsStrip data={periodReturns} displayUnit={displayUnit} />
            </>
          ) : null}
          {monthlyPerfErr ? (
            <p className={cn("error", styles.errorText)}>{monthlyPerfErr}</p>
          ) : monthlyPerfRows.length === 0 ? (
            <p className="muted">{t("accountDetail.monthlyPerfNotEnough")}</p>
          ) : (
            <>
              <h3 className={styles.subsectionTitleTight}>{t("accountDetail.ytdCalendarTitle")}</h3>
              <div className={cn("chart-grid", "chart-grid--full-line", styles.chartBlockFlush)}>
                <MonthlyPerformanceComboChart
                  title={t("accountDetail.plMonthlyVsYtdTitle")}
                  titleAs="h3"
                  points={ytdChartPoints}
                  displayUnit={displayUnit}
                  xAxisGranularity={xAxisGranularity}
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
                />
              </div>
              <h3 className={styles.subsectionTitleLoose}>{t("dashboard.sections.accumulatedEarnings")}</h3>
              <div className={cn("chart-grid", "chart-grid--full-line", styles.chartBlockFlush)}>
                <MonthlyPerformanceComboChart
                  title={t("accountDetail.monthlyDeltaAndAccumTitle")}
                  titleAs="h3"
                  points={accChartPoints}
                  displayUnit={displayUnit}
                  xAxisGranularity={xAxisGranularity}
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
                />
              </div>
              <h3 className={styles.subsectionTitleMid}>
                {t(
                  isDaily
                    ? "accountDetail.dailyDetailTitle"
                    : metricsPeriod === "year"
                      ? "accountDetail.yearlyDetailTitle"
                      : "accountDetail.monthlyDetailTitle"
                )}
              </h3>
              {isDaily ? (
                dailySeries.data ? (
                  <DailyPerfDetailTable series={dailySeries.data} displayUnit={displayUnit} />
                ) : (
                  <p className="muted">{t("common.loading")}</p>
                )
              ) : (
                <MonthlyPerfDetailTable
                  key={`${id}-${displayUnit}-mp-detail`}
                  rows={monthlyPerfRows}
                  displayUnit={displayUnit}
                  isMortgageAccount={isMortgageAccount}
                  isAfpAccount={isAfpAccount}
                  movementUnitsKind={movementUnitsKind}
                />
              )}
            </>
          )}
        </>
      ) : null}

      {mortgageLedger.has_sheet_rows && mortgageLedger.rows.length > 0 ? (
        <>
          {showMortgagePaymentForm && summary.mortgage_payment_create ? (
            <MortgagePaymentForm
              accountId={summary.account_id}
              displayUnit={displayUnit}
              extraCcOffsetsKey={extraCcOffsetsKey}
              schema={summary.mortgage_payment_create}
            />
          ) : null}
          <MortgageDividendosTable
            ledger={mortgageLedger}
            variant={isMortgageAccount ? "mortgage" : "property"}
          />
          {mortgageLedger.payment_scenarios && mortgageLedger.payment_scenarios.length > 0 ? (
            <DeptoPaymentScenarioTable rows={mortgageLedger.payment_scenarios} />
          ) : null}
        </>
      ) : isDeptoAccount ? (
        !mortgageLedger.has_sheet_rows ? (
          <p className={cn("muted", styles.marginTopBase)}>
            {t("account.creditCard.mortgageSheetEmpty")}
          </p>
        ) : null
      ) : null}

      {depositInflows != null && depositInflows.state_contribution_events.length > 0 ? (
        <>
          <h2 className={styles.sectionTitle}>{t("accountDetail.stateContribution.title")}</h2>
          <p className={cn("muted", styles.proseMutedXs)}>
            <Trans
              i18nKey="accountDetail.stateContribution.intro"
              values={{ total: formatClp(depositInflows.state_contribution_total_clp) }}
              components={{ 1: <span className="mono" /> }}
            />
          </p>
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
        </>
      ) : null}

      {showBookLedgerEdit ? (
        <AccountBookLedgerSection
          accountId={summary.account_id}
          displayUnit={displayUnit}
          extraCcOffsetsKey={extraCcOffsetsKey}
        />
      ) : null}

      <AccountFlowsSection
        hint={
          <p className={cn("muted", styles.proseMutedXs)}>
            Un solo listado por cuenta: aportes, retiros, compras, dividendos, cuotas, etc. Todo en{" "}
            <span className="mono">movements</span> (SPY/VEA usan <span className="mono">flow_kind</span>, ticker y USD).
            {showManualEntryForm ? null : (
              <>
                {" "}
                Altas: <span className="mono">POST /api/accounts/{id}/movements</span>.
              </>
            )}
          </p>
        }
        addMovementsForm={
          showUsdCashMovementsForm ? (
            <AccountUsdCashMovementsForm
              accountId={summary.account_id}
              displayUnit={displayUnit}
              extraCcOffsetsKey={extraCcOffsetsKey}
            />
          ) : showClpCashMovementsForm ? (
            <AccountClpCashMovementsForm
              accountId={summary.account_id}
              displayUnit={displayUnit}
              extraCcOffsetsKey={extraCcOffsetsKey}
            />
          ) : showBrokerageMovementsForm ? (
            <AccountBrokerageMovementsForm
              accountId={summary.account_id}
              ticker={summary.position?.ticker ?? null}
              quoteCurrency={summary.equity_quote_currency ?? null}
              displayUnit={displayUnit}
              extraCcOffsetsKey={extraCcOffsetsKey}
            />
          ) : showUnitsFlowForm && unitsFlowUnitLabel ? (
            <AccountUnitsFlowForm
              accountId={summary.account_id}
              unitLabel={unitsFlowUnitLabel}
              displayUnit={displayUnit}
              extraCcOffsetsKey={extraCcOffsetsKey}
            />
          ) : null
        }
        accountId={summary.account_id}
        movementUnitsKind={movementUnitsKind}
      />
    </AccountDetailSharedLayout>
  );
}
