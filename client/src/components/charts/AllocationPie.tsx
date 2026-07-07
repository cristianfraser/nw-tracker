import { Cell, Legend, Pie } from "recharts";
import { AppPieChart } from "./AppPieChart";
import { CHART_ANIM_MS } from "./chartLayout";

/**
 * Allocation pie (slice value labels + legend + docked tooltip) rendered inside a `.chart-box`.
 * Shared by `AllocationPiePanel` (group pages) and the dashboard allocation section.
 */
export function AllocationPie<S extends { name: string; value: number }>({
  slices,
  fill,
  formatValue,
  animationActive = true,
  animationDuration = CHART_ANIM_MS,
}: {
  slices: readonly S[];
  fill: (slice: S, index: number) => string;
  /** Slice labels and tooltip values (e.g. `formatMoneyForPie` closed over the display unit). */
  formatValue: (v: number) => string;
  animationActive?: boolean;
  animationDuration?: number;
}) {
  return (
    <AppPieChart tooltip={{ formatValue: (v) => formatValue(v) }}>
      {/* Recharts Pie default animationBegin is 400ms; Line uses 0 — set begin 0 so pie and lines start together. */}
      <Pie
        data={slices as S[]}
        dataKey="value"
        nameKey="name"
        cx="50%"
        cy="50%"
        outerRadius={100}
        label={(p: { value?: unknown }) => {
          const v = typeof p.value === "number" ? p.value : Number(p.value);
          return formatValue(Number.isFinite(v) ? v : 0);
        }}
        isAnimationActive={animationActive}
        animationBegin={0}
        animationDuration={animationDuration}
        animationEasing="ease-out"
      >
        {slices.map((slice, i) => (
          <Cell key={i} fill={fill(slice, i)} />
        ))}
      </Pie>
      <Legend formatter={(value) => String(value ?? "")} />
    </AppPieChart>
  );
}
