import { useMemo } from "react";

/**
 * Rates-page-only trailing-zero clip on client-densified **daily** rate rows.
 * Valuation timeseries blocks arrive pre-clipped from the server
 * (`server/src/timeseriesTailClip.ts`) — do not reuse this for those.
 */
const TRAILING_ZERO_ROWS_KEPT = 1;

type Row = Record<string, string | number | null>;

function tailClipStartIndex(points: readonly Row[], dataKey: string): number | null {
  let lastNonZeroIdx = -1;
  for (let i = 0; i < points.length; i++) {
    const v = points[i]![dataKey];
    if (typeof v === "number" && Number.isFinite(v) && Math.abs(v) > 1e-9) {
      lastNonZeroIdx = i;
    }
  }
  const n = points.length;
  const trailingLen = lastNonZeroIdx >= 0 ? n - 1 - lastNonZeroIdx : n;
  if (trailingLen <= TRAILING_ZERO_ROWS_KEPT) return null;
  return lastNonZeroIdx + 1 + TRAILING_ZERO_ROWS_KEPT;
}

export function useDailyRateTailClip(
  points: Row[],
  dataKeys: readonly string[] | null
): { chartData: Row[]; tailClippedKeys: Set<string> } {
  return useMemo(() => {
    if (!dataKeys?.length || !points.length) {
      return { chartData: points, tailClippedKeys: new Set<string>() };
    }
    const tailClippedKeys = new Set<string>();
    const out = points.map((r) => ({ ...r }));
    for (const dk of dataKeys) {
      const start = tailClipStartIndex(out, dk);
      if (start == null) continue;
      for (let i = start; i < out.length; i++) out[i]![dk] = null;
      tailClippedKeys.add(dk);
    }
    return { chartData: out, tailClippedKeys };
  }, [points, dataKeys]);
}
