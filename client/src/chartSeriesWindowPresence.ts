/**
 * Series presence inside the visible chart window.
 *
 * Legends are built from the payload's series metadata, but the plotted rows are clipped to the
 * surface's Rango (M/Y clip client-side, daily windowed server-side). A series that ended before
 * the window starts arrives all-null (tail clip) and draws nothing, yet still claimed a legend
 * entry and a dead tooltip row. These helpers answer "does this dataKey have anything plottable
 * in these rows?" so the chart components can drop it from the render entirely.
 *
 * This is filtering, not aggregation — the values stay exactly as the server built them.
 */

/**
 * Whether a zero counts as data follows the mark's geometry at 0:
 * - lines keep zeros (a flat 0 line, or a wind-down to 0, is drawn and meaningful);
 * - bars and stacked-area shares treat them as empty — a zero-height bar and a zero-width band
 *   draw nothing, and both builders emit 0 (not null) for members with no activity, so a sold-out
 *   account would otherwise keep a legend entry at every range forever.
 */
export function dataKeysWithWindowData(
  rows: readonly Record<string, string | number | null>[],
  keys: readonly string[],
  opts?: { treatZeroAsEmpty?: boolean }
): Set<string> {
  const treatZeroAsEmpty = opts?.treatZeroAsEmpty === true;
  const present = new Set<string>();
  for (const row of rows) {
    for (const key of keys) {
      if (present.has(key)) continue;
      const v = row[key];
      if (typeof v !== "number" || !Number.isFinite(v)) continue;
      if (treatZeroAsEmpty && v === 0) continue;
      present.add(key);
    }
  }
  return present;
}

/** Value line + its "aportes acum." companion: `depositFor` names the value series. */
type PairableSeries = { dataKey: string; depositFor?: string };

/**
 * Keep the series that have data in `rows`. **The value line decides for its deposit companion**:
 * cumulative aportes stay at their historical level forever, so a sold-out account would otherwise
 * be kept alive by a flat companion long after its value line went null — exactly the case this
 * filtering exists to remove. Both render or neither does.
 */
export function seriesWithWindowData<T extends PairableSeries>(
  series: readonly T[],
  rows: readonly Record<string, string | number | null>[],
  opts?: { treatZeroAsEmpty?: boolean }
): T[] {
  const present = dataKeysWithWindowData(rows, series.map((s) => s.dataKey), opts);
  const knownKeys = new Set(series.map((s) => s.dataKey));
  // A companion whose value line isn't in this series set (shouldn't happen) falls back to itself.
  const decidingKey = (s: PairableSeries): string =>
    s.depositFor != null && knownKeys.has(s.depositFor) ? s.depositFor : s.dataKey;
  return series.filter((s) => present.has(decidingKey(s)));
}
