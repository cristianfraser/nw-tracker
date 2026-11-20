/**
 * Only the loaded bundle can say the group has no P/L; a placeholder keeps the combos' frames.
 * A Diario combo with no points is its daily series still loading (or a window without days),
 * never «no P/L»: it stays mounted with its controls.
 */
export function groupPerfAbsent(opts: {
  loading: boolean;
  barSeriesCount: number;
  granularity: "day" | "month" | "year";
  pointsCount: number;
}): boolean {
  return !opts.loading && (opts.barSeriesCount === 0 || (opts.granularity !== "day" && opts.pointsCount === 0));
}

