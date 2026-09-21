/**
 * Placement rule for the ATH (all-time high) marker on a value line chart. Pure — the
 * Recharts element itself is built by `AthMarker.tsx`.
 *
 * The server hands one peak per grain, each dated at a row of that grain's own series (a
 * calendar day for Diario, a month's latest row for Mensual, a year's for Anual); the chart
 * grid keys those rows by day, month or year (the yearly rollup re-dates its rows to Dec 31),
 * so the marker resolves by the matching prefix and lands on a plotted point.
 */
export type ChartGranularity = "month" | "year" | "day";

function bucketKey(ymd: string, granularity: ChartGranularity): string {
  return granularity === "day" ? ymd : granularity === "month" ? ymd.slice(0, 7) : ymd.slice(0, 4);
}

/** The plotted row carrying `ymd` at this granularity, or null when the window does not include it. */
export function resolveAthMarkerRow(
  points: readonly Record<string, string | number | null>[],
  ymd: string,
  granularity: ChartGranularity
): { x: string; index: number } | null {
  const want = bucketKey(ymd, granularity);
  for (let i = 0; i < points.length; i++) {
    const d = String(points[i]!.as_of_date ?? "");
    if (d && bucketKey(d, granularity) === want) return { x: d, index: i };
  }
  return null;
}
