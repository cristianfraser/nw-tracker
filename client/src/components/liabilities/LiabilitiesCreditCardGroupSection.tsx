import { useMemo } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "../../i18n";
import { cn } from "../../cn";
import { CcInstallmentHistoryChart } from "../charts/CcInstallmentHistoryChart";
import { CcBillingMonthFinancingChart } from "../charts/CcBillingMonthFinancingChart";
import { LineChartPanel } from "../charts/ValuationLineCharts";
import { CreditCardDetallePorMesTable } from "../../pages/accountDetail/CreditCardDetallePorMesTable";
import {
  buildCcBillingMonthChartPoints,
  buildCcHistorialChartRows,
} from "../../pages/accountDetail/ccChartData";
import { MONTHLY_PERF_COLLAPSED } from "../../pages/accountDetail/shared";
import type { AccountCcInstallmentsResponse, TimeseriesBlock } from "../../types";
import { CreditCardSummaryCards } from "./CreditCardSummaryCards";
import styles from "../../pages/AccountDetailPage.module.css";

type Props = {
  ccLedger: AccountCcInstallmentsResponse;
  displayUnit: "clp" | "usd";
  xAxisGranularity: "month" | "year";
  valuationBlockForChart?: TimeseriesBlock | null;
  showValuationChart?: boolean;
  sectionTitle?: string;
  sectionHint?: string;
  linkTo?: string;
};

export function LiabilitiesCreditCardGroupSection({
  ccLedger,
  displayUnit,
  xAxisGranularity,
  valuationBlockForChart,
  showValuationChart = false,
  sectionTitle,
  sectionHint,
  linkTo,
}: Props) {
  const { t } = useTranslation();

  const historialChartRows = useMemo(
    () =>
      buildCcHistorialChartRows(
        ccLedger.installment_history_months ?? [],
        ccLedger.billing_detail_by_month,
        ccLedger.facturaciones
      ),
    [ccLedger.installment_history_months, ccLedger.billing_detail_by_month, ccLedger.facturaciones]
  );
  const financingChartPoints = useMemo(
    () => buildCcBillingMonthChartPoints(ccLedger.facturaciones, ccLedger.financing_pl_by_month),
    [ccLedger.facturaciones, ccLedger.financing_pl_by_month]
  );

  const title = sectionTitle ?? t("groupPage.pasivos.creditCardSectionTitle");
  const hint = sectionHint ?? t("groupPage.pasivos.creditCardSectionHint");

  return (
    <section className={styles.chartBlock}>
      {linkTo ? (
        <h2 className={styles.sectionTitle}>
          <Link to={linkTo}>{title}</Link>
        </h2>
      ) : (
        <h2 className={styles.sectionTitle}>{title}</h2>
      )}
      <p className={cn("muted", styles.proseSmTight)}>{hint}</p>

      <CreditCardSummaryCards ccLedger={ccLedger} />

      {(ccLedger.associated_card_last4s?.length ?? 0) > 0 ? (
        <section className={styles.chartBlock}>
          <h3 className={styles.subsectionTitleMid}>{t("accountDetail.creditCard.associatedCardsTitle")}</h3>
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
          <h3 className={styles.subsectionTitleMid}>{t("accountDetail.creditCard.historialTitle")}</h3>
          <p className={cn("muted", styles.proseSmTight)}>{t("accountDetail.creditCard.historialHint")}</p>
          <CcInstallmentHistoryChart rows={historialChartRows} />
        </section>
      ) : null}

      {showValuationChart && valuationBlockForChart ? (
        <div className={cn("chart-grid", "chart-grid--full-line", styles.chartBlock)}>
          <LineChartPanel
            title={t("accountDetail.creditCard.valuationTitle")}
            block={valuationBlockForChart}
            displayUnit={displayUnit}
            xAxisGranularity={xAxisGranularity}
          />
        </div>
      ) : null}

      <h3 className={styles.sectionTitleSpaced}>{t("accountDetail.creditCard.financingSectionTitle")}</h3>
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
    </section>
  );
}
