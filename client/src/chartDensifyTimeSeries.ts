/**
 * Expand sparse time-series chart rows so every calendar bucket between min and max
 * appears on the X axis (Recharts category), with nulls (and optional zeros for bars).
 */

export type ChartSparseRow = Record<string, string | number | null>;

function ymCompare(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
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

function expandYearMonthsInclusive(minYm: string, maxYm: string): string[] {
  const out: string[] = [];
  let cur = minYm;
  for (let guard = 0; guard < 800 && ymCompare(cur, maxYm) <= 0; guard++) {
    out.push(cur);
    cur = addCalendarMonths(cur, 1);
  }
  return out;
}

function ymFromYmd(d: string): string | null {
  const t = String(d ?? "").trim();
  const m = /^(\d{4}-\d{2})-\d{2}$/.exec(t);
  return m ? m[1]! : null;
}

function yearFromYmd(d: string): number | null {
  const t = String(d ?? "").trim();
  const m = /^(\d{4})-\d{2}-\d{2}$/.exec(t);
  if (!m) return null;
  const y = Number(m[1]);
  return Number.isFinite(y) ? y : null;
}

function lastDayOfMonthYmd(ym: string): string {
  const [ys, ms] = ym.split("-").map(Number);
  const d = new Date(Date.UTC(ys, ms, 0));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

function collectKeys(points: readonly ChartSparseRow[], dateKey: string): string[] {
  const keys = new Set<string>();
  for (const r of points) {
    for (const k of Object.keys(r)) {
      if (k !== dateKey) keys.add(k);
    }
  }
  return [...keys];
}

function syntheticRow(
  dateKey: string,
  asOf: string,
  templateKeys: string[],
  fill: "null" | "zero",
  zeroKeys: Set<string>
): ChartSparseRow {
  const row: ChartSparseRow = { [dateKey]: asOf };
  for (const k of templateKeys) {
    if (k === dateKey) continue;
    if (fill === "zero" && zeroKeys.has(k)) row[k] = 0;
    else row[k] = null;
  }
  return row;
}

export type DensifyCalendarOptions = {
  dateKey?: string;
  granularity: "month" | "year" | "day";
  /** Missing buckets: all numeric fields null (lines), or listed keys set to 0 (bars). */
  fillMissing?: "null_all" | { zeroKeys: readonly string[] };
  /** Extend the right edge through this calendar day (month or year bucket), even with no data. */
  extendThroughYmd?: string;
};

/**
 * Insert rows for every calendar month or year between the earliest and latest `dateKey`
 * in `points`. Existing rows are preserved (same month/year keeps the row with latest
 * `dateKey` value when duplicates exist).
 */
export function densifyRecordsByCalendarPeriod<T extends ChartSparseRow>(
  points: readonly T[],
  opts: DensifyCalendarOptions
): T[] {
  const dateKey = opts.dateKey ?? "as_of_date";
  if (points.length === 0) return [];

  const sortedDates: string[] = [];
  const seen = new Set<string>();
  for (const r of points) {
    const d = String(r[dateKey] ?? "").trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(d)) seen.add(d);
  }
  for (const d of seen) sortedDates.push(d);
  sortedDates.sort((a, b) => a.localeCompare(b));
  if (sortedDates.length === 0) return [...points];

  const templateKeys = collectKeys(points, dateKey);
  const zeroKeys =
    opts.fillMissing && typeof opts.fillMissing === "object" && "zeroKeys" in opts.fillMissing
      ? new Set(opts.fillMissing.zeroKeys)
      : new Set<string>();
  const fill: "null" | "zero" = zeroKeys.size > 0 ? "zero" : "null";

  /**
   * Every calendar day gets a row. Server-built daily series already arrive complete, so this is
   * a no-op for them; the flows day aggregations are event-sparse (only days with a deposit /
   * purchase / income), and on a **category** x-axis unfilled gaps would space a 2-day and a
   * 40-day gap identically — the axis has to carry real time.
   */
  if (opts.granularity === "day") {
    const byDate = new Map<string, T>();
    for (const r of points) {
      const d = String(r[dateKey] ?? "").trim();
      if (/^\d{4}-\d{2}-\d{2}$/.test(d)) byDate.set(d, r);
    }
    const first = sortedDates[0]!;
    let last = sortedDates[sortedDates.length - 1]!;
    const extendThrough = String(opts.extendThroughYmd ?? "").trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(extendThrough) && extendThrough > last) last = extendThrough;
    const out: T[] = [];
    for (let cur = first; cur <= last; cur = addCalendarDaysIso(cur, 1)) {
      const hit = byDate.get(cur);
      out.push(hit ? { ...hit } : (syntheticRow(dateKey, cur, templateKeys, fill, zeroKeys) as T));
    }
    return out;
  }

  if (opts.granularity === "year") {
    const byYear = new Map<number, T>();
    for (const r of points) {
      const d = String(r[dateKey] ?? "").trim();
      const y = yearFromYmd(d);
      if (y == null) continue;
      const prev = byYear.get(y);
      if (!prev || String(prev[dateKey] ?? "").localeCompare(d) < 0) byYear.set(y, r);
    }
    const years = [...byYear.keys()].sort((a, b) => a - b);
    if (years.length === 0) return [...points];
    const y0 = years[0]!;
    let y1 = years[years.length - 1]!;
    const extendYear = opts.extendThroughYmd ? yearFromYmd(opts.extendThroughYmd) : null;
    if (extendYear != null && extendYear > y1) y1 = extendYear;
    const out: T[] = [];
    for (let y = y0; y <= y1; y++) {
      const hit = byYear.get(y);
      if (hit) out.push({ ...hit });
      else {
        const asOf = `${y}-12-31`;
        out.push(syntheticRow(dateKey, asOf, templateKeys, fill, zeroKeys) as T);
      }
    }
    return out;
  }

  const byYm = new Map<string, T>();
  for (const r of points) {
    const d = String(r[dateKey] ?? "").trim();
    const ym = ymFromYmd(d);
    if (!ym) continue;
    const prev = byYm.get(ym);
    if (!prev || String(prev[dateKey] ?? "").localeCompare(d) < 0) byYm.set(ym, r);
  }
  const yms = [...byYm.keys()].sort(ymCompare);
  if (yms.length === 0) return [...points];
  const minYm = yms[0]!;
  let maxYm = yms[yms.length - 1]!;
  const extendYm = opts.extendThroughYmd ? ymFromYmd(opts.extendThroughYmd) : null;
  if (extendYm && ymCompare(extendYm, maxYm) > 0) maxYm = extendYm;
  const expanded = expandYearMonthsInclusive(minYm, maxYm);
  const out: T[] = [];
  for (const ym of expanded) {
    const hit = byYm.get(ym);
    if (hit) out.push({ ...hit });
    else {
      const asOf = lastDayOfMonthYmd(ym);
      out.push(syntheticRow(dateKey, asOf, templateKeys, fill, zeroKeys) as T);
    }
  }
  return out;
}

