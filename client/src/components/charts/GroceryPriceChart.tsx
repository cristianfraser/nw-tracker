import { CartesianGrid, Line, XAxis, YAxis } from "recharts";
import { AppLineChart } from "./AppLineChart";

/** A product's price per purchase day (the groceries page), on the axis the page built. */
export function GroceryPriceChart({
  data,
  yScale,
  formatPrice,
}: {
  data: readonly { date: string; price: number | null }[];
  yScale: { domain: [number, number]; ticks: number[] };
  formatPrice: (v: number) => string;
}) {
  return (
    <AppLineChart
      data={[...data]}
      tooltip={{
        formatValue: (v) => formatPrice(Number(v)),
        formatLabel: (l) => String(l),
      }}
    >
      <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
      <XAxis dataKey="date" tick={{ fill: "var(--muted)", fontSize: 10 }} minTickGap={24} />
      <YAxis
        tick={{ fill: "var(--muted)", fontSize: 10 }}
        width={52}
        tickFormatter={(v: number) => formatPrice(v)}
        domain={yScale.domain}
        ticks={yScale.ticks}
      />
      <Line type="monotone" dataKey="price" stroke="var(--accent, #2f81f7)" strokeWidth={2} dot />
    </AppLineChart>
  );
}
