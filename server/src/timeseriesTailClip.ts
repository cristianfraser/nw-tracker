/**
 * Trailing-zero tail clip on valuation timeseries payload blocks.
 *
 * Sold-out / closed series keep one plotted zero month, then get `null` so chart lines
 * end instead of hugging zero. When **every** data series ends early, the block also
 * gets `chart_end_ymd` and its points are trimmed so the x-axis stops there.
 *
 * This runs at payload build time (dashboard / group / account timeseries) — the client
 * renders blocks as-is and must not re-derive clipping.
 */

export const TS_TRAILING_ZERO_MONTHS_KEPT = 1;

type Row = Record<string, string | number | null>;

type ClipAccountLine = {
  account_id: number;
  dataKey: string;
  valueSeriesType: "data" | "reference";
  depositDataKey?: string;
  displayDepositDataKey?: string;
  exclude_from_group_totals?: boolean;
};

type ClipLine = { dataKey: string; valueSeriesType: "data" | "reference" };

export type TailClipableBlock = {
  accounts?: ClipAccountLine[];
  lines?: ClipLine[];
  points: Row[];
  /** Last visible date when every data series ends early (x-axis stops here). */
  chart_end_ymd?: string;
  /** Data keys whose tails were nulled (client sets `connectNulls={false}` on these lines). */
  tail_clipped_keys?: string[];
};

type SeriesEntry = { dataKey: string; type: "data" | "reference" };

function collectSeries(block: TailClipableBlock): SeriesEntry[] {
  const entries: SeriesEntry[] = [];
  for (const a of block.accounts ?? []) {
    entries.push({ dataKey: a.dataKey, type: a.valueSeriesType });
    if (a.depositDataKey) entries.push({ dataKey: a.depositDataKey, type: a.valueSeriesType });
    if (a.displayDepositDataKey) {
      entries.push({ dataKey: a.displayDepositDataKey, type: a.valueSeriesType });
    }
  }
  for (const ln of block.lines ?? []) {
    entries.push({ dataKey: ln.dataKey, type: ln.valueSeriesType });
  }
  return entries;
}

function dataSeriesKeys(series: readonly SeriesEntry[]): string[] {
  return [...new Set(series.filter((s) => s.type === "data").map((s) => s.dataKey))];
}

/** Index from which to null a series after trailing zeros; `null` if no clip. */
export function trailingZeroTailClipStartIndex(
  points: readonly Row[],
  dataKey: string,
  monthsKept = TS_TRAILING_ZERO_MONTHS_KEPT
): number | null {
  let lastNonZeroIdx = -1;
  for (let i = 0; i < points.length; i++) {
    const v = points[i]![dataKey];
    if (typeof v === "number" && Number.isFinite(v) && Math.abs(v) > 1e-9) {
      lastNonZeroIdx = i;
    }
  }
  const n = points.length;
  const trailingLen = lastNonZeroIdx >= 0 ? n - 1 - lastNonZeroIdx : n;
  if (trailingLen <= monthsKept) return null;
  return lastNonZeroIdx + 1 + monthsKept;
}

/** Recompute Σ of `sourceKeys` per row into `totalKey` (null when no finite parts). */
function recomputeTotalKey(points: Row[], totalKey: string, sourceKeys: readonly string[]): Row[] {
  return points.map((row) => {
    let sum = 0;
    let any = false;
    for (const k of sourceKeys) {
      const v = row[k];
      if (typeof v === "number" && Number.isFinite(v)) {
        sum += v;
        any = true;
      }
    }
    return { ...row, [totalKey]: any ? sum : null };
  });
}

const GROUP_VAL_TOTAL = "__group_val_total";
const GROUP_DEP_TOTAL = "__group_dep_total";

/** Parts whose Σ refreshes `__group_val_total` after clip (consolidated per-account ids keep the server cierre). */
function groupValTotalSourceKeys(accs: readonly ClipAccountLine[] | undefined): string[] | undefined {
  if (!accs?.some((a) => a.dataKey === GROUP_VAL_TOTAL)) return undefined;
  const keys = accs
    .filter(
      (a) =>
        a.dataKey !== GROUP_VAL_TOTAL &&
        a.dataKey !== GROUP_DEP_TOTAL &&
        a.valueSeriesType === "data" &&
        !a.exclude_from_group_totals
    )
    .map((a) => a.dataKey);
  if (keys.length === 0) return undefined;
  // Portfolio account ids and nav-grouped bucket lines keep the server consolidated month cierre.
  if (keys.every((k) => /^\d+$/.test(k) || k.startsWith("nav_"))) return undefined;
  return keys;
}

