import { isHomeCurrency } from "nw-tracker-contracts/dto/apiConstants";
import { useMemo, type ReactNode } from "react";
import { useTranslation } from "../../i18n";
import { LineChartPanel, MonthlyPerformanceComboChart } from "../../components/charts/lazyCharts";
import { DailyPerfDetailTable } from "../../components/account/DailyPerfDetailTable";
import { MonthlyPerfDetailTable } from "../../components/account/MonthlyPerfDetailTable";
import { AccountBrokerageMovementsForm } from "../../components/account/AccountBrokerageMovementsForm";
import { AccountCashMovementsForm } from "../../components/account/AccountCashMovementsForm";
import { AccountUnitsFlowForm } from "../../components/account/AccountUnitsFlowForm";
import { buildDailyValuationBlock } from "../../dailySeriesChart";
import { servedDailyPerfComboPoints } from "../../servedDailyPerfCombo";
import { useHeldDailySeries } from "../../queries/hooks";
import { dailyPayloadPending } from "../../queries/pageShapeReady";
import { timeRangeToDays } from "../../timeRange";
import { useSurfacePrefs } from "../../surfaceDisplayPrefs";
import { SurfaceControls } from "../../components/ui/SurfaceControls";
import { OPTION_CONTRACT_FLOW_KINDS } from "../../panelAccounts/brokerageFlowKinds";
import {
  supportsBrokerageMovements,
  cashMovementsCurrency,
  supportsUnitsFlowMovements,
} from "../../accountMovementCreate";
import type { AccountDetailPageData } from "./useAccountDetailPageData";
import type { TimeseriesBlock } from "../../types";

/**
 * The position page's chart and detalle surfaces: the «Valorización y aportes» chart, the P/L
 * combo and the detalle list, each with its own Período/Rango control and its lazily fetched
 * daily series; and the add-movement form an account page's movements list carries.
 */

/** A Diario valuation chart whose daily series has not arrived: no lines, the pending frame. */
const EMPTY_VALUATION_BLOCK: TimeseriesBlock = { accounts: [], points: [] };

type Granularity = "day" | "month" | "year";

function granularityOf(period: string): Granularity {
  return period === "day" ? "day" : period === "year" ? "year" : "month";
}

