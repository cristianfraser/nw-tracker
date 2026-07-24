import { formatClp, formatUsd } from "../../format";
import { formatDayMonthShortLabel, formatMonthYearShortLabel } from "../../formatDateLabel";

export type ChartDisplayUnit = "clp" | "usd";

/**
 * Recharts cartesian margins. Keep `left` small: Y-axis label room comes mainly from `rechartsMoneyYAxisWidth`
 * on `<YAxis width={…} />`; a large `left` here stacks with that and looks like an empty gutter.
 */
export const RECHARTS_MONEY_CHART_MARGIN = { top: 8, right: 8, left: 2, bottom: 0 } as const;

/** Width reserved for Y-axis ticks (CLP `$·` + es-CL grouping is wider than Recharts’ default ~60px). */
export function rechartsMoneyYAxisWidth(unit: ChartDisplayUnit): number {
  return unit === "usd" ? 78 : 104;
}

/** Match default axis / tick stroke on dark charts (see YAxis/XAxis axisLine usage). */
export const AXIS_LINE_STROKE = "#64748b";

/** Shared `tick={…}` style for X/Y axes across all charts. */
export const CHART_TICK_STYLE = { fontSize: 11, fill: "#94a3b8" } as const;

export const CHART_ANIM_MS = 300;

/** When a series is focused, other legend/tooltip rows fade to this opacity. */
export const DIM_LEGEND_OPACITY = 0.32;

export function formatAxisValue(v: number, unit: ChartDisplayUnit) {
  return unit === "usd" ? formatUsd(v) : formatClp(v);
}

export function formatTooltipValue(v: number, unit: ChartDisplayUnit) {
  return unit === "usd" ? formatUsd(v) : formatClp(v);
}

/** Min and max across the given data keys (finite numbers only). */
export function minMaxForKeys(
  points: readonly Record<string, string | number | null>[],
  keys: readonly string[]
): { min: number; max: number } {
  let minV = Infinity;
  let maxV = -Infinity;
  for (const row of points) {
    for (const k of keys) {
      const v = row[k];
      if (typeof v === "number" && Number.isFinite(v)) {
        minV = Math.min(minV, v);
        maxV = Math.max(maxV, v);
      }
    }
  }
  if (!Number.isFinite(minV)) return { min: 0, max: 0 };
  return { min: minV, max: maxV };
}

/**
 * "Pretty" tick step: 1, 2, 5, or 10 × 10^k (same family as 5×10^n style scales).
 *
 * The mantissa rounds **up** to the next nice value so tick counts stay ≤ target — except the wide 5→10 gap,
 * which is split at its geometric mean √50 ≈ 7.07 instead of at 5. A rough mantissa just above 5 (e.g. 5.07
 * for a US$304k max at 6 divisions) would otherwise jump to a ·10 step and overshoot the axis top by nearly
 * 2× (US$400k for a US$304k series); with the split it keeps the tighter ·5 step (50k → top 350k). This is
 * magnitude-based, not currency-gated: it only bites where the mantissa lands in (5, 7.07], so large-CLP
 * charts (whose mantissas sit elsewhere) are unaffected while the smaller US$ scale gets the finer step.
 */
function niceYStep(roughStep: number): number {
  if (!Number.isFinite(roughStep) || roughStep <= 0) return 1;
  const exp = Math.floor(Math.log10(roughStep));
  const f = roughStep / 10 ** exp;
  const m = f <= 1 ? 1 : f <= 2 ? 2 : f <= Math.SQRT2 * 5 ? 5 : 10; // √50 = 5·√2 ≈ 7.07
  return m * 10 ** exp;
}

function buildTickList(y0: number, y1: number, step: number): number[] {
  const out: number[] = [];
  let t = Math.floor(y0 / step) * step;
  if (t < y0 - step * 1e-9) t += step;
  let guard = 0;
  while (t <= y1 + step * 1e-9 && guard++ < 400) {
    out.push(t);
    t += step;
  }
  return out.length > 0 ? out : [y0, y1];
}

