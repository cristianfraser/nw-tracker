import { useMemo } from "react";
import { useTranslation } from "../../i18n";
import { CcInstallmentHistoryChart } from "../../components/charts/CcInstallmentHistoryChart";
import { CcBillingMonthFinancingChart } from "../../components/charts/CcBillingMonthFinancingChart";
import { useDailySeries } from "../../queries/hooks";
import { useDisplayPreferences } from "../../context/DisplayPreferencesContext";
import { timeRangeToDays } from "../../timeRange";
import type { CcHistorialChartPoint } from "../../types";
import { CreditCardDetallePorMesTable } from "./CreditCardDetallePorMesTable";
import { AccountFlowsSection } from "../../components/account/AccountFlowsSection";
import { CreditCardSummaryCards } from "../../components/liabilities/CreditCardSummaryCards";
import { cn } from "../../cn";
import { AccountDetailSharedLayout } from "./AccountDetailSharedLayout";
import { ExportToolbarButton } from "../../components/export/ExportModal";
import { AccountImportSection } from "../../components/account/AccountImportSection";
import { CreditCardConfigSection } from "../../components/account/CreditCardConfigSection";
import { CreditCardDetailSections } from "./CreditCardSections";
import type { AccountDetailPageData } from "./useAccountDetailPageData";
import { movementUnitsKind } from "./shared";
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
    extraCcOffsets,
    setExtraCcOffsets,
  } = data;

  const historialChartRows = ccLedger.historial_chart ?? [];
  const financingChartPoints = ccLedger.billing_month_chart ?? [];
  const isYearly = metricsPeriod === "year";
  const isDaily = metricsPeriod === "day";

  // Day mode: the historial chart keeps its two lines at day grain — saldo total from the
  // per-day owed walk and deuda en cuotas from the daily plan-debt series — with the
  // month-frame billed/paid bars hidden. CLP always, matching the monthly historial.
  const { timeRange } = useDisplayPreferences();
  const dailySeries = useDailySeries(
    { accountId: summary.account_id },
    "clp",
    timeRangeToDays(timeRange),
    isDaily
  );
  const dailyHistorialRows = useMemo((): CcHistorialChartPoint[] | null => {
    if (!isDaily || !dailySeries.data?.points.length) return null;
    const debt = dailySeries.data.cc_installment_debt ?? null;
    return dailySeries.data.points.map((pt, i) => ({
      month: pt.as_of_date,
      installment_payments_clp: 0,
      facturado_clp: null,
      cupo_en_cuotas_clp: debt?.[i] ?? null,
      balance_total_clp: pt.value,
    }));
  }, [isDaily, dailySeries.data]);

  const heroClp =
    displayUnit === "usd"
      ? 0
      : data.accountDashRow?.current_value_clp ?? summary.latest_valuation_clp ?? ccLedger.totals.total_remaining_principal_clp;

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
      accountNavChildren={data.accountNavChildren}
      stripDetailSlots={<CreditCardSummaryCards ccLedger={ccLedger} stripSlots />}
      toolbar={<ExportToolbarButton exportPath={`/api/accounts/${summary.account_id}/export.xlsx`} />}
      loading={data.contentLoading}
      showNavChildCards={false}
    >
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
          <p className={cn("muted", styles.proseSmTight)}>
            {t(
              isDaily
                ? "accountDetail.creditCard.historialHintDaily"
                : isYearly
                  ? "accountDetail.creditCard.historialHintYearly"
                  : "accountDetail.creditCard.historialHint"
            )}
          </p>
          {isDaily && dailyHistorialRows == null ? (
            <p className="muted">{t("common.loading")}</p>
          ) : (
            <CcInstallmentHistoryChart
              rows={historialChartRows}
              openBillingMonth={ccLedger.open_billing_month}
              dailyRows={dailyHistorialRows}
            />
          )}
        </section>
      ) : null}

      {!isDaily ? (
        <>
          <h2 className={styles.sectionTitleSpaced}>{t("accountDetail.creditCard.financingSectionTitle")}</h2>
          <p className={cn("muted", styles.proseMutedXs)}>{t("accountDetail.creditCard.financingSectionHint")}</p>
          <div className={cn("chart-grid", "chart-grid--full-line", styles.chartBlockFlush)}>
            <CcBillingMonthFinancingChart
              title={t(
                isYearly
                  ? "accountDetail.creditCard.financingChartTitleYearly"
                  : "accountDetail.creditCard.financingChartTitle"
              )}
              titleAs="h3"
              points={financingChartPoints}
              displayUnit={displayUnit}
            />
          </div>
        </>
      ) : null}

      {(ccLedger.billing_detail_by_month?.length ?? 0) > 0 ? (
        <>
          <h3 className={styles.subsectionTitleMid}>
            {t(isYearly ? "accountDetail.yearlyDetailTitle" : "accountDetail.monthlyDetailTitle")}
          </h3>
          <p className={cn("muted", styles.proseSmTight)}>
            {t(
              isYearly
                ? "accountDetail.creditCard.detallePorMesBillingHintYearly"
                : "accountDetail.creditCard.detallePorMesBillingHint"
            )}
          </p>
          <CreditCardDetallePorMesTable
            rows={ccLedger.billing_detail_by_month ?? []}
          />
        </>
      ) : null}

      <CreditCardConfigSection accountId={summary.account_id} />

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
        accountId={summary.account_id}
        movementUnitsKind={movementUnitsKind}
      />
    </AccountDetailSharedLayout>
  );
}