export function useAccountChartSurfaces(data: AccountDetailPageData) {
  const { summary, ts, displayUnit, valuationPrefs, perfPrefs, monthlyPerfRows, valuationBlockForChart } = data;
  const loading = data.contentLoading;
  const valuationIsDaily = valuationPrefs.period === "day";
  const perfIsDaily = perfPrefs.period === "day";
  // Day view: per-session line + day P/L bars, fetched lazily while a D control is on; each held
  // across a unit or range change (a held daily series is drawn, dimmed, in its own unit).
  const dailySeries = useHeldDailySeries(
    { accountId: summary.account_id },
    displayUnit,
    timeRangeToDays(valuationPrefs.range),
    valuationIsDaily
  );
  const perfDailySeries = useHeldDailySeries(
    { accountId: summary.account_id },
    displayUnit,
    timeRangeToDays(perfPrefs.range),
    perfIsDaily,
    { perfLevels: true }
  );
  const valuationDailyPending = dailyPayloadPending(valuationIsDaily, dailySeries);
  const perfDailyPending = dailyPayloadPending(perfIsDaily, perfDailySeries);
  const dailyValuationBlock = useMemo(() => {
    if (!valuationIsDaily || valuationDailyPending) return null;
    return buildDailyValuationBlock(dailySeries.data, valuationBlockForChart ?? ts.accounts);
  }, [valuationIsDaily, valuationDailyPending, dailySeries.data, valuationBlockForChart, ts.accounts]);

  // Day view P/L bars: one bar account (this account), its daily P/L as `nominal_pl` with the
  // server's YTD level riding along.
  const dailyPerfPoints = useMemo(() => {
    if (!perfIsDaily || perfDailyPending) return null;
    if (!perfDailySeries.data?.points.length || !monthlyPerfRows.length) return null;
    const line = perfDailySeries.data.accounts?.find((l) => l.account_id === summary.account_id);
    if (!line?.pl) return null;
    return servedDailyPerfComboPoints({
      series: perfDailySeries.data,
      lines: [line],
      barAccounts: [{ account_id: summary.account_id, bar_data_key: "nominal_pl" }],
      ytdKey: "ytd_nominal_pl",
    });
  }, [perfIsDaily, perfDailyPending, perfDailySeries.data, monthlyPerfRows, summary.account_id]);

  return {
    valuation: {
      block: valuationIsDaily
        ? (dailyValuationBlock ?? EMPTY_VALUATION_BLOCK)
        : (valuationBlockForChart ?? ts.accounts),
      granularity: granularityOf(valuationPrefs.period),
      /** The unit of the payload the chart draws (the daily series' or the bundle's). */
      unit: valuationIsDaily ? (dailySeries.data?.unit ?? data.unit) : data.unit,
      loading: loading || (valuationIsDaily && dailySeries.loading),
      controls: (
        <SurfaceControls
          period={valuationPrefs.period}
          onPeriodChange={valuationPrefs.setPeriod}
          range={valuationPrefs.range}
          onRangeChange={valuationPrefs.setRange}
        />
      ),
    },
    perf: {
      isDaily: perfIsDaily,
      dailyPoints: dailyPerfPoints,
      granularity: granularityOf(perfPrefs.period),
      unit: perfIsDaily ? (perfDailySeries.data?.unit ?? data.unit) : data.unit,
      loading: loading || (perfIsDaily && perfDailySeries.loading),
      controls: (
        <SurfaceControls
          period={perfPrefs.period}
          onPeriodChange={perfPrefs.setPeriod}
          range={perfPrefs.range}
          onRangeChange={perfPrefs.setRange}
        />
      ),
    },
  };
}

export type AccountChartSurfaces = ReturnType<typeof useAccountChartSurfaces>;

/** «Valorización y aportes»: the account's value and its contributions, own Período/Rango. */
export function AccountValuationChart({
  data,
  surfaces,
  trimLeadingInactive = true,
  hideLegend = false,
}: {
  data: AccountDetailPageData;
  surfaces: AccountChartSurfaces;
  trimLeadingInactive?: boolean;
  /** No legend under the plot (the stock page: one line, named by the page). */
  hideLegend?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <LineChartPanel
      title={t("charts.valuationAndDeposits")}
      block={surfaces.valuation.block}
      displayUnit={surfaces.valuation.unit}
      xAxisGranularity={surfaces.valuation.granularity}
      timeRange={data.valuationPrefs.range}
      controls={surfaces.valuation.controls}
      trimLeadingInactive={trimLeadingInactive}
      hideLegend={hideLegend}
      loading={surfaces.valuation.loading}
    />
  );
}

/** «P/L mensual vs YTD»: the period's P/L bars with the running YTD (one P/L combo). */
export function AccountPlYtdCombo({
  data,
  surfaces,
  title,
  titleAs = "h3",
}: {
  data: AccountDetailPageData;
  surfaces: AccountChartSurfaces;
  title?: string;
  titleAs?: "h2" | "h3";
}) {
  const { t } = useTranslation();
  const { perf } = surfaces;
  return (
    <MonthlyPerformanceComboChart
      title={title ?? t("accountDetail.plMonthlyVsYtdTitle")}
      titleAs={titleAs}
      points={perf.isDaily ? (perf.dailyPoints ?? []) : data.ytdChartPoints}
      displayUnit={perf.unit}
      xAxisGranularity={perf.granularity}
      timeRange={data.perfPrefs.range}
      controls={perf.controls}
      barSeries={[
        {
          dataKey: "nominal_pl",
          name: t("accountDetail.deltaMonthNominal"),
          color: data.accountChartTheme.bar,
        },
      ]}
      areaKey="ytd_nominal_pl"
      areaName="YTD"
      areaFill={data.accountChartTheme.areaFill}
      areaStroke={data.accountChartTheme.areaStroke}
      loading={perf.loading}
    />
  );
}

