import {
  CartesianGrid,
  Cell,
  DefaultTooltipContent,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { TooltipProps } from "recharts";
import { useMemo, useState } from "react";
import { formatClp, formatUsd, formatMoneyForPie } from "../format";
import type { ChartColorPlan, LineSeriesColorInput, ResolvedLineSeriesItem } from "../chartColors";
import { DEFAULT_LINE_COLORS, resolveLineSeriesColors } from "../chartColors";
import type { TimeseriesBlock } from "../types";

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

function formatAxisValue(v: number, unit: ChartDisplayUnit) {
  return unit === "usd" ? formatUsd(v) : formatClp(v);
}

function formatTooltipValue(v: number, unit: ChartDisplayUnit) {
  return unit === "usd" ? formatUsd(v) : formatClp(v);
}

/** Recharts tooltip color comes from `stroke`; hit underlays use `transparent`, which would make label text invisible. */
function tooltipColorIsVisible(color: unknown): boolean {
  if (color == null || color === "") return false;
  const s = String(color).trim().toLowerCase();
  if (s === "transparent") return false;
  if (s === "rgba(0, 0, 0, 0)" || s === "rgba(0,0,0,0)") return false;
  if (s === "#0000" || s === "#00000000") return false;
  return true;
}

/**
 * Two `<Line>`s share each `dataKey` (hit + visible). Recharts `payloadUniqBy={true}` keeps the first and drops the
 * visible line — leaving `color: transparent` on every row. Prefer the entry with a real stroke color per `dataKey`.
 */
function dedupeTooltipPayloadPreferVisibleStroke(
  payload: NonNullable<TooltipProps<number, string>["payload"]>
): NonNullable<TooltipProps<number, string>["payload"]> {
  const out: NonNullable<TooltipProps<number, string>["payload"]> = [];
  const indexByDataKey = new Map<string, number>();
  for (const entry of payload) {
    const key = String(entry.dataKey ?? "");
    const i = indexByDataKey.get(key);
    if (i === undefined) {
      indexByDataKey.set(key, out.length);
      out.push(entry);
      continue;
    }
    const cur = out[i]!;
    if (tooltipColorIsVisible(entry.color) && !tooltipColorIsVisible(cur.color)) {
      out[i] = entry;
    }
  }
  return out;
}

function numericCell(v: unknown): number {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (v == null) return 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Drop leading months with no cumulative deposits and no valuation, but keep the **last** such month
 * (so the chart starts at the last month “aportes” were still 0, then the first inflow is visible).
 * If there is no positive deposit/valuation in the series, returns the block unchanged.
 */
export function trimLeadingInactivePoints(
  block: TimeseriesBlock,
  includeAccumulatedLines: boolean
): TimeseriesBlock {
  const { points, accounts, lines } = block;
  if (!points.length) return block;

  const depositKeys = new Set<string>();
  const valueKeys = new Set<string>();
  if (accounts?.length) {
    for (const a of accounts) {
      valueKeys.add(a.dataKey);
      if (includeAccumulatedLines && a.depositDataKey) depositKeys.add(a.depositDataKey);
    }
  }
  if (lines?.length) {
    for (const ln of lines) valueKeys.add(ln.dataKey);
  }

  const hasDeposits = depositKeys.size > 0;
  let i = 0;
  while (i < points.length) {
    const row = points[i]!;
    let depPositive = false;
    for (const k of depositKeys) {
      if (numericCell(row[k]) > 0) depPositive = true;
    }
    let valPositive = false;
    for (const k of valueKeys) {
      if (numericCell(row[k]) > 0) valPositive = true;
    }
    if (hasDeposits) {
      if (depPositive) break;
    } else if (valPositive) {
      break;
    }
    i++;
  }

  if (i >= points.length) return block;

  let start = i;
  if (i > 0) {
    const prev = points[i - 1]!;
    let prevDep = false;
    for (const k of depositKeys) {
      if (numericCell(prev[k]) > 0) prevDep = true;
    }
    let prevVal = false;
    for (const k of valueKeys) {
      if (numericCell(prev[k]) > 0) prevVal = true;
    }
    const prevActive = hasDeposits ? prevDep || prevVal : prevVal;
    if (prevActive) start = i - 1;
  }
  return { ...block, points: points.slice(start) };
}

/** Min and max Y across all plotted series (finite numbers only). */
function minMaxAcrossSeries(
  points: Record<string, string | number | null>[],
  series: Pick<ResolvedLineSeriesItem, "dataKey">[]
): { min: number; max: number } {
  const keys = series.map((s) => s.dataKey);
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
 */
function niceYStep(roughStep: number): number {
  if (!Number.isFinite(roughStep) || roughStep <= 0) return 1;
  const exp = Math.floor(Math.log10(roughStep));
  const f = roughStep / 10 ** exp;
  const m = f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10;
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
 * Y domain and explicit ticks with round steps; non-negative data stays anchored at 0.
 * When the domain crosses zero, caller should render a horizontal reference at y=0 (same stroke as axes).
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
    return { domain: [0, y1], ticks, showZeroReference: false };
  }

  const span = hi - lo;
  const step = niceYStep(span / targetDivisions);
  const y0 = Math.floor(lo / step) * step;
  const y1 = Math.ceil(hi / step) * step;
  const ticks = buildTickList(y0, y1, step);
  const showZeroReference = y0 < 0 && y1 > 0;
  return { domain: [y0, y1], ticks, showZeroReference };
}

/**
 * Y-axis for strictly positive series that should **not** be forced to start at zero
 * (e.g. FX ~600–1000, UF ~36k–41k): padded band with 1–2–5–10 style tick steps.
 */
export function buildNiceYAxisPositiveBand(
  minData: number,
  maxData: number,
  options?: { targetDivisions?: number; padRatio?: number }
): { domain: [number, number]; ticks: number[] } {
  const targetDivisions = Math.max(4, Math.min(8, options?.targetDivisions ?? 6));
  const padRatio = options?.padRatio ?? 0.045;
  let lo = Math.min(minData, maxData);
  let hi = Math.max(minData, maxData);
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) {
    return { domain: [0, 1], ticks: [0, 0.5, 1] };
  }
  if (lo === hi) {
    const w = Math.max(Math.abs(hi) * 0.02, Number.EPSILON * 1e6);
    lo -= w;
    hi += w;
  }
  const span = hi - lo;
  const pad = Math.max(span * padRatio, 1e-9);
  const yLo = lo - pad;
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
  return { domain: [y0, y1], ticks };
}

export function formatLineChartXTick(d: string, granularity: "month" | "year"): string {
  if (granularity === "year") {
    const y = d.slice(0, 4);
    return /^\d{4}$/.test(y) ? y : d;
  }
  const x = new Date(`${d}T12:00:00Z`);
  return Number.isNaN(x.getTime()) ? d : x.toLocaleDateString("es-CL", { month: "short", year: "2-digit" });
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
  const minT = Math.max(2, opts?.minTickCount ?? 4);
  const maxT = Math.max(minT, opts?.maxTickCount ?? 12);
  if (datesAsc.length === 0) return undefined;
  if (datesAsc.length === 1) return [datesAsc[0]!];

  const byYear = new Map<number, string>();
  for (const d of datesAsc) {
    const yy = Number(d.slice(0, 4));
    if (Number.isFinite(yy)) byYear.set(yy, d);
  }
  const years = [...byYear.keys()].sort((a, b) => a - b);
  if (years.length === 0) return undefined;
  const y0 = years[0]!;
  const y1 = years[years.length - 1]!;
  const span = y1 - y0;
  if (span <= 0) return [byYear.get(y0)!];

  let step = 1;
  let found = false;
  for (const s of [12, 10, 8, 6, 5, 4, 3, 2, 1]) {
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

  const ticks: string[] = [];
  for (let y = y0; y <= y1; y += step) {
    const row = byYear.get(y);
    if (row && (ticks.length === 0 || ticks[ticks.length - 1] !== row)) ticks.push(row);
  }
  if (opts?.includeLastDataPoint !== false) {
    const lastRow = byYear.get(y1)!;
    if (lastRow && !ticks.includes(lastRow)) ticks.push(lastRow);
  }
  return ticks.length ? ticks : undefined;
}

/** Tooltip fixed just under the plot so it does not cover the lines (Recharts default follows the cursor). */
function LineTooltipBelowPlot({
  active,
  payload,
  label,
  coordinate,
  viewBox,
  displayUnit,
  xAxisGranularity = "month",
}: TooltipProps<number, string> & { displayUnit: ChartDisplayUnit; xAxisGranularity?: "month" | "year" }) {
  if (!active || !payload?.length || !viewBox) return null;
  const tooltipPayload = dedupeTooltipPayloadPreferVisibleStroke(payload);
  if (!tooltipPayload.length) return null;
  const cx = coordinate?.x;
  if (cx == null) return null;
  const vx = viewBox.x ?? 0;
  const vy = viewBox.y ?? 0;
  const vw = viewBox.width ?? 0;
  const vh = viewBox.height ?? 0;
  const pad = 8;
  const left = Math.min(Math.max(cx, pad + 40), vx + vw - pad);
  const top = vy + vh + 4;
  return (
    <div
      className="line-chart-tooltip-dock"
      style={{
        position: "absolute",
        left: 0,
        top: 0,
        transform: `translate(${left}px, ${top}px) translateX(-50%)`,
        pointerEvents: "none",
        zIndex: 20,
        maxWidth: Math.min(360, vw),
      }}
    >
      <DefaultTooltipContent<number, string>
        payload={tooltipPayload}
        label={label}
        formatter={(v) => formatTooltipValue(typeof v === "number" ? v : Number(v), displayUnit)}
        labelFormatter={(d) => formatLineChartXTick(String(d), xAxisGranularity)}
        contentStyle={{
          background: "var(--surface)",
          border: "1px solid var(--border)",
          borderRadius: 8,
          padding: "10px 12px",
          boxShadow: "0 6px 20px rgba(0,0,0,0.35)",
        }}
      />
    </div>
  );
}

interface BlockProps {
  title: string;
  block: TimeseriesBlock;
  displayUnit: ChartDisplayUnit;
  thickKey?: string;
  /** Default h2; use h3 under a category heading */
  titleAs?: "h2" | "h3";
  /** When false, omit “aportes acum.” series (e.g. main dashboard). Default true. */
  includeAccumulatedLines?: boolean;
  /**
   * When true (default), drop long leading flat zeros: start at the last month before cumulative deposits
   * or valuations turn positive (see {@link trimLeadingInactivePoints}).
   */
  trimLeadingInactive?: boolean;
  /** Line colors: dashboard buckets, class-tab alignment with pie, or default. */
  colorPlan?: ChartColorPlan;
  /** When true, Y scale never goes below 0 (retirement class tab). */
  yAxisMinZero?: boolean;
  /** X-axis tick labels: calendar year only vs month+year (dashboard yearly rollup). */
  xAxisGranularity?: "month" | "year";
}

const CHART_ANIM_MS = 300;

/** Match default axis / tick stroke on dark charts (see YAxis/XAxis axisLine below). */
const AXIS_LINE_STROKE = "#64748b";

/** Invisible underlay stroke width — wide hit target (`pointer-events: stroke`). */
const LINE_HIT_STROKE_WIDTH = 24;

/** When a series is focused (line or legend), others fade to this opacity. */
const DIM_LINE_OPACITY = 0.16;
const DIM_LEGEND_OPACITY = 0.32;

function buildRawLineSeries(block: TimeseriesBlock, includeAccumulatedLines: boolean): LineSeriesColorInput[] {
  const raw: LineSeriesColorInput[] = [];
  if (block.accounts?.length) {
    block.accounts.forEach((a, i) => {
      raw.push({ dataKey: a.dataKey, name: a.name, colorIndex: i });
      if (includeAccumulatedLines && a.depositDataKey) {
        raw.push({
          dataKey: a.depositDataKey,
          name: a.deposit_series_name?.trim() || "aportes acum.",
          colorIndex: i,
          isDeposit: true,
        });
      }
    });
  }
  const nAccounts = block.accounts?.length ?? 0;
  for (let j = 0; j < (block.lines?.length ?? 0); j++) {
    const ln = block.lines![j]!;
    raw.push({ dataKey: ln.dataKey, name: ln.name, colorIndex: nAccounts + j });
  }
  return raw;
}

function InteractiveLegend({
  series,
  focusColorIndex,
  onHighlight,
}: {
  series: ResolvedLineSeriesItem[];
  /** When set, legend item and lines with this `colorIndex` stay bright (value + aportes for same account). */
  focusColorIndex: number | null;
  onHighlight: (dataKey: string | null) => void;
}) {
  const visible = series.filter((s) => !s.isDeposit);
  if (visible.length === 0) return null;
  const dim = focusColorIndex != null;
  return (
    <div
      className="line-chart-legend"
      style={{
        display: "flex",
        flexWrap: "wrap",
        justifyContent: "center",
        gap: "10px 18px",
        paddingTop: 10,
        fontSize: 12,
        color: "var(--muted, #94a3b8)",
      }}
    >
      {visible.map((s) => {
        const color = s.stroke;
        const isHi = focusColorIndex != null && s.colorIndex === focusColorIndex;
        const faded = dim && !isHi;
        const isDerivedDash =
          s.dataKey === "invested" || s.dataKey === "available" || s.dataKey === "all_available";
        const legBase = isDerivedDash ? 1.5 : 2;
        return (
          <button
            key={s.dataKey}
            type="button"
            className="line-chart-legend__item"
            onPointerEnter={() => onHighlight(s.dataKey)}
            style={{
              cursor: "default",
              border: "none",
              background: "none",
              padding: "2px 4px",
              margin: 0,
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              opacity: faded ? DIM_LEGEND_OPACITY : 1,
              color: "inherit",
              font: "inherit",
              transition: "opacity 0.12s ease-out",
            }}
          >
            <svg width={18} height={10} aria-hidden style={{ flexShrink: 0 }}>
              <line
                x1={0}
                y1={5}
                x2={18}
                y2={5}
                stroke={color}
                strokeWidth={isHi ? (isDerivedDash ? Math.max(legBase * 1.35, legBase + 0.85) : 3.5) : legBase}
                opacity={faded ? 0.5 : s.dataKey === "all_available" ? 0.6 : isDerivedDash ? 0.8 : 1}
              />
            </svg>
            <span
              style={{
                fontWeight: 400,
                ...(focusColorIndex != null && isHi ? { color: "#f1f5f9" } : {}),
              }}
            >
              {s.name}
            </span>
          </button>
        );
      })}
    </div>
  );
}

export function LineChartPanel({
  title,
  block,
  displayUnit,
  thickKey,
  titleAs = "h2",
  includeAccumulatedLines = true,
  trimLeadingInactive = true,
  colorPlan,
  yAxisMinZero = false,
  xAxisGranularity = "month",
}: BlockProps) {
  const TitleTag = titleAs;
  const [highlightedKey, setHighlightedKey] = useState<string | null>(null);
  const blockPlotted = useMemo(
    () => (trimLeadingInactive ? trimLeadingInactivePoints(block, includeAccumulatedLines) : block),
    [block, includeAccumulatedLines, trimLeadingInactive]
  );
  const series = useMemo(
    () => resolveLineSeriesColors(buildRawLineSeries(blockPlotted, includeAccumulatedLines), colorPlan),
    [blockPlotted, includeAccumulatedLines, colorPlan]
  );
  const yScale = useMemo(() => {
    const { min, max } = minMaxAcrossSeries(blockPlotted.points, series);
    if (yAxisMinZero) {
      return buildNiceYAxis(0, Math.max(max, 0));
    }
    return buildNiceYAxis(min, max);
  }, [blockPlotted.points, series, yAxisMinZero]);

  const xAxisTicks = useMemo(() => {
    const dates = extractSortedAsOfDates(blockPlotted.points);
    if (xAxisGranularity === "year") {
      return computeRegularYearXAxisTicks(dates);
    }
    return computeRegularMonthXAxisTicks(dates, { includeLastDataPoint: false });
  }, [blockPlotted.points, xAxisGranularity]);

  if (!blockPlotted.points.length || !series.length) {
    return (
      <div className="chart-grid__col">
        <TitleTag className="chart-panel-title">{title}</TitleTag>
        <p className="empty muted">Sin series de valorización para este período.</p>
      </div>
    );
  }

  const focusColorIndex =
    highlightedKey == null ? null : (series.find((x) => x.dataKey === highlightedKey)?.colorIndex ?? null);

  return (
    <div className="chart-grid__col">
      <TitleTag className="chart-panel-title">{title}</TitleTag>
      <div
        className="chart-box line-chart-focus-wrap"
        onPointerLeave={() => setHighlightedKey(null)}
      >
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={blockPlotted.points} margin={{ ...RECHARTS_MONEY_CHART_MARGIN }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#334155" opacity={0.35} />
            {yScale.showZeroReference ? (
              <ReferenceLine y={0} stroke={AXIS_LINE_STROKE} strokeWidth={1} />
            ) : null}
            <XAxis
              dataKey="as_of_date"
              type="category"
              {...(xAxisTicks ? { ticks: xAxisTicks } : {})}
              tick={{ fontSize: 11, fill: "#94a3b8" }}
              axisLine={{ stroke: AXIS_LINE_STROKE }}
              tickLine={{ stroke: AXIS_LINE_STROKE }}
              tickFormatter={(d: string) => formatLineChartXTick(String(d), xAxisGranularity)}
            />
            <YAxis
              domain={yScale.domain}
              ticks={yScale.ticks}
              tick={{ fontSize: 11, fill: "#94a3b8" }}
              axisLine={{ stroke: AXIS_LINE_STROKE }}
              tickLine={{ stroke: AXIS_LINE_STROKE }}
              tickFormatter={(v) => formatAxisValue(typeof v === "number" ? v : Number(v), displayUnit)}
              width={rechartsMoneyYAxisWidth(displayUnit)}
            />
            <Tooltip
              wrapperStyle={{ transform: "none", width: "100%", height: "100%" }}
              cursor={{ stroke: "rgba(148, 163, 184, 0.45)", strokeWidth: 1 }}
              content={(props) => (
                <LineTooltipBelowPlot
                  {...(props as TooltipProps<number, string>)}
                  displayUnit={displayUnit}
                  xAxisGranularity={xAxisGranularity}
                />
              )}
            />
            <Legend
              content={() => (
                <InteractiveLegend
                  series={series}
                  focusColorIndex={focusColorIndex}
                  onHighlight={setHighlightedKey}
                />
              )}
            />
            {(() => {
              const hitLines = series.map((s) => (
                <Line
                  key={`${s.dataKey}__hit`}
                  type="monotone"
                  dataKey={s.dataKey}
                  name={s.name}
                  stroke="transparent"
                  strokeOpacity={1}
                  strokeWidth={LINE_HIT_STROKE_WIDTH}
                  dot={false}
                  activeDot={false}
                  isAnimationActive={false}
                  connectNulls
                  legendType="none"
                  style={{ pointerEvents: "stroke" }}
                  onPointerEnter={() => setHighlightedKey(s.dataKey)}
                />
              ));
              const visLines = series.map((s) => {
                const stroke = s.stroke;
                const isDep = Boolean(s.isDeposit);
                const dimOthers = focusColorIndex != null && s.colorIndex !== focusColorIndex;
                const isThinDerivedLine =
                  (colorPlan?.kind === "dashboard-overview" && s.dataKey === "invested") ||
                  (colorPlan?.kind === "group-tab" &&
                    colorPlan.groupSlug === "liabilities" &&
                    (s.dataKey === "available" || s.dataKey === "all_available"));
                const baseW = isDep ? 1.15 : isThinDerivedLine ? 1.5 : thickKey && s.dataKey === thickKey ? 3 : 2;
                const baseOpacity = isDep
                  ? 0.8
                  : s.dataKey === "all_available"
                    ? 0.6
                    : isThinDerivedLine
                      ? 0.8
                      : 1;
                const strokeOpacity = dimOthers ? DIM_LINE_OPACITY : baseOpacity;
                const isHi = focusColorIndex != null && s.colorIndex === focusColorIndex;
                const strokeWidth = isHi ? Math.max(baseW * 1.35, baseW + 0.85) : baseW;
                return (
                  <Line
                    key={`${s.dataKey}__vis`}
                    type="monotone"
                    dataKey={s.dataKey}
                    name={s.name}
                    stroke={stroke}
                    strokeOpacity={strokeOpacity}
                    dot={false}
                    strokeWidth={strokeWidth}
                    style={{ pointerEvents: "none" }}
                    connectNulls
                    legendType={isDep ? "none" : "plainline"}
                    isAnimationActive
                    animationDuration={CHART_ANIM_MS}
                    animationEasing="ease-out"
                  />
                );
              });
              return [...hitLines, ...visLines];
            })()}
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

export interface PieSlice {
  name: string;
  value: number;
  account_id?: number;
}

interface PiePanelProps {
  title: string;
  slices: PieSlice[];
  displayUnit: ChartDisplayUnit;
  titleAs?: "h2" | "h3";
  /** When set, overrides default cycling fills (e.g. class-tab pie aligned with lines). */
  sliceFill?: (slice: PieSlice, index: number) => string;
}

export function AllocationPiePanel({ title, slices, displayUnit, titleAs = "h2", sliceFill }: PiePanelProps) {
  const TitleTag = titleAs;
  const pieData = slices.filter((s) => s.value > 0);
  if (pieData.length === 0) {
    return (
      <div className="chart-grid__col">
        <TitleTag className="chart-panel-title">{title}</TitleTag>
        <p className="empty muted">Sin valorizaciones recientes para armar el gráfico.</p>
      </div>
    );
  }
  return (
    <div className="chart-grid__col">
      <TitleTag className="chart-panel-title">{title}</TitleTag>
      <div className="chart-box">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart margin={{ top: 32, right: 4, left: 4, bottom: 0 }}>
            {/* Recharts Pie default animationBegin is 400ms; Line uses 0 — set begin 0 so pie and lines start together. */}
            <Pie
              data={pieData}
              dataKey="value"
              nameKey="name"
              cx="50%"
              cy="50%"
              outerRadius={100}
              label={(p: { value?: unknown }) => {
                const v = typeof p.value === "number" ? p.value : Number(p.value);
                return formatMoneyForPie(Number.isFinite(v) ? v : 0, displayUnit);
              }}
              isAnimationActive
              animationBegin={0}
              animationDuration={CHART_ANIM_MS}
              animationEasing="ease-out"
            >
              {pieData.map((slice, i) => (
                <Cell
                  key={i}
                  fill={sliceFill ? sliceFill(slice, i) : DEFAULT_LINE_COLORS[i % DEFAULT_LINE_COLORS.length]}
                />
              ))}
            </Pie>
            <Tooltip formatter={(v: number) => formatMoneyForPie(v, displayUnit)} />
            <Legend formatter={(value) => String(value ?? "")} />
          </PieChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

interface Props {
  displayUnit: ChartDisplayUnit;
  primaryTitle: string;
  primary: TimeseriesBlock;
  secondaryTitle: string;
  secondary: TimeseriesBlock;
  /** e.g. total_nw on dashboard overview */
  thickLineDataKey?: string;
  /** When false, line charts show valuations only (no “aportes acum.”). */
  includeAccumulatedLines?: boolean;
  /** When false, do not trim leading zero months (rare). Default true. */
  trimLeadingInactive?: boolean;
  primaryColorPlan?: ChartColorPlan;
  secondaryColorPlan?: ChartColorPlan;
  /** Dashboard yearly rollup: X-axis shows calendar year. */
  xAxisGranularity?: "month" | "year";
}

export function ValuationLineCharts({
  displayUnit,
  primaryTitle,
  primary,
  secondaryTitle,
  secondary,
  thickLineDataKey,
  includeAccumulatedLines = true,
  trimLeadingInactive = true,
  primaryColorPlan,
  secondaryColorPlan,
  xAxisGranularity = "month",
}: Props) {
  return (
    <div className="chart-grid">
      <LineChartPanel
        title={primaryTitle}
        block={primary}
        displayUnit={displayUnit}
        includeAccumulatedLines={includeAccumulatedLines}
        trimLeadingInactive={trimLeadingInactive}
        colorPlan={primaryColorPlan}
        xAxisGranularity={xAxisGranularity}
      />
      <LineChartPanel
        title={secondaryTitle}
        block={secondary}
        displayUnit={displayUnit}
        thickKey={thickLineDataKey}
        includeAccumulatedLines={includeAccumulatedLines}
        trimLeadingInactive={trimLeadingInactive}
        colorPlan={secondaryColorPlan}
        xAxisGranularity={xAxisGranularity}
      />
    </div>
  );
}