function groupDepTotalSourceKeys(accs: readonly ClipAccountLine[] | undefined): string[] | undefined {
  if (!accs?.some((a) => a.dataKey === GROUP_DEP_TOTAL)) return undefined;
  if (!accs.some((a) => a.valueSeriesType === "data" && Boolean(a.depositDataKey))) return undefined;
  const keys = accs
    .filter((a) => a.valueSeriesType === "data" && !a.exclude_from_group_totals && a.depositDataKey)
    .map((a) => a.depositDataKey!);
  return keys.length ? keys : undefined;
}

/**
 * Null each `data` series from the (monthsKept+1)th trailing zero row onward, bundling an
 * account's deposit lines with its valuation line. When every subject series qualifies,
 * trim points after the last visible date and set `chart_end_ymd`.
 */
export function applyTrailingZeroTailClipToBlock<T extends TailClipableBlock>(
  block: T,
  monthsKept = TS_TRAILING_ZERO_MONTHS_KEPT
): T & { chart_end_ymd?: string; tail_clipped_keys?: string[] } {
  const series = collectSeries(block);
  const keys = dataSeriesKeys(series);
  if (keys.length === 0 || block.points.length === 0) return block;

  const depositKeysByValuationKey: Record<string, string[]> = {};
  for (const a of block.accounts ?? []) {
    if (a.account_id <= 0) continue;
    const deps = [a.depositDataKey, a.displayDepositDataKey].filter((dk): dk is string =>
      Boolean(dk)
    );
    if (deps.length > 0) depositKeysByValuationKey[a.dataKey] = deps;
  }
  const linkedDepositKeys = new Set(Object.values(depositKeysByValuationKey).flat());

  /** One subject per valuation key or orphan data key (same rule for clip and x-trim). */
  const subjects: string[] = [];
  for (const valKey of Object.keys(depositKeysByValuationKey)) {
    if (keys.includes(valKey)) subjects.push(valKey);
  }
  for (const dk of keys) {
    if (dk in depositKeysByValuationKey) continue;
    if (linkedDepositKeys.has(dk)) continue;
    subjects.push(dk);
  }

  const tailClippedKeys = new Set<string>();
  let points = block.points.map((r) => ({ ...r }));
  let allSubjectsClipped = subjects.length > 0;
  const lastVisibleDates: string[] = [];

  for (const subject of subjects) {
    const startNullAt = trailingZeroTailClipStartIndex(points, subject, monthsKept);
    if (startNullAt == null || startNullAt <= 0) {
      allSubjectsClipped = false;
      continue;
    }
    const bundled = [
      subject,
      ...(depositKeysByValuationKey[subject] ?? []).filter((dk) => keys.includes(dk)),
    ];
    for (let i = startNullAt; i < points.length; i++) {
      for (const k of bundled) points[i]![k] = null;
    }
    for (const k of bundled) tailClippedKeys.add(k);
    const d = String(points[startNullAt - 1]!.as_of_date ?? "").trim();
    if (d) lastVisibleDates.push(d);
    else allSubjectsClipped = false;
  }

  if (tailClippedKeys.size === 0) return block;

  const valTotalKeys = groupValTotalSourceKeys(block.accounts);
  if (valTotalKeys?.length && points[0] && GROUP_VAL_TOTAL in points[0]) {
    points = recomputeTotalKey(points, GROUP_VAL_TOTAL, valTotalKeys);
  }
  const depTotalKeys = groupDepTotalSourceKeys(block.accounts);
  if (depTotalKeys?.length && points[0] && GROUP_DEP_TOTAL in points[0]) {
    points = recomputeTotalKey(points, GROUP_DEP_TOTAL, depTotalKeys);
  }

  let chart_end_ymd: string | undefined;
  if (allSubjectsClipped && lastVisibleDates.length === subjects.length) {
    chart_end_ymd = lastVisibleDates.reduce((a, b) => (a.localeCompare(b) >= 0 ? a : b));
    points = points.filter(
      (r) => String(r.as_of_date ?? "").localeCompare(chart_end_ymd!) <= 0
    );
  }

  return {
    ...block,
    points,
    tail_clipped_keys: [...tailClippedKeys].sort(),
    ...(chart_end_ymd ? { chart_end_ymd } : {}),
  };
}
