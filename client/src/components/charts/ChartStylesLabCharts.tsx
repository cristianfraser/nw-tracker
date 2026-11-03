import { useMemo } from "react";
import { Bar, CartesianGrid, Legend, Line, XAxis, YAxis } from "recharts";
import { AppComposedChart } from "./AppComposedChart";
import { AppLineChart } from "./AppLineChart";
import { ChartPanelTitleRow } from "./ChartPanelTitleRow";
import { AthScribbleSamples, renderAthMarker } from "./AthMarker";
import {
  AXIS_LINE_STROKE,
  CHART_ANIM_MS,
  CHART_TICK_STYLE,
  formatTooltipValue,
  moneyYAxisProps,
} from "./chartLayout";
import { useDisplayPreferences } from "../../context/DisplayPreferencesContext";
import { formatMonthYearShortLabel } from "../../formatDateLabel";
import { useTranslation } from "../../i18n";

/**
 * Rehearsal (2026-11-03): the two sample charts the chart-styles lab page (/panel/chart-styles)
 * renders under each style — a line chart like the valuation panels and a bars + line combo
 * like the monthly P/L one. Fixed synthetic data (a seeded walk), no server call.
 */

type Row = Record<string, string | number | null>;

/** Deterministic pseudo-random walk so every style draws the same figure. */
function seeded(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
}

function sampleRows(): { line: Row[]; combo: Row[] } {
  const rnd = seeded(7);
  const line: Row[] = [];
  const combo: Row[] = [];
  let brokerage = 18_000_000;
  let retirement = 24_000_000;
  let cash = 5_000_000;
  let ytd = 0;
  for (let i = 0; i < 36; i++) {
    const year = 2024 + Math.floor(i / 12);
    const month = (i % 12) + 1;
    const date = `${year}-${String(month).padStart(2, "0")}-28`;
    const plB = Math.round((rnd() - 0.42) * 2_400_000);
    const plR = Math.round((rnd() - 0.4) * 1_400_000);
    const deposit = Math.round(400_000 + rnd() * 900_000);
    brokerage += plB + deposit * 0.6;
    retirement += plR + deposit * 0.4;
    cash = Math.round(cash + (rnd() - 0.5) * 2_000_000);
    const pl = plB + plR;
    if (month === 1) ytd = 0;
    ytd += pl;
    line.push({
      as_of_date: date,
      total: Math.round(brokerage + retirement + cash),
      brokerage: Math.round(brokerage),
      retirement: Math.round(retirement),
      cash,
    });
    if (i >= 18) combo.push({ as_of_date: date, pl, deposits: deposit, ytd });
  }
  return { line, combo };
}

const LINE_SERIES: { key: string; color: string; width: number }[] = [
  { key: "total", color: "#e8edf4", width: 2 },
  { key: "brokerage", color: "#3d9cf9", width: 1.5 },
  { key: "retirement", color: "#f4a261", width: 1.5 },
  { key: "cash", color: "#2ec4b6", width: 1.5 },
];

export function ChartStylesLabCharts() {
  const rows = useMemo(() => sampleRows(), []);
  const { t } = useTranslation();
  const { displayUnit } = useDisplayPreferences();
  const unit = displayUnit;
  const tickDate = (v: string) => formatMonthYearShortLabel(v);
  // The Total line's all-time high, marked as the dashboard marks net worth's.
  const peak = rows.line.reduce<Row | null>(
    (best, r) => (best == null || Number(r.total) > Number(best.total) ? r : best),
    null
  );
  return (
    <>
      <ChartPanelTitleRow title={t("chartStylesLab.lineTitle")} titleAs="h3" />
      <div className="chart-box" style={{ height: 260, minHeight: 0 }}>
        <AppLineChart
          data={rows.line}
          tooltip={{
            formatLabel: (label) => tickDate(String(label)),
            formatValue: (v) => formatTooltipValue(v, unit),
          }}
        >
          <CartesianGrid strokeDasharray="3 3" stroke="#334155" opacity={0.35} />
          <XAxis
            dataKey="as_of_date"
            tick={CHART_TICK_STYLE}
            axisLine={{ stroke: AXIS_LINE_STROKE }}
            tickLine={{ stroke: AXIS_LINE_STROKE }}
            tickFormatter={tickDate}
            interval={5}
          />
          <YAxis {...moneyYAxisProps(unit, true)} />
          <Legend
            wrapperStyle={{ fontSize: 12, color: "var(--muted, #94a3b8)", paddingTop: 8 }}
            formatter={(value) => <span style={{ color: "var(--muted, #94a3b8)" }}>{value}</span>}
          />
          {peak ? renderAthMarker({ x: String(peak.as_of_date), y: Number(peak.total), opacity: 1 }) : null}
          {LINE_SERIES.map((s) => (
            <Line
              key={s.key}
              type="monotone"
              dataKey={s.key}
              name={t(`chartStylesLab.series.${s.key}`)}
              stroke={s.color}
              strokeWidth={s.width}
              dot={false}
              isAnimationActive={false}
              legendType="plainline"
            />
          ))}
        </AppLineChart>
      </div>
      <ChartPanelTitleRow title={t("chartStylesLab.comboTitle")} titleAs="h3" />
      <div className="chart-box" style={{ height: 260, minHeight: 0 }}>
        <AppComposedChart
          data={rows.combo}
          stackOffset="sign"
          tooltip={{
            formatLabel: (label) => tickDate(String(label)),
            formatValue: (v) => formatTooltipValue(v, unit),
          }}
        >
          <XAxis
            dataKey="as_of_date"
            type="category"
            tick={CHART_TICK_STYLE}
            axisLine={{ stroke: AXIS_LINE_STROKE }}
            tickLine={{ stroke: AXIS_LINE_STROKE }}
            tickFormatter={tickDate}
            interval={2}
          />
          <YAxis {...moneyYAxisProps(unit, true)} />
          <Legend
            wrapperStyle={{ fontSize: 12, color: "var(--muted, #94a3b8)", paddingTop: 8 }}
            formatter={(value) => <span style={{ color: "var(--muted, #94a3b8)" }}>{value}</span>}
          />
          <Bar
            dataKey="pl"
            name={t("chartStylesLab.series.pl")}
            fill="#3d9cf9"
            isAnimationActive
            animationDuration={CHART_ANIM_MS}
            maxBarSize={28}
          />
          <Bar
            dataKey="deposits"
            name={t("chartStylesLab.series.deposits")}
            fill="#5a6f88"
            isAnimationActive
            animationDuration={CHART_ANIM_MS}
            maxBarSize={28}
          />
          <Line
            type="monotone"
            dataKey="ytd"
            name={t("chartStylesLab.series.ytd")}
            stroke="#f4a261"
            strokeWidth={2}
            dot={false}
            isAnimationActive={false}
          />
        </AppComposedChart>
      </div>
      <h3 className="chart-panel-title">ATH</h3>
      <AthScribbleSamples />
    </>
  );
}

