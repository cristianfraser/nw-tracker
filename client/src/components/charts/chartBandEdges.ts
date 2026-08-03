/**
 * Geometry for the alternating x-axis bands drawn behind grouped bars (see chartBands.tsx).
 */

/** The slice of the chart props+state Recharts injects into a `Customized` child that we read. */
export type BandScale = ((value: unknown) => number | undefined) & {
  domain?: () => unknown[];
  bandwidth?: () => number;
};

export type BandAxis = {
  scale?: BandScale;
};

export type ChartOffset = { top: number; left: number; width: number; height: number };

/**
 * Most bands we will draw. Past this the stripes get narrower than the groups they bracket and stop
 * reading as separators, so the bands step up to a coarser calendar unit — a month per band over a
 * daily series, a quarter over three years of months.
 */
const MAX_BANDS = 24;

/** Coarsest-last. A band covers one whole unit, so fewer, wider bands as we walk down the list. */
const BAND_UNITS = ["category", "month", "quarter", "semester", "year"] as const;
type BandUnit = (typeof BAND_UNITS)[number];

/**
 * True when alternating bands are worth drawing: two or more side-by-side bars per category. One
 * column per tick — a single or stacked bar — is already unambiguous and needs no bracketing.
 *
 * Derived per render from the series actually drawn, since the same chart draws grouped bars in one
 * mode and a single consolidated bar in another.
 */
export function hasBandableBarGroups(barSeriesCount: number, categoryCount: number): boolean {
  return barSeriesCount > 1 && categoryCount > 1;
}

/**
 * Calendar bucket a category belongs to, from its `YYYY-MM-DD` / `YYYY-MM` value. Categories that
 * aren't dates fall back to their own index, i.e. no coarsening — the stride pass below still keeps
 * the band count in range.
 */
function bucketKey(value: unknown, unit: BandUnit, index: number): string {
  if (unit === "category") return `i${index}`;
  const s = String(value ?? "");
  const year = s.slice(0, 4);
  const month = Number(s.slice(5, 7));
  if (!/^\d{4}$/.test(year) || !Number.isInteger(month) || month < 1 || month > 12) return `i${index}`;
  switch (unit) {
    case "month":
      return `${year}-${s.slice(5, 7)}`;
    case "quarter":
      return `${year}-Q${Math.ceil(month / 3)}`;
    case "semester":
      return `${year}-H${Math.ceil(month / 6)}`;
    case "year":
      return year;
  }
}

/** Index of the last category in each run of equal keys — i.e. where one band ends. */
function runEnds(keys: string[]): number[] {
  const ends: number[] = [];
  for (let i = 0; i < keys.length - 1; i++) if (keys[i] !== keys[i + 1]) ends.push(i);
  return ends;
}

/**
 * Where the bands break, as indices into the sorted category list: the last category of each band.
 * Walks to a coarser calendar unit until the count fits, then falls back to an even stride for
 * non-date categories (or a range so long that even years are too many).
 */
export function bandBreakIndices(domain: unknown[]): number[] {
  for (const unit of BAND_UNITS) {
    const ends = runEnds(domain.map((v, i) => bucketKey(v, unit, i)));
    if (ends.length + 1 <= MAX_BANDS) return ends;
  }
  const stride = Math.ceil(domain.length / MAX_BANDS);
  const ends: number[] = [];
  for (let i = stride - 1; i < domain.length - 1; i += stride) ends.push(i);
  return ends;
}

/**
 * Pixel boundaries of the bands: the plot edges plus the midpoint between the categories either side
 * of each break. A band always spans whole bar groups — aligning to the axis labels instead would
 * break wherever they are thinned (every 2nd month at the 3y range), leaving a band straddling half
 * a group at each end and marking nothing.
 *
 * Midpoints, rather than "center ± step/2", so an irregular gap brackets correctly either way.
 */
export function bandEdges(xAxis: BandAxis, offset: ChartOffset): number[] {
  const scale = xAxis.scale;
  const domain = scale?.domain?.();
  if (!scale || !domain?.length) return [];

  const right = offset.left + offset.width;
  // Band scales map a category to its left edge; point scales (bar-less charts) to its center.
  const halfBand = typeof scale.bandwidth === "function" ? scale.bandwidth() / 2 : 0;

  const placed = domain
    .map((c) => ({ c, x: scale(c) }))
    .filter((p): p is { c: unknown; x: number } => typeof p.x === "number" && Number.isFinite(p.x))
    .sort((a, b) => a.x - b.x);
  if (placed.length < 2) return placed.length ? [offset.left, right] : [];

  const centers = placed.map((p) => p.x + halfBand);
  const mids = bandBreakIndices(placed.map((p) => p.c))
    .map((i) => (centers[i]! + centers[i + 1]!) / 2)
    .filter((x) => x > offset.left && x < right);
  return [offset.left, ...mids, right];
}
