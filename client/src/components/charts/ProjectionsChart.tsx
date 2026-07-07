import { CartesianGrid, Legend, Line, XAxis, YAxis } from "recharts";
import { AppLineChart } from "./AppLineChart";
import { rechartsMoneyYAxisWidth, type ChartDisplayUnit } from "./chartLayout";
import { formatCurrency } from "../../format";

export type ProjectionChartLine = {
  dataKey: string;
  name: string;
  valueSeriesType?: string | null;
};

const LINE_STYLE: Record<string, { stroke: string; width: number }> = {
  total_nw: { stroke: "var(--accent)", width: 2 },
  invested: { stroke: "#8b5cf6", width: 1.5 },
  proj_nw: { stroke: "#22c55e", width: 2 },
  proj_invested: { stroke: "#8b5cf6", width: 2 },
  proj_nw_nominal: { stroke: "#166534", width: 1 },
  proj_swr: { stroke: "#eab308", width: 1.5 },
  proj_pct_balance: { stroke: "#f97316", width: 1.5 },
  proj_fixed_income: { stroke: "#ec4899", width: 1.5 },
};

const PROJECTIONS_TICK_STYLE = { fill: "var(--muted)", fontSize: 10 } as const;

/** Accumulation + drawdown trajectory chart for /projections (named strategies + USD milestone refs). */
export function ProjectionsChart({
  points,
  namedLines,
  milestoneLines,
  displayUnit,
}: {
  points: Record<string, string | number | null>[];
  namedLines: readonly ProjectionChartLine[];
  /** Constant USD milestone reference series; drawn thin, dashed, and unlabeled. */
  milestoneLines: readonly ProjectionChartLine[];
  displayUnit: ChartDisplayUnit;
}) {
  return (
    <AppLineChart
      data={points}
      tooltip={{
        formatValue: (v) => formatCurrency(v, displayUnit),
        formatLabel: (l) => String(l).slice(0, 7),
      }}
    >
      <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
      <XAxis
        dataKey="as_of_date"
        tick={PROJECTIONS_TICK_STYLE}
        tickFormatter={(d) => String(d).slice(0, 4)}
        minTickGap={40}
      />
      <YAxis
        tick={PROJECTIONS_TICK_STYLE}
        tickFormatter={(v) => formatCurrency(Number(v), displayUnit)}
        width={rechartsMoneyYAxisWidth(displayUnit)}
      />
      <Legend />
      {namedLines.map((l) => {
        const style = LINE_STYLE[l.dataKey] ?? { stroke: "var(--muted)", width: 1 };
        return (
          <Line
            key={l.dataKey}
            type="monotone"
            dataKey={l.dataKey}
            name={l.name}
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
          name={l.name}
          stroke="#64748b"
          strokeWidth={0.75}
          strokeDasharray="2 6"
          dot={false}
          legendType="none"
        />
      ))}
    </AppLineChart>
  );
}