/**
 * Y domain and explicit ticks with round steps; non-negative data uses domain `[0, y1]`.
 * Renders a horizontal reference at **y = 0** when that value lies on the scale: always for the `[0, y1]`
 * branch, and when the scale crosses zero for mixed-sign data (same stroke as axes; see `LineChartPanel`).
 */
export function buildNiceYAxis(minData: number, maxData: number): {
  domain: [number, number];
  ticks: number[];
  showZeroReference: boolean;
} {
  const lo = Math.min(minData, maxData);
  const hi = Math.max(minData, maxData);

  if (!Number.isFinite(lo) || !Number.isFinite(hi)) {
    return { domain: [0, 1], ticks: [0, 0.5, 1], showZeroReference: false };
  }
  if (lo === hi && hi === 0) {
    return { domain: [0, 1], ticks: [0, 0.25, 0.5, 0.75, 1], showZeroReference: false };
  }
  if (lo === hi) {
    const pad = Math.abs(hi) * 0.08 || 1;
    if (hi > 0) return buildNiceYAxis(0, hi + pad);
    if (hi < 0) return buildNiceYAxis(hi - pad, 0);
    return { domain: [0, 1], ticks: [0, 0.25, 0.5, 0.75, 1], showZeroReference: false };
  }

  const targetDivisions = 6;

  if (lo >= 0) {
    const step = niceYStep(hi / targetDivisions || 1);
    const y1 = Math.max(step, Math.ceil(hi / step) * step);
    const ticks = buildTickList(0, y1, step);
    /** Domain is anchored at 0; draw a baseline at y=0 (with X-axis) so the floor is visible on all-positive series. */
    return { domain: [0, y1], ticks, showZeroReference: true };
  }

  const span = hi - lo;
  const step = niceYStep(span / targetDivisions);
  const y1 = Math.ceil(hi / step) * step;
  // Bottom: hug the data floor instead of always snapping down to a full −step multiple. A shallow dip
  // below zero (e.g. −2.5M under a 50M step) would otherwise open a −50M gap. We clear the min by a small
  // pad scaled to the negative extent, but never rise above the nice −step floor — so a *deep* dip still
  // lands its bottom tick on a round value (no regression on symmetric charts). `buildTickList` places
  // ticks on nice multiples ≥ y0, so below-zero ticks appear only where the data actually reaches them.
  const niceFloor = Math.floor(lo / step) * step;
  const y0 = Math.max(niceFloor, lo - Math.abs(lo) * 0.08);
  const ticks = buildTickList(y0, y1, step);
  const showZeroReference = y0 < 0 && y1 > 0;
  return { domain: [y0, y1], ticks, showZeroReference };
}

/**
 * Y-axis for series with a padded band around the data range (e.g. valuations, FX).
 * When `minData >= 0`, the domain never extends below 0 (padding only shrinks toward zero).
 */
export function buildNiceYAxisPositiveBand(
  minData: number,
  maxData: number,
  options?: { targetDivisions?: number; padRatio?: number }
): { domain: [number, number]; ticks: number[] } {
  const targetDivisions = Math.max(4, Math.min(8, options?.targetDivisions ?? 6));
  const padRatio = options?.padRatio ?? 0.045;
  const dataLo = Math.min(minData, maxData);
  const dataHi = Math.max(minData, maxData);
  const nonNegative = dataLo >= 0;
  let lo = dataLo;
  let hi = dataHi;
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) {
    return { domain: [0, 1], ticks: [0, 0.5, 1] };
  }
  if (lo === hi) {
    const w = Math.max(Math.abs(hi) * 0.02, Number.EPSILON * 1e6);
    lo = nonNegative ? Math.max(0, lo - w) : lo - w;
    hi += w;
  }
  const span = hi - lo;
  const pad = Math.max(span * padRatio, 1e-9);
  const yLo = nonNegative ? Math.max(0, lo - pad) : lo - pad;
  const yHi = hi + pad;
  const spanP = yHi - yLo;
  const roughStep = spanP / Math.max(2, targetDivisions - 1);
  let step = niceYStep(roughStep);
  let y0 = Math.floor(yLo / step) * step;
  let y1 = Math.ceil(yHi / step) * step;
  let ticks = buildTickList(y0, y1, step);
  let guard = 0;
  while (ticks.length > 9 && guard++ < 12) {
    step = niceYStep(step * 2);
    y0 = Math.floor(yLo / step) * step;
    y1 = Math.ceil(yHi / step) * step;
    ticks = buildTickList(y0, y1, step);
  }
  if (nonNegative) {
    y0 = Math.max(0, y0);
    ticks = ticks.filter((t) => t >= 0);
    if (y0 === 0 && ticks.length > 0 && ticks[0]! > 0) ticks = [0, ...ticks];
  }
  return { domain: [y0, y1], ticks };
}

