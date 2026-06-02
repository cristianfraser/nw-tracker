import { useMemo } from "react";
import { useTranslation } from "../../i18n";
import { CcInstallmentHistoryChart } from "../../components/charts/CcInstallmentHistoryChart";
import { MonthlyPerformanceComboChart } from "../../components/charts/MonthlyPerformanceComboChart";
import { CreditCardDetallePorMesTable } from "./CreditCardDetallePorMesTable";
import { LineChartPanel } from "../../components/charts/ValuationLineCharts";
import { AccountFlowsTable } from "../../components/account/AccountFlowsTable";
import { formatClp } from "../../format";
import { cn } from "../../cn";
import { AccountDetailSharedLayout } from "./AccountDetailSharedLayout";
import { AccountImportSection } from "../../components/account/AccountImportSection";
import { CreditCardDetailSections } from "./CreditCardSections";
import type { AccountDetailPageData } from "./useAccountDetailPageData";
import { buildCcHistorialChartRows, mergeFacturadoIntoPerfPoints } from "./ccChartData";
import {
  ACCOUNT_FLOWS_COLLAPSED,
  MONTHLY_PERF_COLLAPSED,
  formatYmEs,
  movementUnitsKind,
} from "./shared";
import styles from "../AccountDetailPage.module.css";

const FACTURADO_BAR_COLOR = "#d97706";

type Props = {
  data: AccountDetailPageData;
};

function CreditCardSummaryCards({ data }: { data: AccountDetailPageData }) {
  const { t } = useTranslation();
  const detalle = data.ccLedger.billing_detail_by_month ?? [];
  const latestClosed = detalle.find((r) => r.as_of_kind === "statement");
  const latestRow = detalle[0];
  const facturaciones = data.ccLedger.facturaciones ?? [];
  const latestFact = facturaciones[0];

  return (
    <div className={cn("cards", styles.cardsBelow)}>
      <div className="card">
        <div className="label">{t("accountDetail.creditCard.lastFacturado")}</div>
        <div className="value mono">
          {latestClosed?.total_facturado_clp != null
            ? formatClp(latestClosed.total_facturado_clp)
            : latestFact?.facturado_total_clp != null
              ? formatClp(latestFact.facturado_total_clp)
              : "—"}
        </div>
        {latestClosed ? (
          <div className="muted mono">
            {latestClosed.billing_month} ({formatYmEs(latestClosed.billing_month)})
          </div>
        ) : null}
      </div>
      <div className="card">
        <div className="label">{t("accountDetail.creditCard.nextPayment")}</div>
        <div className={cn("value", "mono", styles.cardValueSecondary)}>
          {data.ccLedger.totals.next_calendar_month
            ? `${formatYmEs(data.ccLedger.totals.next_calendar_month)} · ${formatClp(data.ccLedger.totals.next_calendar_month_total_clp ?? 0)}`
            : latestFact?.cuota_a_pagar_clp != null
              ? formatClp(latestFact.cuota_a_pagar_clp)
              : "—"}
        </div>
      </div>
      <div className="card">
        <div className="label">{t("accountDetail.creditCard.cupoUtilizado")}</div>
        <div className="value mono">
          {formatClp(latestRow?.cupo_en_cuotas_clp ?? data.ccLedger.totals.total_remaining_principal_clp)}
        </div>
      </div>
      <div className="card">
        <div className="label">{t("accountDetail.creditCard.saldoTotal")}</div>
        <div className="value mono">
          {latestRow != null ? formatClp(latestRow.balance_total_clp) : "—"}
        </div>
      </div>
    </div>
  );
}

