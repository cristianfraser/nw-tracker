import { Trans, useTranslation } from "../../i18n";
import { MonthlyPerformanceComboChart } from "../../components/charts/MonthlyPerformanceComboChart";
import { AccountFlowsTable } from "../../components/account/AccountFlowsTable";
import { MonthlyPerfDetailTable } from "../../components/account/MonthlyPerfDetailTable";
import { CheckingCartolaMonthTable } from "./CheckingCartolaMonthTable";
import { CheckingLedgerAnchorForm } from "../../components/account/CheckingLedgerAnchorForm";
import { Table } from "../../components/ui/Table";
import { LineChartPanel } from "../../components/charts/ValuationLineCharts";
import { formatClp, formatInstrumentUnits } from "../../format";
import { cn } from "../../cn";
import { AccountBrokerageMovementsForm } from "../../components/account/AccountBrokerageMovementsForm";
import { AccountImportSection } from "../../components/account/AccountImportSection";
import { supportsBrokerageMovements } from "../../accountMovementCreate";
import { AccountDetailSharedLayout } from "./AccountDetailSharedLayout";
import { DeptoPaymentScenarioTable, MortgageDividendosTable } from "./MortgageTables";
import { MortgageDividendosTableV2 } from "./MortgageDividendosTableV2";
import type { AccountDetailPageData } from "./useAccountDetailPageData";
import {
  ACCOUNT_FLOWS_COLLAPSED,
  MONTHLY_PERF_COLLAPSED,
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
    ytdChartPoints,
    accChartPoints,
    valuationBlockForChart,
    accountChartTheme,
    movementsOnlyPersonalDeposits,
    setMovementsOnlyPersonalDeposits,
    displayedFlows,
    allFlows,
    checkingCartolaMonths,
    extraCcOffsets,
  } = data;

  const showBrokerageMovementsForm = supportsBrokerageMovements(summary.movement_create);
  const extraCcOffsetsKey = JSON.stringify(extraCcOffsets);

  const isMovementCartolaAccount = summary.category_slug === "cuenta_corriente" || summary.category_slug === "cuenta_vista";
  const showMonthlyPerformance =
    !isMovementCartolaAccount && summary.category_slug !== "cuenta_ahorro_vivienda";
  const isAfpAccount = summary.category_slug === "afp";
  const isMortgageAccount = summary.category_slug === "mortgage";
  const ccChartsFromParsedLedger =
    summary.category_slug === "credit_card" && data.ccLedger.has_installment_ledger;

  return (
    <AccountDetailSharedLayout
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
          : data.accountDashRow?.current_value_clp ?? summary.latest_valuation_clp ?? 0
      }
      heroApiUsd={
        displayUnit === "usd" ? data.accountDashRow?.current_value_usd ?? data.chartUsdVal : null
      }
      dash={data.dash}
      overviewPoints={data.overviewPoints}
      accountNavChildren={data.accountNavChildren}
      loading={data.contentLoading}
    >
      {(isMovementCartolaAccount || isAfpAccount) && (
        <AccountImportSection accountId={summary.account_id} displayUnit={displayUnit} />
      )}

      <div className={styles.positionBlock}>
        <h2 className={styles.sectionTitleCompact}>Posición (ticker y cuotas)</h2>
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
                <th>Ticker</th>
                <th>Cuotas / unidades</th>
                <th>Depositado (CLP)</th>
                <th>Valor hoy (CLP)</th>
                <th>Fecha valor</th>
                <th>Valor / unidad (CLP)</th>
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
          </tr>
        </Table>
      </div>

      <div className={cn("chart-grid", "chart-grid--full-line", styles.chartBlock)}>
        <LineChartPanel
          title="Valorización y aportes"
          block={valuationBlockForChart ?? ts.accounts}
          displayUnit={displayUnit}
          xAxisGranularity={xAxisGranularity}
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
          <h2 className={styles.sectionTitleSpaced}>Rendimiento mensual (calculado)</h2>
          <p className={cn("muted", styles.proseMutedXs)}>
            Dos gráficos: (1) P/L mensual vs <strong>YTD</strong> (área reinicia cada enero). (2) mismo Δ mensual con
            área <strong>Accumulated earnings</strong> (continua desde el primer mes, sin franjas por año). La tabla
            conserva el detalle.
            {isMortgageAccount ? (
              <>
                {" "}
                En hipoteca, <strong>P/L mes</strong> = aportes netos − baja de saldo en CLP (coste UF + intereses vs
                amortización visible), no la fórmula de inversión.
              </>
            ) : null}
            {ccChartsFromParsedLedger ? (
              <>
                {" "}
                Las valorizaciones mensuales de esta cuenta se escriben en la base al importar el CSV del PDF; las
                pestañas de clase (p. ej. Liabilities) leen la misma tabla.
              </>
            ) : (
              <> Misma base que valorización y aportes.</>
            )}{" "}
            Unidad: <strong>{displayUnit === "usd" ? "USD" : "CLP"}</strong>
          </p>
          {monthlyPerfErr ? (
            <p className={cn("error", styles.errorText)}>{monthlyPerfErr}</p>
          ) : monthlyPerfRows.length === 0 ? (
            <p className="muted">
              Sin suficientes meses de valorización mensual para calcular variaciones (o la cuenta solo tiene un
              punto).
            </p>
          ) : (
            <>
              <h3 className={styles.subsectionTitleTight}>YTD (año calendario)</h3>
              <div className={cn("chart-grid", "chart-grid--full-line", styles.chartBlockFlush)}>
                <MonthlyPerformanceComboChart
                  title="P/L mensual vs YTD"
                  titleAs="h3"
                  points={ytdChartPoints}
                  displayUnit={displayUnit}
                  xAxisGranularity={xAxisGranularity}
                  barSeries={[
                    {
                      dataKey: "nominal_pl",
                      name: isMortgageAccount ? "Coste financiero mes" : "Δ mes (P/L nominal)",
                      color: accountChartTheme.bar,
                    },
                  ]}
                  areaKey="ytd_nominal_pl"
                  areaName="YTD"
                  areaFill={accountChartTheme.areaFill}
                  areaStroke={accountChartTheme.areaStroke}
                />
              </div>
              <h3 className={styles.subsectionTitleLoose}>Accumulated earnings</h3>
              <div className={cn("chart-grid", "chart-grid--full-line", styles.chartBlockFlush)}>
                <MonthlyPerformanceComboChart
                  title="Monthly Δ y accumulated earnings"
                  titleAs="h3"
                  points={accChartPoints}
                  displayUnit={displayUnit}
                  xAxisGranularity={xAxisGranularity}
                  barSeries={[
                    {
                      dataKey: "delta_month",
                      name: isMortgageAccount ? "Coste financiero mes" : "Monthly Δ",
                      color: accountChartTheme.bar,
                    },
                  ]}
                  areaKey="accumulated_earnings"
                  areaName="Accumulated earnings"
                  areaFill={accountChartTheme.areaFill}
                  areaStroke={accountChartTheme.areaStroke}
                  alternateYearAreaStripes={false}
                />
              </div>
              <h3 className={styles.subsectionTitleMid}>{t("accountDetail.monthlyDetailTitle")}</h3>
              <MonthlyPerfDetailTable
                key={`${id}-${displayUnit}-mp-detail`}
                rows={monthlyPerfRows}
                displayUnit={displayUnit}
                collapsedVisibleRows={MONTHLY_PERF_COLLAPSED}
                isMortgageAccount={isMortgageAccount}
                isAfpAccount={isAfpAccount}
                movementUnitsKind={movementUnitsKind}
              />
            </>
          )}
        </>
      ) : null}

      {mortgageLedger.has_sheet_rows && mortgageLedger.rows.length > 0 ? (
        <>
          <MortgageDividendosTable
            ledger={mortgageLedger}
            variant={isMortgageAccount ? "mortgage" : "property"}
          />
          <MortgageDividendosTableV2
            ledger={mortgageLedger}
            variant={isMortgageAccount ? "mortgage" : "property"}
          />
          {mortgageLedger.payment_scenarios && mortgageLedger.payment_scenarios.length > 0 ? (
            <DeptoPaymentScenarioTable rows={mortgageLedger.payment_scenarios} />
          ) : null}
        </>
      ) : isMortgageAccount || summary.category_slug === "property" ? (
        !mortgageLedger.has_sheet_rows ? (
          <p className={cn("muted", styles.marginTopBase)}>
            {t("account.creditCard.mortgageSheetEmpty")}
          </p>
        ) : null
      ) : null}

      {depositInflows != null && depositInflows.state_contribution_events.length > 0 ? (
        <>
          <h2 className={styles.sectionTitle}>Aporte estatal APV-A</h2>
          <p className={cn("muted", styles.proseMutedXs)}>
            Bonificación del Estado (~15% de tus depósitos del año anterior, con tope). Total acumulado:{" "}
            <span className="mono">{formatClp(depositInflows.state_contribution_total_clp)}</span>
          </p>
          <Table
            header={
              <thead>
                <tr>
                  <th>Fecha</th>
                  <th>Monto CLP</th>
                  <th>Acumulado CLP</th>
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

      {showBrokerageMovementsForm ? (
        <AccountBrokerageMovementsForm
          accountId={summary.account_id}
          ticker={summary.position?.ticker ?? null}
          displayUnit={displayUnit}
          extraCcOffsetsKey={extraCcOffsetsKey}
        />
      ) : null}

      <h2>{t("accountDetail.flowsTitle")}</h2>
      <p className={cn("muted", styles.proseMutedXs)}>
        Un solo listado por cuenta: aportes, retiros, compras, dividendos, cuotas, etc. Todo en{" "}
        <span className="mono">movements</span> (SPY/VEA usan <span className="mono">flow_kind</span>, ticker y USD).
        {showBrokerageMovementsForm ? null : (
          <>
            {" "}
            Altas: <span className="mono">POST /api/accounts/{id}/movements</span>.
          </>
        )}
      </p>
      <label className={styles.flowsFilterToggle}>
        <input
          type="checkbox"
          checked={movementsOnlyPersonalDeposits}
          onChange={(e) => setMovementsOnlyPersonalDeposits(e.target.checked)}
        />
        {t("accountDetail.flowsPersonalOnly")}
      </label>
      <AccountFlowsTable
        rows={displayedFlows.map((row) => ({
          ...row,
          category_slug: summary.category_slug ?? undefined,
        }))}
        collapsedVisibleRows={ACCOUNT_FLOWS_COLLAPSED}
        movementUnitsKind={movementUnitsKind}
        totalCount={allFlows.length}
      />
    </AccountDetailSharedLayout>
  );
}