export function formatLineChartXTick(
  d: string,
  granularity: "month" | "year" | "day"
): string {
  if (granularity === "year") {
    const y = d.slice(0, 4);
    return /^\d{4}$/.test(y) ? y : d;
  }
  // Day view keeps month-boundary axis ticks (tooltips carry the exact ISO day).
  return formatMonthYearShortLabel(d);
}

/** Month index 0 = Jan 0000 in UTC month arithmetic (y*12 + (m-1)). */
function ymdToMonthIndex(ymd: string): number | null {
  const m = /^(\d{4})-(\d{2})-\d{2}$/.exec(ymd.trim());
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  if (!Number.isFinite(y) || mo < 1 || mo > 12) return null;
  return y * 12 + (mo - 1);
}

function yearFromYmd(ymd: string): number | null {
  const m = /^(\d{4})-\d{2}-\d{2}$/.exec(ymd.trim());
  if (!m) return null;
  const y = Number(m[1]);
  return Number.isFinite(y) ? y : null;
}

/**
 * Prefer January (the marker reads as the start of year `year`); December only for years with no
 * January row (year-end-row series). Head years need January — a mid-year series start is covered
 * by the first-data-point push instead, avoiding adjacent markers like `dic 17` + `ene 18`.
 */
function findYearBoundaryDate(
  datesAsc: string[],
  year: number,
  firstYear: number
): string | undefined {
  const jan = datesAsc.find((d) => d.startsWith(`${year}-01`));
  if (jan) return jan;
  if (year === firstYear) return undefined;
  const decRows = datesAsc.filter((d) => d.startsWith(`${year}-12`));
  if (decRows.length > 0) return decRows[decRows.length - 1]!;
  return datesAsc.find((d) => d.startsWith(`${year}-`));
}

type XAxisTickOpts = { minTickCount?: number; maxTickCount?: number; includeLastDataPoint?: boolean };

/**
 * Multi-year X-axis ticks at **January (December for year-end-row series)** — one marker per
 * calendar year when possible — then the first/last series dates only when there is room under
 * `maxTickCount`.
 */
function computeYearBoundaryXAxisTicks(datesAsc: string[], opts?: XAxisTickOpts): string[] | undefined {
  const minT = Math.max(2, opts?.minTickCount ?? 4);
  const maxT = Math.max(minT, opts?.maxTickCount ?? 12);
  if (datesAsc.length === 0) return undefined;
  if (datesAsc.length === 1) return [datesAsc[0]!];

  const y0 = yearFromYmd(datesAsc[0]!);
  const y1 = yearFromYmd(datesAsc[datesAsc.length - 1]!);
  if (y0 == null || y1 == null) return undefined;
  const span = y1 - y0;
  if (span <= 0) return [datesAsc[0]!];

  let yearStep = 1;
  let found = false;
  for (const s of [12, 10, 8, 6, 5, 4, 3, 2, 1]) {
    const n = 1 + Math.floor(span / s);
    if (n >= minT && n <= maxT) {
      yearStep = s;
      found = true;
      break;
    }
  }
  if (!found && 1 + Math.floor(span / 1) > maxT) {
    yearStep = Math.max(1, Math.ceil(span / (maxT - 1)));
  }

  const ticks: string[] = [];
  const push = (d: string | undefined) => {
    if (d && !ticks.includes(d)) ticks.push(d);
  };
  for (let y = y0; y <= y1; y += yearStep) {
    push(findYearBoundaryDate(datesAsc, y, y0));
  }

  const firstD = datesAsc[0]!;
  const lastD = datesAsc[datesAsc.length - 1]!;
  if (ticks.length < maxT) push(firstD);
  if (opts?.includeLastDataPoint !== false && ticks.length < maxT) push(lastD);

  ticks.sort((a, b) => a.localeCompare(b));
  return ticks.length ? ticks : undefined;
}

