import { useMemo } from "react";
import { PageGridTile } from "../components/layout/PageGridTile";
import { FlowsPlChart } from "../components/charts/FlowsPlChart";
import { FlowsPlAccountRows } from "../components/flows/FlowsPlAccountRows";
import { FlowsPlPeriodList } from "../components/flows/FlowsPlPeriodList";
import { useDisplayPreferences } from "../context/DisplayPreferencesContext";
import { useSurfacePrefs } from "../surfaceDisplayPrefs";
import { SurfaceControls } from "../components/ui/SurfaceControls";
import { loadableClass } from "../components/ui/Loadable";
import { flowTableGranularity, formatFlowMoney } from "../flowsDisplay";
import { clipMonthsThenRollup, timeRangeToDays } from "../timeRange";
import { rollupFlowsPlChartPointsByYear } from "../flowsPlAggregate";
import { flowsPlBucketLabel, useTranslation } from "../i18n";
import { useHeldFlowsPl } from "../queries/hooks";

/** Flows → PL: monthly market P/L of the buckets (brokerage / retiro / efectivo / inmuebles) — the flows overview's P/L. */
export function FlowsPlPage() {
  const { t } = useTranslation();
  const { displayUnit } = useDisplayPreferences();
  const chartPrefs = useSurfacePrefs("flows.pl.chart", "month", "3y");
  const metricsPeriod = chartPrefs.period;
  const timeRange = chartPrefs.range;
  const chartControls = (
    <SurfaceControls
      period={chartPrefs.period}
      onPeriodChange={chartPrefs.setPeriod}
      range={chartPrefs.range}
      onRangeChange={chartPrefs.setRange}
    />
  );
  const chartGranularity = metricsPeriod;
  // The period list owns its período (month/year) and always covers full history.
  const tablePrefs = useSurfacePrefs("flows.pl.table", "month", "total");
  const tableGranularity = flowTableGranularity(
    tablePrefs.period
  );
  const isDaily = chartGranularity === "day";
  // Day mode fetches the server-windowed per-day P/L; M/Y keep the days-less payload.
  // Held across a unit or Diario window change: dimmed, and formatted in its own `unit`.
  const pl = useHeldFlowsPl(displayUnit, isDaily ? timeRangeToDays(timeRange) : undefined);
  const { data, error } = pl;
  const err = error instanceof Error ? error.message : error ? t("common.loadFailed") : null;
  const loading = pl.loading;
  const unit = data?.unit ?? displayUnit;

  const chartPoints = useMemo(() => {
    if (!data) return [];
    if (chartGranularity === "day") {
      // Server already windows the daily series to `days`; no client clip.
      return data.chart_daily ?? [];
    }
    // Months cut at the Rango start, then rolled up: the yearly chart starts with a partial
    // first year.
    return clipMonthsThenRollup(
      data.chart_monthly,
      chartGranularity,
      timeRange,
      rollupFlowsPlChartPointsByYear
    );
  }, [chartGranularity, data, timeRange]);

  if (err) {
    return <p className="error">{err}</p>;
  }

  return (
    <>
      <h2 className="flow-section-title">{t("flows.pl.title")}</h2>

      <div className="chart-grid chart-grid--full-line chart-grid--full-width-stack">
        <FlowsPlChart
          controls={chartControls}
          title={t("flows.pl.chartTitle")}
          points={chartPoints}
          xAxisGranularity={chartGranularity}
          displayUnit={unit}
          loading={loading}
        />
      </div>

      <PageGridTile id="detail">
        <div className="chart-panel-title-row">
          <h3>{t(tableGranularity === "year" ? "flows.pl.sectionYearly" : "flows.pl.sectionMonthly")}</h3>
          <SurfaceControls
            period={tablePrefs.period}
            onPeriodChange={tablePrefs.setPeriod}
            periodOptions={["month", "year"]}
          />
        </div>
        {/* Keyed by grain: the open rows and the page are the month view's or the year view's. */}
        <FlowsPlPeriodList
          key={tableGranularity}
          months={data?.chart_monthly ?? null}
          granularity={tableGranularity}
          displayUnit={unit}
          loading={loading}
        />
      </PageGridTile>

      <PageGridTile id="breakdown" className="page-grid">
        <h3>
          {t("flows.pl.breakdownTitle")}
        </h3>
        {(data?.by_bucket ?? []).map((block) => (
          <PageGridTile key={block.slug} id={`pl-${block.slug}`}>
            <h4>
              {flowsPlBucketLabel(block.slug)}
              <span className={loadableClass(loading, "muted mono")} style={{ fontSize: "var(--font-size-prose)", marginLeft: "0.5rem" }}>
                {formatFlowMoney(block.total_cumulative, unit)}
              </span>
            </h4>
            <FlowsPlAccountRows block={block} displayUnit={unit} loading={loading} />
          </PageGridTile>
        ))}
      </PageGridTile>
    </>
  );
}
