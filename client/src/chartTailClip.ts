/**
 * Hide values outside the plot Y domain (set to `null`) so lines do not render above/below the axis.
 * Use with `YAxis allowDataOverflow={false}` and `type="linear"` to avoid monotone overshoot between points.
 */
export function clipChartDataToYDomain(
  rows: readonly Record<string, string | number | null>[],
  dataKeys: readonly string[],
  domain: readonly [number, number]
): Record<string, string | number | null>[] {
  const [y0, y1] = domain;
  const keySet = new Set(dataKeys);
  return rows.map((row) => {
    const next = { ...row };
    for (const k of keySet) {
      const v = next[k];
      if (typeof v === "number" && Number.isFinite(v)) {
        if (v > y1 || v < y0) next[k] = null;
      }
    }
    return next;
  });
}
