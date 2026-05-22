import { useTranslation } from "../../i18n";
import { MonthlyPerformanceComboChart } from "../../components/MonthlyPerformanceComboChart";
import { AccountFlowsTable } from "../../components/AccountFlowsTable";
import { MonthlyPerfDetailTable } from "../../components/MonthlyPerfDetailTable";
import { Table } from "../../components/Table";
import { LineChartPanel } from "../../components/ValuationLineCharts";
import { formatClp, formatInstrumentUnits } from "../../format";
import { cn } from "../../cn";
import { AccountDetailSharedLayout } from "./AccountDetailSharedLayout";
import { DeptoPaymentScenarioTable, MortgageDividendosTable } from "./MortgageTables";
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
    monthlyPerf,
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
  } = data;

  const showMonthlyPerformance =
    summary.category_slug !== "cuenta_corriente" && summary.category_slug !== "cuenta_ahorro_vivienda";
  const isAfpAccount = summary.category_slug === "afp";
  const isMortgageAccount = summary.category_slug === "mortgage";
  const ccChartsFromParsedLedger =
    summary.category_slug === "credit_card" && data.ccLedger.source === "db";

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
    >
      <div className={styles.positionBlock}>
        <h2 className={styles.sectionTitleCompact}>Posición (ticker y cuotas)</h2>
        <p className={cn("muted", styles.proseMutedXs)}>
          Acciones: cuotas desde <span className="mono">cfraser/net worth-stocks.csv</span> (columna valor
          acción). Cripto: saldo neto de moneda desde notas de movimientos del import.
          {isAfpAccount ? (
            <>
              {" "}
              AFP UNO Fondo A: cuotas totales desde <span className="mono">movements.units_delta</span> (certificado
              en <span className="mono">cfraser/afp-uno-certificado-cotizaciones.csv</span> o{" "}
              <span className="mono">.txt</span> al correr <span className="mono">import:excel</span>, o{" "}
              <span className="mono">npm run afp:uno:cert-sync</span>).
            </>
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
        />
      </div>

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
          ) : monthlyPerf == null ? (
            <p className="muted">Cargando rendimiento…</p>
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

      {mortgageLedger.source === "csv" && mortgageLedger.rows.length > 0 ? (
        <>
          <MortgageDividendosTable
            ledger={mortgageLedger}
            variant={isMortgageAccount ? "mortgage" : "property"}
          />
          {mortgageLedger.payment_scenarios && mortgageLedger.payment_scenarios.length > 0 ? (
            <DeptoPaymentScenarioTable rows={mortgageLedger.payment_scenarios} />
          ) : null}
        </>
      ) : mortgageLedger.source === "csv" ? (
        <p className={cn("muted", styles.marginTopBase)}>
          No hay filas con pago CLP en <span className="mono">cfraser/depto-dividendos.csv</span>
          {mortgageLedger.meta?.csv_absolute_path ? (
            <>
              . El servidor leyó{" "}
              <span className={cn("mono", styles.breakAll)}>{mortgageLedger.meta.csv_absolute_path}</span>
              {mortgageLedger.meta.csv_file_exists === false ? " (archivo no encontrado)" : ""}.
            </>
          ) : null}{" "}
          Re-exporta la hoja dividendos desde Numbers o revisa <span className="mono">CFRASER_CSV_DIR</span> si apunta
          a otra carpeta.
        </p>
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

      <h2>{t("accountDetail.flowsTitle")}</h2>
      <p className={cn("muted", styles.proseMutedXs)}>
        Un solo listado por cuenta: aportes, retiros, compras, dividendos, cuotas, etc. Todo en{" "}
        <span className="mono">movements</span> (SPY/VEA usan <span className="mono">flow_kind</span>, ticker y USD).
        Altas: <span className="mono">POST /api/accounts/{id}/movements</span>.
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
