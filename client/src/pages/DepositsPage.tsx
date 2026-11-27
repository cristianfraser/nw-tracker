import { useMemo } from "react";
import { Link } from "react-router-dom";
import { useHeldFlowsDeposits } from "../queries/hooks";
import { PageGridTile } from "../components/layout/PageGridTile";
import { DepositsByCategoryChart } from "../components/charts/DepositsByCategoryChart";
import { DepositMonthList } from "../components/flows/DepositMonthList";
import { useDisplayPreferences } from "../context/DisplayPreferencesContext";
import { useSurfacePrefs } from "../surfaceDisplayPrefs";
import { SurfaceControls } from "../components/ui/SurfaceControls";
import { loadableClass } from "../components/ui/Loadable";
import { useTranslation, depositFlowCategoryLabel } from "../i18n";
import {
  formatFlowMoney,
  sumChartPointsField,
} from "../flowsDisplay";
import { clipMonthsThenRollup, clipPointsToTimeRange } from "../timeRange";
import { rollupDepositChartPointsByYear } from "../flowsDepositsAggregate";
import type { DepositFlowCategory } from "../types";

const CATEGORY_ORDER: DepositFlowCategory[] = ["real_estate", "cash", "brokerage", "inversiones"];

export function DepositsPage() {
  const { t } = useTranslation();
  const { displayUnit } = useDisplayPreferences();
  const chartPrefs = useSurfacePrefs("flows.deposits.chart", "month", "3y");
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
  // Held across a unit switch: dimmed, everything formatted in its own `unit`.
  const deposits = useHeldFlowsDeposits(displayUnit);
  const { data, error } = deposits;
  const err = error instanceof Error ? error.message : error ? t("common.loadFailed") : null;
  // The frame renders with a zero total and empty category tables until there is a payload to show.
  const loading = !data || deposits.loading;
  const unit = data?.unit ?? displayUnit;

  const chartPoints = useMemo(() => {
    if (!data) return [];
    if (chartGranularity === "day") {
      return clipPointsToTimeRange(data.chart_daily, timeRange);
    }
    // Months cut at the Rango start, then rolled up: the yearly chart starts with a partial
    // first year.
    return clipMonthsThenRollup(
      data.chart_monthly,
      chartGranularity,
      timeRange,
      rollupDepositChartPointsByYear
    );
  }, [chartGranularity, data, timeRange]);

  const total = data ? data.net_total : 0;
  /** The total's two parts: the accounts only payroll funds (AFP, AFC, 401(k), HSA) and every other account. */
  const postTaxTotal = data ? data.post_tax_total : 0;
  const preTaxTotal = data ? data.pre_tax_total : 0;

  /** "En el rango" companion: sum of the clipped chart points (matches the visible bars). */
  const rangeTotal = useMemo(
    () => sumChartPointsField(chartPoints, "total"),
    [chartPoints]
  );


  if (err) {
    return <p className="error">{err}</p>;
  }

  return (
    <>
      <h2 className="flow-section-title">{t("sidebar.flowsDeposits")}</h2>
      <p style={{ fontSize: "var(--font-size-prose)" }}>
        <Link to="reconciliation">{t("depositsReconciliation.title")}</Link>
      </p>

      <p className={loadableClass(loading, "muted")}>
        {t("deposits.totalLabel")}{" "}
        <span className="mono flow-summary-value">
          {formatFlowMoney(total, unit)}
        </span>
        <span className="muted flow-summary-note">
          ({t("deposits.partOther")}{" "}
          <span className="mono">{formatFlowMoney(postTaxTotal, unit)}</span>
          {" · "}
          {t("deposits.partPayrollFunded")}{" "}
          <span className="mono">{formatFlowMoney(preTaxTotal, unit)}</span>)
        </span>
        {timeRange !== "total" ? (
          <span className="muted flow-summary-note">
            · {t("flows.rangeTotalLabel")}{" "}
            <span className="mono">{formatFlowMoney(rangeTotal, unit)}</span>
          </span>
        ) : null}
      </p>

      <div className="chart-grid chart-grid--full-line chart-grid--full-width-stack">
        <DepositsByCategoryChart
          controls={chartControls}
          title={t("deposits.chartTitle")}
          points={chartPoints}
          xAxisGranularity={chartGranularity}
          displayUnit={unit}
          loading={loading}
        />
      </div>

      {CATEGORY_ORDER.map((cat) => {
        // Tables include full history (the chart's Rango only scopes the chart + its
        // companion total); the section subtotal is the server's.
        const block = data ? data.by_category[cat] : null;
        const blockTotal = block ? block.total : 0;
        return (
          <PageGridTile key={cat} id={`deposits-${cat}`}>
            <h3>
              {depositFlowCategoryLabel(cat)}
              <span className={loadableClass(loading, "muted mono")} style={{ fontSize: "var(--font-size-prose)", marginLeft: "0.5rem" }}>
                {formatFlowMoney(blockTotal, unit)}
              </span>
            </h3>
            <DepositMonthList block={block} displayUnit={unit} loading={loading} />
          </PageGridTile>
        );
      })}
    </>
  );
}
