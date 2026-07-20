import { useMemo } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "../../i18n";
import { cn } from "../../cn";
import { MonthlyPerformanceComboChart } from "../charts/MonthlyPerformanceComboChart";
import { LineChartPanel } from "../charts/ValuationLineCharts";
import { DeptoAccountSummaryCards } from "../../pages/accountDetail/DeptoAccountSummaryCards";
import { DeptoPaymentScenarioTable, MortgageDividendosTable } from "../../pages/accountDetail/MortgageTables";
import { MonthlyPerfDetailTable } from "../account/MonthlyPerfDetailTable";
import { rollupPerfPointsYearly } from "../../dashboardTimeseriesYearly";
import type { CardGroupMetricsPeriod } from "../../dashboardCardBreakdown";
import { chartStrokeFromRgbTriplet } from "../../chartColors";
import type {
  AccountMonthlyPerformanceRow,
  AccountMortgageLedgerResponse,
  AccountSummaryResponse,
  DashboardAccountRow,
  TimeseriesBlock,
} from "../../types";
import styles from "../../pages/AccountDetailPage.module.css";

type Props = {
  mortgageLedger: AccountMortgageLedgerResponse;
  displayUnit: "clp" | "usd";
  metricsPeriod: CardGroupMetricsPeriod;
  xAxisGranularity: "month" | "year";
  monthlyPerfRows: readonly AccountMonthlyPerformanceRow[];
  summary: Pick<AccountSummaryResponse, "latest_valuation_clp" | "account_id">;
  accountDashRow: DashboardAccountRow | null;
  accountColorRgb?: string | null;
  valuationBlockForChart?: TimeseriesBlock | null;
  showValuationChart?: boolean;
  sectionTitle?: string;
  sectionHint?: string;
  linkTo?: string;
};

export function LiabilitiesMortgageGroupSection({
  mortgageLedger,
  displayUnit,
  metricsPeriod,
  xAxisGranularity,
  monthlyPerfRows,
  summary,
  accountDashRow,
  accountColorRgb,
  valuationBlockForChart,
  showValuationChart = false,
  sectionTitle,
  sectionHint,
  linkTo,
}: Props) {
  const { t } = useTranslation();
  const isYearly = metricsPeriod === "year";

  const accountChartTheme = useMemo(
    () => ({
      bar: chartStrokeFromRgbTriplet(accountColorRgb),
      areaStroke: "#64748b",
      areaFill: "rgba(148, 163, 184, 0.22)",
    }),
    [accountColorRgb]
  );

  const ytdChartPoints = useMemo(() => {
    if (!monthlyPerfRows.length) return [];
    const monthly = [...monthlyPerfRows].reverse().map((r) => ({
      as_of_date: r.as_of_date,
      nominal_pl: r.nominal_pl ?? 0,
      ytd_nominal_pl: r.ytd_nominal_pl ?? 0,
    }));
    if (!isYearly) return monthly;
    return rollupPerfPointsYearly(monthly, {
      sumKeys: ["nominal_pl"],
      ytdKey: "ytd_nominal_pl",
    });
  }, [monthlyPerfRows, isYearly]);

  const accChartPoints = useMemo(() => {
    if (!monthlyPerfRows.length) return [];
    const monthly = [...monthlyPerfRows].reverse().map((r) => ({
      as_of_date: r.as_of_date,
      delta_month: r.nominal_pl ?? 0,
      accumulated_earnings: r.cumulative_nominal_pl ?? 0,
    }));
    if (!isYearly) return monthly;
    return rollupPerfPointsYearly(monthly, {
      sumKeys: ["delta_month"],
      accumKey: "accumulated_earnings",
    });
  }, [monthlyPerfRows, isYearly]);

  const title = sectionTitle ?? t("groupPage.pasivos.mortgageSectionTitle");
  const hint = sectionHint ?? t("groupPage.pasivos.mortgageSectionHint");

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

      <DeptoAccountSummaryCards
        variant="mortgage"
        ledger={mortgageLedger}
        summary={summary}
        monthlyPerfRows={monthlyPerfRows}
        accountDashRow={accountDashRow}
      />

      {showValuationChart && valuationBlockForChart ? (
        <div className={cn("chart-grid", "chart-grid--full-line", styles.chartBlock)}>
          <LineChartPanel
            title={t("groupPage.pasivos.mortgageValuationTitle")}
            block={valuationBlockForChart}
            displayUnit={displayUnit}
            xAxisGranularity={xAxisGranularity}
          />
        </div>
      ) : null}

      {monthlyPerfRows.length > 0 ? (
        <>
          <h3 className={styles.sectionTitleSpaced}>{t("groupPage.pasivos.mortgagePerfTitle")}</h3>
          <p className={cn("muted", styles.proseMutedXs)}>{t("groupPage.pasivos.mortgagePerfHint")}</p>
          <h4 className={styles.subsectionTitleTight}>{t("accountDetail.creditCard.ytdSection")}</h4>
          <div className={cn("chart-grid", "chart-grid--full-line", styles.chartBlockFlush)}>
            <MonthlyPerformanceComboChart
              title={t("groupPage.pasivos.mortgageYtdChartTitle")}
              titleAs="h3"
              points={ytdChartPoints}
              displayUnit={displayUnit}
              xAxisGranularity={xAxisGranularity}
              barSeries={[
                {
                  dataKey: "nominal_pl",
                  name: t("groupPage.pasivos.mortgageBarMonthlyCost"),
                  color: accountChartTheme.bar,
                },
              ]}
              areaKey="ytd_nominal_pl"
              areaName="YTD"
              areaFill={accountChartTheme.areaFill}
              areaStroke={accountChartTheme.areaStroke}
            />
          </div>
          <h4 className={styles.subsectionTitleLoose}>{t("accountDetail.creditCard.accSection")}</h4>
          <div className={cn("chart-grid", "chart-grid--full-line", styles.chartBlockFlush)}>
            <MonthlyPerformanceComboChart
              title={t("groupPage.pasivos.mortgageAccChartTitle")}
              titleAs="h3"
              points={accChartPoints}
              displayUnit={displayUnit}
              xAxisGranularity={xAxisGranularity}
              barSeries={[
                {
                  dataKey: "delta_month",
                  name: t("groupPage.pasivos.mortgageBarMonthlyCost"),
                  color: accountChartTheme.bar,
                },
              ]}
              areaKey="accumulated_earnings"
              areaName={t("accountDetail.creditCard.accAreaName")}
              areaFill={accountChartTheme.areaFill}
              areaStroke={accountChartTheme.areaStroke}
              alternateYearAreaStripes={false}
            />
          </div>
          <h4 className={styles.subsectionTitleMid}>
            {t(isYearly ? "accountDetail.yearlyDetailTitle" : "accountDetail.monthlyDetailTitle")}
          </h4>
          <MonthlyPerfDetailTable
            rows={monthlyPerfRows}
            displayUnit={displayUnit}
            isMortgageAccount
            showStockInflowsColumn={false}
          />
        </>
      ) : null}

      {mortgageLedger.has_sheet_rows && mortgageLedger.rows.length > 0 ? (
        <>
          <MortgageDividendosTable ledger={mortgageLedger} variant="mortgage" />
          {mortgageLedger.payment_scenarios && mortgageLedger.payment_scenarios.length > 0 ? (
            <DeptoPaymentScenarioTable rows={mortgageLedger.payment_scenarios} />
          ) : null}
        </>
      ) : (
        <p className="muted">{t("account.creditCard.mortgageSheetEmpty")}</p>
      )}
    </section>
  );
}
