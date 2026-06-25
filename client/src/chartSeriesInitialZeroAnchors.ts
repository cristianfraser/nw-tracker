import type { ChartSparseRow } from "./chartDensifyTimeSeries";
import type { TimeseriesBlock } from "./types";

function ymFromYmd(d: string): string | null {
  const m = /^(\d{4}-\d{2})-\d{2}$/.exec(String(d ?? "").trim());
  return m ? m[1]! : null;
}

function addCalendarMonths(ym: string, delta: number): string {
  const m = /^(\d{4})-(\d{2})$/.exec(ym.trim());
  if (!m) return ym;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  if (!Number.isFinite(y) || mo < 1 || mo > 12) return ym;
  const d = new Date(Date.UTC(y, mo - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

function lastDayOfMonthYmd(ym: string): string {
  const [ys, ms] = ym.split("-").map(Number);
  const d = new Date(Date.UTC(ys, ms, 0));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

/** Month-end or prior year-end immediately before `ymd`'s calendar bucket. */
export function priorCalendarPeriodEndYmd(
  ymd: string,
  granularity: "month" | "year"
): string | null {
  const t = String(ymd ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(t)) return null;
  if (granularity === "year") {
    const y = Number(t.slice(0, 4));
    if (!Number.isFinite(y)) return null;
    return `${y - 1}-12-31`;
  }
  const ym = ymFromYmd(t);
  if (!ym) return null;
  return lastDayOfMonthYmd(addCalendarMonths(ym, -1));
}

const VALUE_EPS = 1e-9;

function isPlottedNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function isPositivePlottedValue(v: unknown): boolean {
  return isPlottedNumber(v) && Math.abs(v) > VALUE_EPS;
}

/**
 * After the last non-zero month, coerce the first trailing `null` to `0` so sold-out
 * positions plot `[…, x, 0]` (current month) before tail-clip collapses longer zero runs.
 */
export function coerceKeptTrailingZeroMonth(
  points: readonly ChartSparseRow[],
  dataKeys: readonly string[],
  dateKey = "as_of_date"
): ChartSparseRow[] {
  if (!points.length || !dataKeys.length) return [...points];
  const out = points.map((r) => ({ ...r }));
  for (const key of dataKeys) {
    let lastPositiveIdx = -1;
    for (let i = 0; i < out.length; i++) {
      if (isPositivePlottedValue(out[i]![key])) lastPositiveIdx = i;
    }
    if (lastPositiveIdx < 0 || lastPositiveIdx >= out.length - 1) continue;
    const trailIdx = lastPositiveIdx + 1;
    if (out[trailIdx]![key] == null) {
      out[trailIdx] = { ...out[trailIdx]!, [key]: 0 };
    }
  }
  return out;
}

function isAnchorExcludedDataKey(dataKey: string): boolean {
  return (
    dataKey === "__group_val_total" ||
    dataKey === "__group_dep_total" ||
    dataKey.startsWith("ref:")
  );
}

/** Valuation line keys that receive a leading `0` anchor (not deposits or class totals). */
export function valuationDataKeysForInitialZeroAnchors(block: TimeseriesBlock): string[] {
  const keys: string[] = [];
  const seen = new Set<string>();
  for (const a of block.accounts ?? []) {
    if (isAnchorExcludedDataKey(a.dataKey) || seen.has(a.dataKey)) continue;
    seen.add(a.dataKey);
    keys.push(a.dataKey);
  }
  for (const ln of block.lines ?? []) {
    if (isAnchorExcludedDataKey(ln.dataKey) || seen.has(ln.dataKey)) continue;
    // USD milestone / invested overlays: plot FX-backed levels only — no leading 0 anchor.
    if (ln.valueSeriesType === "reference") continue;
    seen.add(ln.dataKey);
    keys.push(ln.dataKey);
  }
  return keys;
}

function mergeReferenceMilestonesAtAnchor(
  row: ChartSparseRow,
  anchorDate: string,
  referenceMilestoneByDate?: Record<string, Record<string, number | null>>
): ChartSparseRow {
  const milestones = referenceMilestoneByDate?.[anchorDate];
  if (!milestones) return row;
  const out = { ...row };
  for (const [key, value] of Object.entries(milestones)) {
    if (out[key] == null && value != null) out[key] = value;
  }
  return out;
}

/**
 * Per-series: insert month/year-end `0` one calendar step before the first finite value so
 * Recharts can draw a segment (e.g. LIN `[0, x]`, OILK `[0, x, 0]` after tail-clip).
 */
export function prependInitialZeroAnchors(
  points: readonly ChartSparseRow[],
  dataKeys: readonly string[],
  opts: {
    dateKey?: string;
    granularity: "month" | "year";
    referenceMilestoneByDate?: Record<string, Record<string, number | null>>;
  }
): ChartSparseRow[] {
  const dateKey = opts.dateKey ?? "as_of_date";
  if (points.length === 0 || dataKeys.length === 0) return [];

  const rows = points.map((r) => ({ ...r }));
  const indexByDate = new Map<string, number>();
  for (let i = 0; i < rows.length; i++) {
    const d = String(rows[i]![dateKey] ?? "").trim();
    if (d) indexByDate.set(d, i);
  }

  const sortedDates = [...indexByDate.keys()].sort((a, b) => a.localeCompare(b));

  for (const key of dataKeys) {
    let firstDate: string | null = null;
    for (const d of sortedDates) {
      const idx = indexByDate.get(d)!;
      if (isPlottedNumber(rows[idx]![key])) {
        firstDate = d;
        break;
      }
    }
    if (!firstDate) continue;

    const anchorDate = priorCalendarPeriodEndYmd(firstDate, opts.granularity);
    if (!anchorDate || anchorDate >= firstDate) continue;

    const existingIdx = indexByDate.get(anchorDate);
    if (existingIdx !== undefined) {
      const row = rows[existingIdx]!;
      const patched =
        row[key] == null
          ? mergeReferenceMilestonesAtAnchor({ ...row, [key]: 0 }, anchorDate, opts.referenceMilestoneByDate)
          : mergeReferenceMilestonesAtAnchor(row, anchorDate, opts.referenceMilestoneByDate);
      rows[existingIdx] = patched;
      continue;
    }

    const anchorRow: ChartSparseRow = { [dateKey]: anchorDate, [key]: 0 };
    rows.push(mergeReferenceMilestonesAtAnchor(anchorRow, anchorDate, opts.referenceMilestoneByDate));
    indexByDate.set(anchorDate, rows.length - 1);
  }

  return rows.sort((a, b) => String(a[dateKey] ?? "").localeCompare(String(b[dateKey] ?? "")));
}

export function prependInitialZeroAnchorsOnBlock(
  block: TimeseriesBlock,
  granularity: "month" | "year"
): TimeseriesBlock {
  const dataKeys = valuationDataKeysForInitialZeroAnchors(block);
  if (!block.points.length || !dataKeys.length) return block;
  return {
    ...block,
    points: prependInitialZeroAnchors(block.points, dataKeys, {
      dateKey: "as_of_date",
      granularity,
      referenceMilestoneByDate: block.referenceMilestoneByDate,
    }),
  };
}
