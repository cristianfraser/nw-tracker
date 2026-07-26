/**
 * Proportional ("composition") share series — the timeseries replacement for the old
 * allocation pies. At each date the base is Σ max(value, 0) over the member series:
 * negative members are floored to 0 (composition-of-assets framing — the true negative
 * stays visible on the valuation chart; e.g. CC-netted cash 2019-12), null/missing
 * members contribute 0, and a date whose base is 0 emits null for every series (the
 * chart skips it). Shares are 0..1 and sum to 1 (±fp) wherever the base is positive.
 * Built server-side: the client renders shares, it never re-aggregates member series.
 */

export type ProportionalSeriesLineMeta = {
  dataKey: string;
  name: string;
  name_i18n_key?: string | null;
  color_rgb?: string | null;
  /** Member identity for client color maps (same key the old pie sliceFill used). */
  account_id?: number;
};

export type ProportionalSeriesBlock = {
  dates: string[];
  series: (ProportionalSeriesLineMeta & { values: (number | null)[] })[];
};

function contribution(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0;
}

/** Shares from chart-block points (`points[i][dataKey]`), e.g. the monthly valuation blocks. */
export function buildProportionalFromPoints(
  points: readonly Record<string, string | number | null>[],
  lines: readonly ProportionalSeriesLineMeta[]
): ProportionalSeriesBlock {
  const dates = points.map((p) => String(p.as_of_date ?? ""));
  const values: (number | null)[][] = lines.map(() => new Array(points.length).fill(null));
  for (let i = 0; i < points.length; i++) {
    const row = points[i]!;
    let base = 0;
    for (const line of lines) base += contribution(row[line.dataKey]);
    if (base <= 0) continue;
    for (let s = 0; s < lines.length; s++) {
      values[s]![i] = contribution(row[lines[s]!.dataKey]) / base;
    }
  }
  return {
    dates,
    series: lines.map((line, s) => ({ ...line, values: values[s]! })),
  };
}

/** Shares from parallel per-series value arrays on a shared date grid (daily payloads). */
export function buildProportionalFromValueArrays(
  dates: readonly string[],
  lines: readonly (ProportionalSeriesLineMeta & { values: readonly (number | null)[] })[]
): ProportionalSeriesBlock {
  const values: (number | null)[][] = lines.map(() => new Array(dates.length).fill(null));
  for (let i = 0; i < dates.length; i++) {
    let base = 0;
    for (const line of lines) base += contribution(line.values[i]);
    if (base <= 0) continue;
    for (let s = 0; s < lines.length; s++) {
      values[s]![i] = contribution(lines[s]!.values[i]) / base;
    }
  }
  return {
    dates: [...dates],
    series: lines.map((line, s) => ({
      dataKey: line.dataKey,
      name: line.name,
      ...(line.name_i18n_key != null ? { name_i18n_key: line.name_i18n_key } : {}),
      ...(line.color_rgb != null ? { color_rgb: line.color_rgb } : {}),
      ...(line.account_id != null ? { account_id: line.account_id } : {}),
      values: values[s]!,
    })),
  };
}
