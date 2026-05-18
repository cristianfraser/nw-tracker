import type { TimeseriesBlock, ValueSeriesType } from "./types";

export type TailClipSeriesEntry = {
  dataKey: string;
  type: ValueSeriesType;
};

/** Build tail-clip metadata from series definitions on the block (no dataKey heuristics). */
export function collectTailClipSeriesFromBlock(
  block: TimeseriesBlock,
  includeAccumulatedLines: boolean
): TailClipSeriesEntry[] {
  const entries: TailClipSeriesEntry[] = [];
  for (const a of block.accounts ?? []) {
    const valType = a.valueSeriesType;
    entries.push({ dataKey: a.dataKey, type: valType });
    if (includeAccumulatedLines && a.depositDataKey) {
      entries.push({ dataKey: a.depositDataKey, type: valType });
    }
    if (includeAccumulatedLines && a.displayDepositDataKey) {
      entries.push({ dataKey: a.displayDepositDataKey, type: valType });
    }
  }
  for (const ln of block.lines ?? []) {
    entries.push({ dataKey: ln.dataKey, type: ln.valueSeriesType });
  }
  return entries;
}

export function dataSeriesKeysFromTailClip(series: readonly TailClipSeriesEntry[]): string[] {
  return [...new Set(series.filter((s) => s.type === "data").map((s) => s.dataKey))];
}

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
