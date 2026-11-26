import { CartesianGrid, Line, XAxis, YAxis } from "recharts";
import { AppLineChart } from "./AppLineChart";
import { ChartEmptyState } from "./ChartEmptyState";
import { ChartPanelTitleRow } from "./ChartPanelTitleRow";
import { moneyYAxisProps, type ChartDisplayUnit } from "./chartLayout";
import { cn } from "../../cn";
import { formatCompactMoney, formatCurrency, formatGroupedDecimalTrimmed } from "../../format";
import { formatYearMonthLabel } from "../../formatDateLabel";
import { useTranslation } from "../../i18n";
import { useIsNarrowViewport } from "../../useIsNarrowViewport";
import { loadableClass } from "../ui/Loadable";
import type { ProjectionsChartLine } from "../../types";
import legendStyles from "./ValuationLineCharts.module.css";
import styles from "./ProjectionsChart.module.css";

/** Each named line's colour and width; a strategy's rail row draws its swatch from here (`projectionLineStyle`). */
const PROJECTION_LINE_STYLE: Record<string, { stroke: string; width: number }> = {
  total_nw: { stroke: "var(--accent)", width: 2 },
  invested: { stroke: "#8b5cf6", width: 1.5 },
  proj_nw: { stroke: "#22c55e", width: 2 },
  proj_invested: { stroke: "#8b5cf6", width: 2 },
  proj_nw_nominal: { stroke: "#166534", width: 1 },
  proj_swr: { stroke: "#eab308", width: 1.5 },
  proj_pct_balance: { stroke: "#f97316", width: 1.5 },
  proj_fixed_income: { stroke: "#ec4899", width: 1.5 },
};

const MILESTONE_STROKE = "#64748b";

const PROJECTIONS_TICK_STYLE = { fill: "var(--muted)", fontSize: 10 } as const;

/** A named line's colour and width; an unknown line throws. */
export function projectionLineStyle(dataKey: string): { stroke: string; width: number } {
  const style = PROJECTION_LINE_STYLE[dataKey];
  if (!style) throw new Error(`projections chart: no style for line ${dataKey}`);
  return style;
}

/**
 * The /projections chart: history, the accumulation to retirement and the three drawdown
 * strategies, over constant USD reference levels (thin, dotted). Its legend is HTML under the
 * plot and names the lines the rail does not: the strategies are named by their rail rows.
 */
export function ProjectionsChart({
  title,
  points,
  lines,
  strategyLineKeys,
  displayUnit,
  inflationPct,
  loading,
}: {
  title: string;
  points: Record<string, string | number | null>[];
  lines: readonly ProjectionsChartLine[];
  /** The lines the rail names (left out of the legend). */
  strategyLineKeys: readonly string[];
  displayUnit: ChartDisplayUnit;
  /** The unit's inflation input, named beside the nominal line. */
  inflationPct: number | undefined;
  loading?: boolean;
}) {
  const { t } = useTranslation();
  const compactAxis = useIsNarrowViewport();
  const namedLines = lines.filter((l) => l.milestone == null);
  const milestoneLines = lines.flatMap((l) => (l.milestone ? [{ dataKey: l.dataKey, level: l.milestone }] : []));
  const lineName = (dataKey: string): string =>
    dataKey === "proj_nw_nominal"
      ? t("projections.lines.proj_nw_nominal", {
          code: displayUnit.toUpperCase(),
          pct: inflationPct != null ? formatGroupedDecimalTrimmed(inflationPct) : "—",
        })
      : t(`projections.lines.${dataKey}`);
  const levels = milestoneLines.map((l) => l.level.value);
  const levelCurrency = milestoneLines[0]?.level.currency;
  if (points.length === 0) {
    return (
      <div className="chart-grid__col">
        <ChartPanelTitleRow title={title} titleAs="h2" />
        <ChartEmptyState loading={loading} message={t("projections.noChartData")} />
      </div>
    );
  }
  return (
    <div className="chart-grid__col">
      <ChartPanelTitleRow title={title} titleAs="h2" />
      <div className={loadableClass(loading, "chart-box")}>
        <AppLineChart
          data={points}
          tooltip={{
            formatValue: (v) => formatCurrency(v, displayUnit),
            formatLabel: (l) => formatYearMonthLabel(String(l)),
          }}
        >
          <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
          <XAxis
            dataKey="as_of_date"
            tick={PROJECTIONS_TICK_STYLE}
            tickFormatter={(d) => String(d).slice(0, 4)}
            minTickGap={40}
          />
          {/* Recharts picks these ticks, so the gutter is measured from the rendered labels. */}
          <YAxis {...moneyYAxisProps(displayUnit, compactAxis)} />
          {namedLines.map((l) => {
            const style = projectionLineStyle(l.dataKey);
            return (
              <Line
                key={l.dataKey}
                type="monotone"
                dataKey={l.dataKey}
                name={lineName(l.dataKey)}
                stroke={style.stroke}
                strokeWidth={style.width}
                strokeDasharray={l.valueSeriesType === "reference" ? "6 4" : undefined}
                dot={false}
              />
            );
          })}
          {milestoneLines.map((l) => (
            <Line
              key={l.dataKey}
              type="monotone"
              dataKey={l.dataKey}
              name={formatCompactMoney(l.level.value, l.level.currency)}
              stroke={MILESTONE_STROKE}
              strokeWidth={0.75}
              strokeDasharray="2 6"
              dot={false}
            />
          ))}
        </AppLineChart>
      </div>
      <ul className={cn("line-chart-legend", legendStyles.legend, styles.legend)}>
        {namedLines
          .filter((l) => !strategyLineKeys.includes(l.dataKey))
          .map((l) => (
            <LegendItem
              key={l.dataKey}
              stroke={projectionLineStyle(l.dataKey).stroke}
              dash={l.valueSeriesType === "reference" ? "6 4" : undefined}
              name={lineName(l.dataKey)}
            />
          ))}
        {levelCurrency != null ? (
          <LegendItem
            stroke={MILESTONE_STROKE}
            dash="2 4"
            name={t("projections.lines.milestones", {
              from: formatCompactMoney(Math.min(...levels), levelCurrency),
              to: formatCompactMoney(Math.max(...levels), levelCurrency),
            })}
          />
        ) : null}
      </ul>
    </div>
  );
}

function LegendItem({ stroke, dash, name }: { stroke: string; dash?: string; name: string }) {
  return (
    <li className={styles.legendItem}>
      <svg width={18} height={10} aria-hidden="true" className={legendStyles.legendSwatch}>
        <line x1={0} x2={18} y1={5} y2={5} stroke={stroke} strokeWidth={2} strokeDasharray={dash} />
      </svg>
      <span className={legendStyles.legendName}>{name}</span>
    </li>
  );
}
