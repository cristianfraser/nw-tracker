/**
 * Reversed-log y-axis for percentile lines: plot "distance from 100" (top X%) on a log scale so the
 * crowded 90–100 band gets most of the vertical space. A percentile p is drawn at `topPercentOf(p) = 100 − p`;
 * the axis is `scale="log" reversed` over `[floor, 100]`, so small top-% (high percentile) sits at the top.
 * Callers invert the tick/tooltip labels back to percentiles with `100 − v`.
 */

/** Smallest plottable top-%; a percentile of exactly 100 (top-% 0) is not log-plottable, so we clamp here. */
export const PERCENTILE_LOG_TOP_PCT_FLOOR = 0.1;

/** Log-spaced top-% ticks; each reads back as a clean percentile (50→p50, 10→p90, 1→p99, 0.5→p99.5). */
const TOP_PCT_TICK_CANDIDATES = [100, 50, 20, 10, 5, 2, 1, 0.5, 0.2, 0.1] as const;

/** Distance-from-100 ("top X%") for a percentile, clamped away from 0 so it is log-plottable. */
export function topPercentOf(percentile: number): number {
  return Math.min(100, Math.max(PERCENTILE_LOG_TOP_PCT_FLOOR, 100 - percentile));
}

/**
 * Domain + ticks for the reversed-log axis given the smallest top-% present in the data (the best percentile).
 * The domain floor snaps down to the nearest tick candidate ≤ `minTopPct` so the top point keeps headroom,
 * and only ticks within `[floor, 100]` are emitted.
 */
export function percentileLogAxisFor(minTopPct: number): { domain: [number, number]; ticks: number[] } {
  const clampedMin = Math.max(PERCENTILE_LOG_TOP_PCT_FLOOR, Number.isFinite(minTopPct) ? minTopPct : 100);
  let floor: number = PERCENTILE_LOG_TOP_PCT_FLOOR;
  for (const c of TOP_PCT_TICK_CANDIDATES) {
    if (c <= clampedMin) {
      floor = c;
      break;
    }
  }
  const ticks = TOP_PCT_TICK_CANDIDATES.filter((c) => c >= floor && c <= 100).sort((a, b) => a - b);
  return { domain: [floor, 100], ticks };
}
