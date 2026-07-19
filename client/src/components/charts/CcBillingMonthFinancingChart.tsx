import { useMemo } from "react";
import { Area, Bar, CartesianGrid, Legend, XAxis, YAxis } from "recharts";
import { useTranslation } from "../../i18n";
import type { CcBillingMonthChartPoint } from "../../types";
import { rollupCcBillingMonthChartYearly } from "../../ccYearlyRollup";
import { useDisplayPreferences } from "../../context/DisplayPreferencesContext";
import { AppComposedChart } from "./AppComposedChart";
import {
  buildNiceYAxis,
  CHART_TICK_STYLE,
  formatAxisValue,
  rechartsMoneyYAxisWidth,
  AXIS_LINE_STROKE as AXIS_STROKE,
  type ChartDisplayUnit,
} from "./chartLayout";

const CHART_ANIM_MS = 90;
const FACTURADO_CLP_FILL = "#d97706";
const FACTURADO_USD_CLP_FILL = "#fbbf24";
const FINANCING_COST_FILL = "#38bdf8";
const YTD_AREA_FILL = "rgba(148, 163, 184, 0.22)";
const YTD_AREA_STROKE = "#64748b";

function formatYmEs(ym: string): string {
  const [ys, ms] = ym.split("-");
  const m = Number(ms);
  const names = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
  const label = m >= 1 && m <= 12 ? names[m - 1] : ym;
  return `${label} ${ys?.slice(2) ?? ys}`;
}

function minMaxForKeys(points: CcBillingMonthChartPoint[], keys: (keyof CcBillingMonthChartPoint)[]) {
  let minV = 0;
  let maxV = 0;
  for (const row of points) {
    for (const k of keys) {
      const v = row[k];
      if (typeof v === "number" && Number.isFinite(v)) {
        minV = Math.min(minV, v);
        maxV = Math.max(maxV, v);
      }
    }
  }
  return { min: minV, max: Math.max(maxV, 1) };
}

export function CcBillingMonthFinancingChart({
  title,
  titleAs = "h3",
  points,
  displayUnit,
}: {
  title: string;
  titleAs?: "h2" | "h3";
  points: CcBillingMonthChartPoint[];
  displayUnit: ChartDisplayUnit;
}) {
  const { t } = useTranslation();
  const { metricsPeriod } = useDisplayPreferences();
  const isYearly = metricsPeriod === "year";
  const TitleTag = titleAs;
  const periodLabel = (ym: string) => (isYearly ? ym.slice(0, 4) : formatYmEs(ym));

  const plotPoints = useMemo(() => {
    const displayPoints = isYearly ? rollupCcBillingMonthChartYearly(points) : points;
    return displayPoints.map((p) => ({
      ...p,
      facturado_clp: p.facturado_clp ?? 0,
      facturado_usd_clp: p.facturado_usd_clp ?? 0,
      financing_cost_clp: p.financing_cost_clp ?? 0,
      ytd_financing_cost_clp: p.ytd_financing_cost_clp ?? null,
    }));
  }, [points, isYearly]);

  const yScale = useMemo(() => {
    const { min, max } = minMaxForKeys(plotPoints, [
      "facturado_clp",
      "facturado_usd_clp",
      "financing_cost_clp",
      "ytd_financing_cost_clp",
    ]);
    return buildNiceYAxis(min, max);
  }, [plotPoints]);

  if (points.length === 0) {
    return (
      <div className="chart-grid__col">
        <TitleTag className="chart-panel-title">{title}</TitleTag>
        <p className="empty muted">{t("accountDetail.creditCard.financingChartEmpty")}</p>
      </div>
    );
  }

  return (
    <div className="chart-grid__col">
      <TitleTag className="chart-panel-title">{title}</TitleTag>
      <div className="chart-box line-chart-focus-wrap">
        <AppComposedChart
          data={plotPoints}
          tooltip={{
            formatValue: (v) => formatAxisValue(v, displayUnit),
            formatLabel: (l) => periodLabel(String(l)),
            mapPayload: (payload) =>
              payload.filter((e) => typeof e.value === "number" && Number.isFinite(e.value)),
            footer: (
              <div style={{ marginTop: 6, fontSize: 11, color: "var(--muted, #94a3b8)" }}>
                {t("accountDetail.creditCard.financingChartTooltipHint")}
              </div>
            ),
            cursor: true,
          }}
        >
            <CartesianGrid strokeDasharray="3 3" stroke="#334155" opacity={0.35} />
            <XAxis
              dataKey="billing_month"
              type="category"
              tick={CHART_TICK_STYLE}
              axisLine={{ stroke: AXIS_STROKE }}
              tickLine={{ stroke: AXIS_STROKE }}
              tickFormatter={(ym: string) => periodLabel(String(ym))}
              interval="preserveStartEnd"
            />
            <YAxis
              domain={yScale.domain}
              ticks={yScale.ticks}
              width={rechartsMoneyYAxisWidth(displayUnit)}
              tick={CHART_TICK_STYLE}
              axisLine={{ stroke: AXIS_STROKE }}
              tickLine={{ stroke: AXIS_STROKE }}
              tickFormatter={(v: number) => formatAxisValue(v, displayUnit)}
            />
            <Legend
              wrapperStyle={{ fontSize: 12, color: "var(--muted, #94a3b8)", paddingTop: 8 }}
              formatter={(value) => <span style={{ color: "var(--muted, #94a3b8)" }}>{value}</span>}
            />
            {!isYearly ? (
              <Area
                type="monotone"
                dataKey="ytd_financing_cost_clp"
                name={t("accountDetail.creditCard.chartFinancingYtd")}
                stroke={YTD_AREA_STROKE}
                fill={YTD_AREA_FILL}
                fillOpacity={1}
                strokeWidth={1.2}
                connectNulls
                legendType="rect"
                isAnimationActive
                animationDuration={CHART_ANIM_MS}
              />
            ) : null}
            <Bar
              dataKey="facturado_clp"
              name={t("accountDetail.creditCard.chartFacturadoClp")}
              fill={FACTURADO_CLP_FILL}
              stackId="facturado"
              isAnimationActive
              animationDuration={CHART_ANIM_MS}
              maxBarSize={28}
            />
            <Bar
              dataKey="facturado_usd_clp"
              name={t("accountDetail.creditCard.chartFacturadoUsdClp")}
              fill={FACTURADO_USD_CLP_FILL}
              stackId="facturado"
              isAnimationActive
              animationDuration={CHART_ANIM_MS}
              maxBarSize={28}
            />
            <Bar
              dataKey="financing_cost_clp"
              name={t("accountDetail.creditCard.chartFinancingCost")}
              fill={FINANCING_COST_FILL}
              isAnimationActive
              animationDuration={CHART_ANIM_MS}
              maxBarSize={28}
            />
        </AppComposedChart>
      </div>
    </div>
  );
}