/** Unique `as_of_date` values, sorted ascending (YYYY-MM-DD). */
export function extractSortedAsOfDates(points: { as_of_date?: string | null }[]): string[] {
  const seen = new Set<string>();
  for (const p of points) {
    const d = String(p.as_of_date ?? "").trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(d)) seen.add(d);
  }
  return [...seen].sort((a, b) => a.localeCompare(b));
}

/**
 * X-axis tick values at **even calendar month strides** (e.g. every 4 months from the first point),
 * so labels are evenly spaced in time instead of Recharts’ uneven category sampling.
 *
 * @param opts.includeLastDataPoint When true (default), append the final series date if absent so the
 *   last month is labeled (e.g. P/L combo). When false (valuation lines), omit it so the last tick stays
 *   stride-aligned (e.g. Jun 2025 every 12 months) instead of a short tail month (May 2026).
 */
export function computeRegularMonthXAxisTicks(
  datesAsc: string[],
  opts?: { minTickCount?: number; maxTickCount?: number; includeLastDataPoint?: boolean }
): string[] | undefined {
  const minT = Math.max(2, opts?.minTickCount ?? 8);
  const maxT = Math.max(minT, opts?.maxTickCount ?? 14);
  if (datesAsc.length === 0) return undefined;
  if (datesAsc.length === 1) return [datesAsc[0]!];

  const i0 = ymdToMonthIndex(datesAsc[0]!);
  const i1 = ymdToMonthIndex(datesAsc[datesAsc.length - 1]!);
  if (i0 == null || i1 == null) return undefined;
  const span = i1 - i0;
  if (span <= 0) return [datesAsc[0]!];

  let step = 1;
  let found = false;
  for (const s of [48, 36, 24, 18, 12, 9, 6, 4, 3, 2, 1]) {
    const n = 1 + Math.floor(span / s);
    if (n >= minT && n <= maxT) {
      step = s;
      found = true;
      break;
    }
  }
  if (!found && 1 + Math.floor(span / 1) > maxT) {
    step = Math.max(1, Math.ceil(span / (maxT - 1)));
  }

  if (step >= 12) {
    return computeYearBoundaryXAxisTicks(datesAsc, {
      minTickCount: minT,
      maxTickCount: maxT,
      includeLastDataPoint: opts?.includeLastDataPoint,
    });
  }

  const ticks: string[] = [];
  for (let t = i0; t <= i1; t += step) {
    const y = Math.floor(t / 12);
    const m0 = t % 12;
    const prefix = `${y}-${String(m0 + 1).padStart(2, "0")}`;
    const row = datesAsc.find((d) => d.startsWith(prefix));
    if (row) {
      if (ticks.length === 0 || ticks[ticks.length - 1] !== row) ticks.push(row);
    } else {
      const boundary = `${prefix}-01`;
      const row2 = datesAsc.find((d) => d >= boundary);
      if (row2 && (ticks.length === 0 || ticks[ticks.length - 1] !== row2)) ticks.push(row2);
    }
  }
  if (opts?.includeLastDataPoint !== false) {
    const lastD = datesAsc[datesAsc.length - 1]!;
    if (!ticks.includes(lastD)) ticks.push(lastD);
  }
  return ticks.length ? ticks : undefined;
}

/** Year-end rows (`YYYY-12-31`): ticks every N calendar years for readable density. */
export function computeRegularYearXAxisTicks(
  datesAsc: string[],
  opts?: { minTickCount?: number; maxTickCount?: number; includeLastDataPoint?: boolean }
): string[] | undefined {
  return computeYearBoundaryXAxisTicks(datesAsc, opts);
}

