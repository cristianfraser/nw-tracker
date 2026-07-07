import { CartesianGrid, Line, XAxis, YAxis } from "recharts";
import { AppLineChart } from "./AppLineChart";

export type RatesLineSeries = {
  dataKey: string;
  /** Tooltip row label; defaults to the dataKey. */
  name?: string;
  stroke: string;
  strokeWidth?: number;
  strokeDasharray?: string;
  dot?: boolean | { r: number };
};

const RATES_TICK_STYLE = { fill: "var(--muted)", fontSize: 10 } as const;

/** Daily-rate line chart used by the Rates page cards (FX dual chart and single-series minis). */
export function RatesLineChart({
  data,
  tailClippedKeys,
  series,
  yAxisWidth,
  yBand,
  formatValue,
}: {
  data: Record<string, string | number | null>[];
  tailClippedKeys?: ReadonlySet<string> | readonly string[] | null;
  series: readonly RatesLineSeries[];
  yAxisWidth: number;
  yBand: { domain: [number, number]; ticks: number[] } | null;
  /** Y-axis ticks and tooltip values. */
  formatValue: (n: number) => string;
}) {
  return (
    <AppLineChart
      data={data}
      tailClippedKeys={tailClippedKeys}
      tooltip={{ formatValue: (v) => formatValue(v) }}
    >
      <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
      <XAxis dataKey="date" tick={RATES_TICK_STYLE} tickMargin={4} minTickGap={32} />
      <YAxis
        tick={RATES_TICK_STYLE}
        tickFormatter={(v) => formatValue(Number(v))}
        width={yAxisWidth}
        domain={yBand ? yBand.domain : ["auto", "auto"]}
        ticks={yBand ? yBand.ticks : undefined}
      />
      {series.map((s) => (
        <Line
          key={s.dataKey}
          type="monotone"
          dataKey={s.dataKey}
          name={s.name ?? s.dataKey}
          stroke={s.stroke}
          dot={s.dot ?? false}
          strokeWidth={s.strokeWidth ?? 2}
          strokeDasharray={s.strokeDasharray}
        />
      ))}
    </AppLineChart>
  );
}
