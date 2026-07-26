import { useMemo } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "../../i18n";
import { cn } from "../../cn";
import { MonthlyPerformanceComboChart } from "../charts/MonthlyPerformanceComboChart";
import { LineChartPanel } from "../charts/ValuationLineCharts";
import { DeptoAccountSummaryCards } from "../../pages/accountDetail/DeptoAccountSummaryCards";
import { DeptoPaymentScenarioTable, MortgageDividendosTable } from "../../pages/accountDetail/MortgageTables";
import { MonthlyPerfDetailTable } from "../account/MonthlyPerfDetailTable";
import { DailyPerfDetailTable } from "../account/DailyPerfDetailTable";
import { rollupPerfPointsYearly } from "../../dashboardTimeseriesYearly";
import { buildDailyPerfComboPoints } from "../../dailyPerfCombo";
import { useDailySeries } from "../../queries/hooks";
import { timeRangeToDays } from "../../timeRange";
import { useSurfacePrefs } from "../../surfaceDisplayPrefs";
import { SurfaceControls } from "../ui/SurfaceControls";
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
  // One control for the section's two P/L combos (shared on both root + mortgage pages —
  // it's the same single mortgage either way).
  const prefs = useSurfacePrefs("liab.mortgage.combos", "month", "3y");
  const isYearly = prefs.period === "year";
  const isDaily = prefs.period === "day";
  const timeRange = prefs.range;
  const xAxisGranularity = isYearly ? ("year" as const) : ("month" as const);
  const perfControls = (
    <SurfaceControls
      period={prefs.period}
      onPeriodChange={prefs.setPeriod}
      range={prefs.range}
      onRangeChange={prefs.setRange}
    />
  );
  // Detalle table período (independent of the combos); tables always cover full history.
  const detallePrefs = useSurfacePrefs("liab.mortgage.detalle", "month", "total");
  const tableIsDaily = detallePrefs.period === "day";
  const detalleDailySeries = useDailySeries(
    { accountId: summary.account_id },
    displayUnit,
    0,
    tableIsDaily && summary.account_id > 0
  );

  const accountChartTheme = useMemo(
    () => ({
      bar: chartStrokeFromRgbTriplet(accountColorRgb),
      areaStroke: "#64748b",
      areaFill: "rgba(148, 163, 184, 0.22)",
    }),
    [accountColorRgb]
  );

  // Day view: the mortgage's own daily P/L (its financing cost) as bars, with the cumulative
  // areas anchored on the monthly series — same builder the account page uses.
  const dailySeries = useDailySeries(
    { accountId: summary.account_id },
    displayUnit,
    timeRangeToDays(timeRange),
    isDaily && summary.account_id > 0
  );
  const dailyPerfPoints = useMemo(() => {
    if (!isDaily || !dailySeries.data?.points.length || !monthlyPerfRows.length) return null;
    const line = dailySeries.data.accounts?.find((l) => l.account_id === summary.account_id);
    if (!line?.pl) return null;
    return buildDailyPerfComboPoints({
      series: dailySeries.data,
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
  }, [isDaily, dailySeries.data, monthlyPerfRows, summary.account_id]);

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
              points={dailyPerfPoints ?? ytdChartPoints}
              displayUnit={displayUnit}
              xAxisGranularity={dailyPerfPoints ? "day" : xAxisGranularity}
              timeRange={timeRange}
              controls={perfControls}
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
              points={dailyPerfPoints ?? accChartPoints}
              displayUnit={displayUnit}
              xAxisGranularity={dailyPerfPoints ? "day" : xAxisGranularity}
              timeRange={timeRange}
              controls={perfControls}
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
          <div className="chart-panel-title-row">
            <h4 className={styles.subsectionTitleMid} style={{ marginBottom: 0 }}>
              {t(
                tableIsDaily
                  ? "accountDetail.dailyDetailTitle"
                  : detallePrefs.period === "year"
                    ? "accountDetail.yearlyDetailTitle"
                    : "accountDetail.monthlyDetailTitle"
              )}
            </h4>
            <SurfaceControls period={detallePrefs.period} onPeriodChange={detallePrefs.setPeriod} />
          </div>
          {tableIsDaily ? (
            detalleDailySeries.data ? (
              <DailyPerfDetailTable
                series={detalleDailySeries.data}
                displayUnit={displayUnit}
                dimClosedDays
              />
            ) : (
              <p className="muted">{t("common.loading")}</p>
            )
          ) : (
            <MonthlyPerfDetailTable
              rows={monthlyPerfRows}
              displayUnit={displayUnit}
              period={detallePrefs.period === "year" ? "year" : "month"}
              isMortgageAccount
              showStockInflowsColumn={false}
            />
          )}
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