function addCalendarDaysIso(ymd: string, delta: number): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd.trim());
  if (!m) return ymd;
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + delta, 12, 0, 0, 0);
  const d = new Date(t);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

/**
 * Every calendar day from min to max `dateKey` (YYYY-MM-DD), inclusive.
 * Missing days get `valueKeys` set to `null`.
 */
export function densifyRecordsByCalendarDay<T extends ChartSparseRow>(
  points: readonly T[],
  dateKey: string,
  valueKeys: readonly string[],
  options?: { maxDays?: number }
): T[] {
  if (points.length === 0) return [];
  const maxDays = options?.maxDays ?? 16000;
  const dates: string[] = [];
  for (const r of points) {
    const d = String(r[dateKey] ?? "").trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(d)) dates.push(d);
  }
  if (dates.length === 0) return [...points];
  dates.sort((a, b) => a.localeCompare(b));
  const d0 = dates[0]!;
  const d1 = dates[dates.length - 1]!;

  const byDate = new Map<string, T>();
  for (const r of points) {
    const d = String(r[dateKey] ?? "").trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(d)) byDate.set(d, r);
  }

  const templateKeys = [...new Set([...collectKeys(points, dateKey), ...valueKeys])];
  const out: T[] = [];
  let cur = d0;
  for (let n = 0; n < maxDays && cur.localeCompare(d1) <= 0; n++) {
    const hit = byDate.get(cur);
    if (hit) out.push({ ...hit });
    else {
      const row: ChartSparseRow = { [dateKey]: cur };
      for (const k of templateKeys) {
        if (k === dateKey) continue;
        row[k] = null;
      }
      out.push(row as T);
    }
    cur = addCalendarDaysIso(cur, 1);
  }
  return out;
}
