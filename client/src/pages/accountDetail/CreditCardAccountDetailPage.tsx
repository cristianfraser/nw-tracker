import { useMemo } from "react";
import { useTranslation } from "../../i18n";
import { CcInstallmentHistoryChart } from "../../components/charts/CcInstallmentHistoryChart";
import { CcBillingMonthFinancingChart } from "../../components/charts/CcBillingMonthFinancingChart";
import { CreditCardDetallePorMesTable } from "./CreditCardDetallePorMesTable";
import { LineChartPanel } from "../../components/charts/ValuationLineCharts";
import { AccountFlowsSection } from "../../components/account/AccountFlowsSection";
import { CreditCardSummaryCards } from "../../components/liabilities/CreditCardSummaryCards";
import { formatClp } from "../../format";
import { cn } from "../../cn";
import { AccountDetailSharedLayout } from "./AccountDetailSharedLayout";
import { AccountImportSection } from "../../components/account/AccountImportSection";
import { CreditCardDetailSections } from "./CreditCardSections";
import type { AccountDetailPageData } from "./useAccountDetailPageData";
import {
  buildCcBillingMonthChartPoints,
  buildCcHistorialChartRows,
} from "./ccChartData";
import {
  ACCOUNT_FLOWS_COLLAPSED,
  MONTHLY_PERF_COLLAPSED,
  movementUnitsKind,
} from "./shared";
import styles from "../AccountDetailPage.module.css";

type Props = {
  data: AccountDetailPageData;
};

export function CreditCardAccountDetailPage({ data }: Props) {
  const { t } = useTranslation();
  const {
    summary,
    ts,
    ccLedger,
    displayUnit,
    metricsPeriod,
    xAxisGranularity,
    valuationBlockForChart,
    movementsOnlyPersonalDeposits,
    setMovementsOnlyPersonalDeposits,
    displayedFlows,
    allFlows,
    extraCcOffsets,
    setExtraCcOffsets,
  } = data;

  const hist = ccLedger.installment_history_months ?? [];
  const historialChartRows = useMemo(
    () =>
      buildCcHistorialChartRows(
        hist,
        ccLedger.billing_detail_by_month,
        ccLedger.facturaciones
      ),
    [hist, ccLedger.billing_detail_by_month, ccLedger.facturaciones]
  );
  const financingChartPoints = useMemo(
    () =>
      buildCcBillingMonthChartPoints(
        ccLedger.facturaciones,
        ccLedger.financing_pl_by_month
      ),
    [ccLedger.facturaciones, ccLedger.financing_pl_by_month]
  );

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
      showNavChildCards={false}
    >
      <CreditCardSummaryCards ccLedger={ccLedger} />

      {(ccLedger.associated_card_last4s?.length ?? 0) > 0 ? (
        <section className={styles.chartBlock}>
          <h2 className={styles.sectionTitle}>{t("accountDetail.creditCard.associatedCardsTitle")}</h2>
          <p className={cn("muted", styles.proseSmTight)}>{t("accountDetail.creditCard.associatedCardsHint")}</p>
          <ul className={styles.proseSmTight}>
            {ccLedger.associated_card_last4s!.map((last4) => (
              <li key={last4} className="mono">
                ·{last4}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

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

      <h2 className={styles.sectionTitleSpaced}>{t("accountDetail.creditCard.financingSectionTitle")}</h2>
      <p className={cn("muted", styles.proseMutedXs)}>{t("accountDetail.creditCard.financingSectionHint")}</p>
      <div className={cn("chart-grid", "chart-grid--full-line", styles.chartBlockFlush)}>
        <CcBillingMonthFinancingChart
          title={t("accountDetail.creditCard.financingChartTitle")}
          titleAs="h3"
          points={financingChartPoints}
          displayUnit={displayUnit}
        />
      </div>

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

      <AccountFlowsSection
        hint={
          <p className={cn("muted", styles.proseMutedXs)}>{t("accountDetail.creditCard.flowsHint")}</p>
        }
        rows={displayedFlows.map((row) => ({
          ...row,
          category_slug: summary.category_slug ?? undefined,
        }))}
        totalCount={allFlows.length}
        movementsOnlyPersonalDeposits={movementsOnlyPersonalDeposits}
        onMovementsOnlyPersonalDepositsChange={setMovementsOnlyPersonalDeposits}
        movementUnitsKind={movementUnitsKind}
        collapsedVisibleRows={ACCOUNT_FLOWS_COLLAPSED}
      />
    </AccountDetailSharedLayout>
  );
}