export function CreditCardAccountDetailPage({ data }: Props) {
  const { t } = useTranslation();
  const {
    summary,
    ts,
    ccLedger,
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
    extraCcOffsets,
    setExtraCcOffsets,
  } = data;

  const ccChartsFromParsedLedger = ccLedger.has_installment_ledger;
  const hist = ccLedger.installment_history_months ?? [];
  const historialChartRows = useMemo(
    () =>
      buildCcHistorialChartRows(
        hist,
        ccLedger.billing_detail_by_month,
        ccLedger.billing_month_balances
      ),
    [hist, ccLedger.billing_detail_by_month, ccLedger.billing_month_balances]
  );
  const ytdWithFacturado = useMemo(
    () => mergeFacturadoIntoPerfPoints(ytdChartPoints, ccLedger.billing_month_balances),
    [ytdChartPoints, ccLedger.billing_month_balances]
  );
  const accWithFacturado = useMemo(
    () => mergeFacturadoIntoPerfPoints(accChartPoints, ccLedger.billing_month_balances),
    [accChartPoints, ccLedger.billing_month_balances]
  );

  const facturadoBar = {
    dataKey: "facturado_clp" as const,
    name: t("accountDetail.creditCard.chartFacturado"),
    color: FACTURADO_BAR_COLOR,
  };

  const heroClp =
    displayUnit === "usd"
      ? 0
      : data.accountDashRow?.current_value_clp ?? summary.latest_valuation_clp ?? ccLedger.totals.total_remaining_principal_clp;

  const heroSubtitle =
    ccLedger.has_installment_ledger ? (
      <>
        {t("accountDetail.creditCard.heroCupoHint")}{" "}
        <span className="mono">{formatClp(ccLedger.totals.total_remaining_principal_clp)}</span>
        {summary.latest_valuation_date ? (
          <>
            {" "}
            · {t("accountDetail.creditCard.asOf")} {summary.latest_valuation_date}
          </>
        ) : null}
      </>
    ) : undefined;

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
      heroClp={heroClp}
      heroApiUsd={displayUnit === "usd" ? data.accountDashRow?.current_value_usd ?? data.chartUsdVal : null}
      dash={data.dash}
      overviewPoints={data.overviewPoints}
      accountNavChildren={data.accountNavChildren}
      heroSubtitle={heroSubtitle}
      loading={data.contentLoading}
    >
      <CreditCardSummaryCards data={data} />

      {ccLedger.has_installment_ledger && historialChartRows.length > 0 ? (
        <section className={styles.chartBlock}>
          <h2 className={styles.sectionTitle}>{t("accountDetail.creditCard.historialTitle")}</h2>
          <p className={cn("muted", styles.proseSmTight)}>{t("accountDetail.creditCard.historialHint")}</p>
          <CcInstallmentHistoryChart rows={historialChartRows} />
        </section>
      ) : null}

      <div className={cn("chart-grid", "chart-grid--full-line", styles.chartBlock)}>
        <LineChartPanel
          title={t("accountDetail.creditCard.valuationTitle")}
          block={valuationBlockForChart ?? ts.accounts}
          displayUnit={displayUnit}
          xAxisGranularity={xAxisGranularity}
        />
      </div>

      <h2 className={styles.sectionTitleSpaced}>{t("accountDetail.creditCard.monthlyPerfTitle")}</h2>
      <p className={cn("muted", styles.proseMutedXs)}>
        {t("accountDetail.creditCard.monthlyPerfHint")}
        {ccChartsFromParsedLedger ? ` ${t("accountDetail.creditCard.monthlyPerfDbHint")}` : null}
      </p>
      {monthlyPerfErr ? (
        <p className={cn("error", styles.errorText)}>{monthlyPerfErr}</p>
      ) : monthlyPerfRows.length === 0 ? (
        <p className="muted">{t("accountDetail.creditCard.monthlyPerfEmpty")}</p>
      ) : (
        <>
          <h3 className={styles.subsectionTitleTight}>{t("accountDetail.creditCard.ytdSection")}</h3>
          <div className={cn("chart-grid", "chart-grid--full-line", styles.chartBlockFlush)}>
            <MonthlyPerformanceComboChart
              title={t("accountDetail.creditCard.ytdChartTitle")}
              titleAs="h3"
              points={ytdWithFacturado}
              displayUnit={displayUnit}
              xAxisGranularity={xAxisGranularity}
              barSeries={[
                {
                  dataKey: "nominal_pl",
                  name: t("accountDetail.creditCard.barMonthlyPl"),
                  color: accountChartTheme.bar,
                },
                facturadoBar,
              ]}
              areaKey="ytd_nominal_pl"
              areaName="YTD"
              areaFill={accountChartTheme.areaFill}
              areaStroke={accountChartTheme.areaStroke}
            />
          </div>
          <h3 className={styles.subsectionTitleLoose}>{t("accountDetail.creditCard.accSection")}</h3>
          <div className={cn("chart-grid", "chart-grid--full-line", styles.chartBlockFlush)}>
            <MonthlyPerformanceComboChart
              title={t("accountDetail.creditCard.accChartTitle")}
              titleAs="h3"
              points={accWithFacturado}
              displayUnit={displayUnit}
              xAxisGranularity={xAxisGranularity}
              barSeries={[
                {
                  dataKey: "delta_month",
                  name: t("accountDetail.creditCard.barMonthlyDelta"),
                  color: accountChartTheme.bar,
                },
                facturadoBar,
              ]}
              areaKey="accumulated_earnings"
              areaName={t("accountDetail.creditCard.accAreaName")}
              areaFill={accountChartTheme.areaFill}
              areaStroke={accountChartTheme.areaStroke}
              alternateYearAreaStripes={false}
            />
          </div>
        </>
      )}

      {(ccLedger.billing_detail_by_month?.length ?? 0) > 0 ? (
        <>
          <h3 className={styles.subsectionTitleMid}>{t("accountDetail.monthlyDetailTitle")}</h3>
          <p className={cn("muted", styles.proseSmTight)}>
            {t("accountDetail.creditCard.detallePorMesBillingHint")}
          </p>
          <CreditCardDetallePorMesTable
            rows={ccLedger.billing_detail_by_month ?? []}
            collapsedVisibleRows={MONTHLY_PERF_COLLAPSED}
          />
        </>
      ) : null}

      <AccountImportSection
        accountId={summary.account_id}
        displayUnit={displayUnit}
        extraCcOffsetsKey={JSON.stringify(extraCcOffsets)}
      />

      <CreditCardDetailSections
        ledger={ccLedger}
        displayUnit={displayUnit}
        extraOffsets={extraCcOffsets}
        accountId={summary.account_id}
        onExtraOffsetsChange={setExtraCcOffsets}
      />

      <h2>{t("accountDetail.flowsTitle")}</h2>
      <p className={cn("muted", styles.proseMutedXs)}>{t("accountDetail.creditCard.flowsHint")}</p>
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