/**
 * «Detalle por mes / año / día»: the heading with its own Período control, then the rows (the
 * daily rows fetched lazily, with the server's YTD levels, while Diario is on).
 */
export function AccountDetalleSurface({
  data,
  headingAs: Heading = "h3",
  isCuotaLedgerAccount = false,
}: {
  data: AccountDetailPageData;
  headingAs?: "h2" | "h3";
  isCuotaLedgerAccount?: boolean;
}) {
  const { t } = useTranslation();
  const { summary, displayUnit } = data;
  // Detalle table período (independent of the charts); tables always cover full history.
  const detallePrefs = useSurfacePrefs(
    summary.account_id ? `account.${summary.account_id}.detalle` : null,
    "month",
    "total"
  );
  const isDaily = detallePrefs.period === "day";
  const detalleDailySeries = useHeldDailySeries(
    { accountId: summary.account_id },
    displayUnit,
    0,
    isDaily && summary.account_id > 0,
    { perfLevels: true }
  );
  return (
    <>
      <div className="chart-panel-title-row">
        <Heading>
          {t(
            isDaily
              ? "accountDetail.dailyDetailTitle"
              : detallePrefs.period === "year"
                ? "accountDetail.yearlyDetailTitle"
                : "accountDetail.monthlyDetailTitle"
          )}
        </Heading>
        <SurfaceControls period={detallePrefs.period} onPeriodChange={detallePrefs.setPeriod} />
      </div>
      {isDaily ? (
        <DailyPerfDetailTable series={detalleDailySeries.data} dimClosedDays loading={detalleDailySeries.loading} />
      ) : (
        <MonthlyPerfDetailTable
          key={`${data.id}-${data.unit}-mp-detail`}
          rows={data.monthlyPerfRows}
          yearlyRows={data.monthlyPerfYearlyRows}
          displayUnit={data.unit}
          period={detallePrefs.period === "year" ? "year" : "month"}
          isAfpAccount={isCuotaLedgerAccount}
          unitsKind={summary.units_kind}
          loading={data.contentLoading}
        />
      )}
    </>
  );
}

/**
 * The capability form the account's movements list carries (`movement_create`): a cash ledger's
 * in its declared currency, a brokerage account's, a units ledger's; hidden until the bundle
 * states one — a wrong form is worse than a late one.
 */
export function useAccountMovementForm(data: AccountDetailPageData): { form: ReactNode } {
  const { t } = useTranslation();
  const { summary } = data;
  const loading = data.contentLoading;
  const cashFormCurrency = cashMovementsCurrency(summary.movement_create);
  const foreignCashCapability = cashFormCurrency != null && !isHomeCurrency(cashFormCurrency);
  // A foreign-cash account never takes the brokerage form, also while loading (the placeholder's category, `usd`).
  const isForeignCashAccount = foreignCashCapability || (loading && summary.category_slug === "usd");
  const showBrokerageMovementsForm =
    supportsBrokerageMovements(summary.movement_create) && !isForeignCashAccount && cashFormCurrency == null;
  const showUnitsFlowForm = supportsUnitsFlowMovements(summary.movement_create);
  const unitsFlowUnitLabel = showUnitsFlowForm
    ? t(`accountDetail.unitsFlow.unitLabels.${summary.movement_create?.unit_label ?? "unidades"}`)
    : null;
  const form =
    cashFormCurrency != null ? (
      <AccountCashMovementsForm accountId={summary.account_id} currency={cashFormCurrency} />
    ) : showBrokerageMovementsForm ? (
      <AccountBrokerageMovementsForm
        accountId={summary.account_id}
        flowKinds={summary.option_contract != null ? OPTION_CONTRACT_FLOW_KINDS : undefined}
      />
    ) : showUnitsFlowForm && unitsFlowUnitLabel ? (
      <AccountUnitsFlowForm accountId={summary.account_id} unitLabel={unitsFlowUnitLabel} />
    ) : null;
  return { form };
}
