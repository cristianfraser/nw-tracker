import { CartesianGrid, Line, XAxis, YAxis } from "recharts";
import { formatGroupedDecimal } from "../../format";
import { AppLineChart } from "./AppLineChart";

export type WealthPercentileChartLine = {
  dataKey: string;
  /** Already translated by the page, at render. */
  name: string;
  stroke: string;
  strokeWidth: number;
};

/**
 * The wealth-percentile lines by year, without a legend (the rail beside the chart names the lines). On the log scale the points are top-% distances (100 − p)
 * on a reversed log axis, so ticks and tooltip read back as percentiles.
 */
export function WealthPercentileChart({
  data,
  logAxis,
  lines,
}: {
  data: readonly Record<string, number | string | null>[];
  /** The reversed log axis of the top-% view; null draws the linear 0–100 axis. */
  logAxis: { domain: [number, number]; ticks: number[] } | null;
  lines: readonly WealthPercentileChartLine[];
}) {
  const log = logAxis != null;
  return (
    <AppLineChart
      data={[...data]}
      tooltip={{
        formatValue: (v) => formatGroupedDecimal(log ? 100 - Number(v) : Number(v), 1),
        formatLabel: (l) => String(l),
      }}
    >
      <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
      <XAxis dataKey="year" tick={{ fill: "var(--muted)", fontSize: 10 }} minTickGap={20} />
      {logAxis != null ? (
        <YAxis
          scale="log"
          reversed
          domain={logAxis.domain}
          ticks={logAxis.ticks}
          allowDataOverflow
          tickFormatter={(v: number) => {
            const p = 100 - v;
            return formatGroupedDecimal(p, Number.isInteger(p) ? 0 : 1);
          }}
          tick={{ fill: "var(--muted)", fontSize: 10 }}
          width={34}
        />
      ) : (
        <YAxis domain={[0, 100]} ticks={[0, 25, 50, 75, 100]} tick={{ fill: "var(--muted)", fontSize: 10 }} width={30} />
      )}
      {lines.map((l) => (
        <Line
          key={l.dataKey}
          type="monotone"
          dataKey={l.dataKey}
          name={l.name}
          stroke={l.stroke}
          strokeWidth={l.strokeWidth}
          dot={false}
        />
      ))}
    </AppLineChart>
  );
}