/** Day strides that read as round intervals on a calendar-day axis. */
const DAY_TICK_STRIDES = [1, 2, 3, 5, 7, 10, 14, 21, 28, 35, 42, 56, 70, 91, 120] as const;

/** Month strides that read as round intervals when a daily axis is labelled by month. */
const MONTH_TICK_STRIDES = [1, 2, 3, 4, 6, 12, 24, 36, 60, 120] as const;

/** Take every `stride`-th entry anchored on the LAST one, so the newest tick is always labelled. */
function thinFromEnd<T>(items: readonly T[], stride: number): T[] {
  const out: T[] = [];
  for (let i = items.length - 1; i >= 0; i -= stride) out.unshift(items[i]!);
  return out;
}

/**
 * Ticks for a dense **calendar-day** grid.
 *
 * Preferred form: **the first day of each month** (thinned to every Nth month when the window is
 * long), labelled `jul 25` — evenly spaced in calendar terms and self-explanatory, instead of the
 * arbitrary days an every-N-days stride lands on (`jul 23, ago 27, oct 1, …`).
 *
 * A window too short to contain `minMonthTicks` month starts (30d/60d ranges) falls back to a
 * whole-day stride with day-precision labels (`withDay: true`), since one or two month boundaries
 * would leave the axis nearly unlabelled.
 */
export function computeRegularDayXAxisTicks(
  datesAsc: string[],
  opts?: { maxTickCount?: number; minMonthTicks?: number }
): { ticks: string[] | undefined; withDay: boolean } {
  const maxT = Math.max(2, opts?.maxTickCount ?? 12);
  const minMonthTicks = Math.max(2, opts?.minMonthTicks ?? 3);
  if (datesAsc.length === 0) return { ticks: undefined, withDay: false };
  if (datesAsc.length === 1) return { ticks: [datesAsc[0]!], withDay: true };

  const monthFirsts = datesAsc.filter((d) => d.slice(8, 10) === "01");
  if (monthFirsts.length >= minMonthTicks) {
    let stride = MONTH_TICK_STRIDES[MONTH_TICK_STRIDES.length - 1]!;
    for (const s of MONTH_TICK_STRIDES) {
      if (Math.ceil(monthFirsts.length / s) <= maxT) {
        stride = s;
        break;
      }
    }
    return { ticks: thinFromEnd(monthFirsts, stride), withDay: false };
  }

  const n = datesAsc.length;
  let stride = DAY_TICK_STRIDES[DAY_TICK_STRIDES.length - 1]!;
  for (const s of DAY_TICK_STRIDES) {
    if (Math.ceil(n / s) <= maxT) {
      stride = s;
      break;
    }
  }
  const ticks = thinFromEnd(datesAsc, stride);
  return { ticks, withDay: true };
}

/**
 * X-axis ticks + label/tooltip formatters for a period chart. Day grids get day-spaced ticks with
 * date labels and ISO tooltip titles (the repo date convention); month/year keep their existing
 * boundary ticks and labels. Shared so the flows charts can't drift from each other.
 */
export function resolvePeriodXAxis(
  datesAsc: string[],
  granularity: "month" | "year" | "day"
): {
  ticks: string[] | undefined;
  formatTick: (d: string) => string;
  formatTooltipTitle: (d: string) => string;
} {
  if (granularity === "day") {
    const { ticks, withDay } = computeRegularDayXAxisTicks(datesAsc);
    return {
      ticks,
      formatTick: (d) => (withDay ? formatDayMonthShortLabel(d) : formatMonthYearShortLabel(d)),
      formatTooltipTitle: (d) => d,
    };
  }
  return {
    ticks:
      granularity === "year"
        ? computeRegularYearXAxisTicks(datesAsc)
        : computeRegularMonthXAxisTicks(datesAsc),
    formatTick: (d) => formatLineChartXTick(d, granularity),
    formatTooltipTitle: (d) => formatLineChartXTick(d, granularity),
  };
}
