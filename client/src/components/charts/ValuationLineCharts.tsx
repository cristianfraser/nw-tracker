import { CartesianGrid, Legend, Line, ReferenceLine, XAxis, YAxis } from "recharts";
import { useMemo, useState, type MouseEvent as ReactMouseEvent } from "react";
import { formatMoneyForPie } from "../../format";
import i18n from "../../i18n";
import type { ChartColorPlan, LineSeriesColorInput, ResolvedLineSeriesItem } from "../../chartColors";
import { DEFAULT_LINE_COLORS, resolveLineSeriesColors } from "../../chartColors";
import { GROUP_TAB_DEP_TOTAL } from "../../groupTabAggregation";
import type { TimeseriesBlock } from "../../types";
import { clipChartDataToYDomain } from "../../chartTailClip";
import { AppLineChart } from "./AppLineChart";
import { AllocationPie } from "./AllocationPie";
import { densifyRecordsByCalendarPeriod } from "../../chartDensifyTimeSeries";
import { chileTodayYmd } from "../../calendarMonth";
import {
  coerceKeptTrailingZeroMonth,
  prependInitialZeroAnchorsOnBlock,
  valuationDataKeysForInitialZeroAnchors,
} from "../../chartSeriesInitialZeroAnchors";
import {
  AXIS_LINE_STROKE,
  buildNiceYAxis,
  buildNiceYAxisPositiveBand,
  CHART_ANIM_MS,
  CHART_TICK_STYLE,
  computeRegularMonthXAxisTicks,
  computeRegularYearXAxisTicks,
  extractSortedAsOfDates,
  formatAxisValue,
  formatLineChartXTick,
  formatTooltipValue,
  minMaxForKeys,
  RECHARTS_MONEY_CHART_MARGIN,
  rechartsMoneyYAxisWidth,
  DIM_LEGEND_OPACITY,
  type ChartDisplayUnit,
} from "./chartLayout";
import {
  ChartTooltipRows,
  dedupeTooltipPayloadPreferVisibleStroke,
  tooltipColorIsVisible,
  type AppTooltipSpec,
} from "./ChartTooltip";

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
 *
 * **Deposits vs valuations:** When cumulative deposit lines exist (`depositKeys` non-empty), we still break as soon
 * as **either** a deposit or a valuation is positive. Otherwise a class like Cash & equivalents would hide years of
 * checking / ahorro balances until the first Reserva “aportes” month.
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
    if (depPositive || valPositive) break;
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
    const prevActive = prevDep || prevVal;
    if (prevActive) start = i - 1;
  }
  return { ...block, points: points.slice(start) };
}


/** Clear line focus when the pointer leaves a hit target, unless it moves to another hit line. */
function clearLineHighlightUnlessMovingToHitLine(e: ReactMouseEvent, clear: () => void) {
  const related = e.relatedTarget;
  if (related instanceof Element && related.closest(".line-chart-hit-target")) return;
  clear();
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
  /** When true, Y scale is anchored at 0. Default: padded band from data min/max. */
  yAxisMinZero?: boolean;
  /** X-axis tick labels: calendar year, month+year, or daily sessions (ISO tooltip titles). */
  xAxisGranularity?: "month" | "year" | "day";
  /** When set, Y-axis min/max uses only these series (others may render off-scale). */
  yScaleDataKeys?: readonly string[];
}

/** Invisible underlay stroke width — wide hit target (`pointer-events: stroke`). */
const LINE_HIT_STROKE_WIDTH = 24;

/** When a series is focused (line or legend), other lines fade to this opacity. */
const DIM_LINE_OPACITY = 0.16;

/** Docked-tooltip rows with legend focus dim (value + aportes of the focused account stay bright). */
function lineSeriesTooltipRenderContent({
  displayUnit,
  xAxisGranularity,
  focusColorIndex,
  seriesByDataKey,
}: {
  displayUnit: ChartDisplayUnit;
  xAxisGranularity: "month" | "year" | "day";
  focusColorIndex: number | null;
  seriesByDataKey: ReadonlyMap<string, ResolvedLineSeriesItem>;
}): NonNullable<AppTooltipSpec["renderContent"]> {
  return ({ label, payload }) => {
    const dim = focusColorIndex != null;
    const fmt = (raw: unknown): string => {
      const v = typeof raw === "number" ? raw : raw == null ? Number.NaN : Number(raw);
      return Number.isFinite(v) ? formatTooltipValue(v, displayUnit) : "—";
    };
    // Merge each aportes-acum. companion into its account's row — one line per account:
    // `cuenta : TOTAL (acumulado)`, the acumulado dimmer. Companions whose value series is
    // absent from this payload keep their own row.
    const subValueByParentKey = new Map<string, string>();
    const mainEntries: typeof payload = [];
    for (const entry of payload) {
      const dataKey = String(entry.dataKey ?? "");
      const parentKey = seriesByDataKey.get(dataKey)?.depositFor;
      if (parentKey && payload.some((p) => String(p.dataKey ?? "") === parentKey)) {
        // Wrapper parens carry the "companion" meaning, so a negative acumulado uses an
        // explicit minus — accounting-style `($…)` inside `(…)` would make positive and
        // negative aportes indistinguishable.
        const raw = entry.value;
        const v = typeof raw === "number" ? raw : raw == null ? Number.NaN : Number(raw);
        const inner = !Number.isFinite(v) ? "—" : v < 0 ? `-${fmt(Math.abs(v))}` : fmt(v);
        subValueByParentKey.set(parentKey, `(${inner})`);
        continue;
      }
      mainEntries.push(entry);
    }
    const rows = mainEntries.map((entry) => {
      const dataKey = String(entry.dataKey ?? "");
      const meta = seriesByDataKey.get(dataKey);
      const isHi = focusColorIndex != null && meta?.colorIndex === focusColorIndex;
      return {
        key: dataKey,
        name: String(entry.name ?? meta?.name ?? dataKey),
        value: fmt(entry.value),
        subValue: subValueByParentKey.get(dataKey),
        swatchColor: tooltipColorIsVisible(entry.color) ? String(entry.color) : (meta?.stroke ?? "#94a3b8"),
        dim: dim && !isHi,
        emphasized: isHi,
      };
    });
    // Day view: the point IS a calendar day — title with the ISO date (repo date convention).
    const title =
      xAxisGranularity === "day"
        ? String(label)
        : formatLineChartXTick(String(label), xAxisGranularity);
    return <ChartTooltipRows title={title} rows={rows} />;
  };
}

function buildRawLineSeries(block: TimeseriesBlock, includeAccumulatedLines: boolean): LineSeriesColorInput[] {
  const raw: LineSeriesColorInput[] = [];
  if (block.accounts?.length) {
    block.accounts.forEach((a, i) => {
      raw.push({
        dataKey: a.dataKey,
        name: a.name_i18n_key ? i18n.t(a.name_i18n_key) : a.name,
        colorIndex: i,
        color_rgb: a.color_rgb,
      });
      if (includeAccumulatedLines && a.depositDataKey) {
        const depName =
          a.depositDataKey === GROUP_TAB_DEP_TOTAL
            ? i18n.t("charts.groupAccumulatedDeposits")
            : a.deposit_series_name?.trim() || i18n.t("charts.accumulatedDeposits");
        raw.push({
          dataKey: a.depositDataKey,
          name: depName,
          colorIndex: i,
          isDeposit: true,
          depositFor: a.dataKey,
        });
      }
    });
  }
  const seenDataKeys = new Set(raw.map((r) => r.dataKey));
  const nAccounts = block.accounts?.length ?? 0;
  for (let j = 0; j < (block.lines?.length ?? 0); j++) {
    const ln = block.lines![j]!;
    if (seenDataKeys.has(ln.dataKey)) continue;
    seenDataKeys.add(ln.dataKey);
    raw.push({
      dataKey: ln.dataKey,
      name: ln.name,
      colorIndex: nAccounts + j,
      color_rgb: ln.color_rgb,
      isReferenceOverlay: ln.valueSeriesType === "reference",
    });
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
        alignContent: "flex-start",
        rowGap: 12,
        columnGap: 20,
        paddingTop: 14,
        paddingBottom: 10,
        fontSize: 12,
        lineHeight: 1.35,
        color: "var(--muted, #94a3b8)",
      }}
    >
      {visible.map((s) => {
        const color = s.stroke;
        const isHi = focusColorIndex != null && s.colorIndex === focusColorIndex;
        const faded = dim && !isHi;
        const isDerivedDash =
          s.dataKey === "invested" ||
          s.dataKey === "available" ||
          s.dataKey === "all_available" ||
          s.dataKey.startsWith("ref:");
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
                opacity={
                  faded
                    ? 0.5
                    : s.dataKey === "all_available" || s.dataKey.includes("disponible_total")
                      ? 0.6
                      : isDerivedDash
                        ? 0.8
                        : 1
                }
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
  yScaleDataKeys,
}: BlockProps) {
  const TitleTag = titleAs;
  const [highlightedKey, setHighlightedKey] = useState<string | null>(null);
  const blockPlotted = useMemo(
    () => (trimLeadingInactive ? trimLeadingInactivePoints(block, includeAccumulatedLines) : block),
    [block, includeAccumulatedLines, trimLeadingInactive]
  );
  const blockWithAnchors = useMemo(
    () => prependInitialZeroAnchorsOnBlock(blockPlotted, xAxisGranularity),
    [blockPlotted, xAxisGranularity]
  );
  const valuationKeys = useMemo(
    () => valuationDataKeysForInitialZeroAnchors(blockWithAnchors),
    [blockWithAnchors]
  );
  // Tail clip lives in the server payload build (`timeseriesTailClip.ts`): sold-out series
  // arrive pre-nulled and `chart_end_ymd` bounds the x-axis when everything ends early.
  const chartData = useMemo(() => {
    const densified = densifyRecordsByCalendarPeriod(blockWithAnchors.points, {
      granularity: xAxisGranularity,
      dateKey: "as_of_date",
      fillMissing: "null_all",
      extendThroughYmd: block.chart_end_ymd ?? chileTodayYmd(),
    });
    return coerceKeptTrailingZeroMonth(densified, valuationKeys);
  }, [blockWithAnchors.points, xAxisGranularity, valuationKeys, block.chart_end_ymd]);
  const series = useMemo(
    () => resolveLineSeriesColors(buildRawLineSeries(blockWithAnchors, includeAccumulatedLines), colorPlan),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- i18n.language: bucket/deposit labels translate at render (no cached t()).
    [blockWithAnchors, includeAccumulatedLines, colorPlan, i18n.language]
  );

  const seriesByDataKey = useMemo(
    () => new Map(series.map((s) => [s.dataKey, s] as const)),
    [series]
  );

  const tailClippedKeys = block.tail_clipped_keys;

  const yScale = useMemo(() => {
    const scaleSeries =
      yScaleDataKeys?.length && yScaleDataKeys.length > 0
        ? series.filter((s) => yScaleDataKeys.includes(s.dataKey))
        : series;
    const { min, max } = minMaxForKeys(chartData, scaleSeries.map((s) => s.dataKey));
    if (yAxisMinZero) {
      return buildNiceYAxis(0, Math.max(max, 0));
    }
    if (min >= 0 && max >= 0) {
      const band = buildNiceYAxisPositiveBand(min, max);
      return {
        ...band,
        showZeroReference: band.domain[0] === 0 && band.domain[1] > 0,
      };
    }
    return buildNiceYAxis(min, max);
  }, [chartData, series, yAxisMinZero, yScaleDataKeys]);

  const clipPlotToYDomain = Boolean(yScaleDataKeys?.length);
  const lineCurveType = clipPlotToYDomain ? "linear" : "monotone";

  const plotChartData = useMemo(() => {
    if (!clipPlotToYDomain) return chartData;
    return clipChartDataToYDomain(
      chartData,
      series.map((s) => s.dataKey),
      yScale.domain
    );
  }, [chartData, series, yScale.domain, clipPlotToYDomain]);

  const xAxisTicks = useMemo(() => {
    const dates = extractSortedAsOfDates(chartData);
    if (xAxisGranularity === "year") {
      return computeRegularYearXAxisTicks(dates);
    }
    return computeRegularMonthXAxisTicks(dates, { includeLastDataPoint: false });
  }, [chartData, xAxisGranularity]);

  if (!chartData.length || !series.length) {
    return (
      <div className="chart-grid__col">
        <TitleTag className="chart-panel-title">{title}</TitleTag>
        <p className="empty muted">{i18n.t("charts.noValuationSeries")}</p>
      </div>
    );
  }

  const focusColorIndex =
    highlightedKey == null ? null : (series.find((x) => x.dataKey === highlightedKey)?.colorIndex ?? null);

  const chartMargin = RECHARTS_MONEY_CHART_MARGIN;

  return (
    <div className="chart-grid__col">
      <TitleTag className="chart-panel-title">{title}</TitleTag>
      <div
        className="chart-box line-chart-focus-wrap"
        onPointerLeave={() => setHighlightedKey(null)}
      >
        <AppLineChart
          data={plotChartData}
          tailClippedKeys={tailClippedKeys}
          margin={chartMargin}
          tooltip={{
            formatValue: (v) => formatTooltipValue(v, displayUnit),
            mapPayload: dedupeTooltipPayloadPreferVisibleStroke,
            renderContent: lineSeriesTooltipRenderContent({
              displayUnit,
              xAxisGranularity,
              focusColorIndex,
              seriesByDataKey,
            }),
          }}
        >
            <CartesianGrid strokeDasharray="3 3" stroke="#334155" opacity={0.35} />
            {yScale.showZeroReference ? (
              <ReferenceLine y={0} stroke={AXIS_LINE_STROKE} strokeWidth={1} />
            ) : null}
            <XAxis
              dataKey="as_of_date"
              type="category"
              {...(xAxisTicks ? { ticks: xAxisTicks } : {})}
              tick={CHART_TICK_STYLE}
              axisLine={{ stroke: AXIS_LINE_STROKE }}
              tickLine={{ stroke: AXIS_LINE_STROKE }}
              tickFormatter={(d: string) => formatLineChartXTick(String(d), xAxisGranularity)}
            />
            <YAxis
              domain={yScale.domain}
              ticks={yScale.ticks}
              allowDataOverflow={!clipPlotToYDomain}
              tick={CHART_TICK_STYLE}
              axisLine={{ stroke: AXIS_LINE_STROKE }}
              tickLine={{ stroke: AXIS_LINE_STROKE }}
              tickFormatter={(v) => formatAxisValue(typeof v === "number" ? v : Number(v), displayUnit)}
              width={rechartsMoneyYAxisWidth(displayUnit)}
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
                  type={lineCurveType}
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
                  className="line-chart-hit-target"
                  style={{ pointerEvents: "stroke" }}
                  onPointerEnter={() => setHighlightedKey(s.dataKey)}
                  onMouseLeave={(_curve, e) => {
                    if (e) {
                      clearLineHighlightUnlessMovingToHitLine(e, () => setHighlightedKey(null));
                    } else {
                      setHighlightedKey(null);
                    }
                  }}
                />
              ));
              const visLines = series.map((s) => {
                const stroke = s.stroke;
                const isDep = Boolean(s.isDeposit);
                const dimOthers = focusColorIndex != null && s.colorIndex !== focusColorIndex;
                const isLiquidityRefLine =
                  colorPlan?.kind === "group-tab" &&
                  colorPlan.groupSlug === "liabilities" &&
                  (s.dataKey === "available" ||
                    s.dataKey === "all_available" ||
                    s.dataKey.startsWith("ref:"));
                const isThinDerivedLine =
                  (colorPlan?.kind === "dashboard-overview" && s.dataKey === "invested") ||
                  isLiquidityRefLine;
                const isRefOverlay = Boolean(s.isReferenceOverlay);
                const baseW = isDep
                  ? 1.15
                  : isRefOverlay
                    ? 1.25
                    : isThinDerivedLine
                      ? 1.5
                      : thickKey && s.dataKey === thickKey
                        ? 3
                        : 2;
                const baseOpacity = isDep
                  ? 0.8
                  : isRefOverlay
                    ? 0.55
                    : s.dataKey === "all_available" || s.dataKey.includes("disponible_total")
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
                    type={lineCurveType}
                    dataKey={s.dataKey}
                    name={s.name}
                    stroke={stroke}
                    strokeOpacity={strokeOpacity}
                    dot={false}
                    strokeWidth={strokeWidth}
                    style={{ pointerEvents: "none" }}
                    connectNulls
                    legendType={isDep ? "none" : "plainline"}
                    strokeDasharray={isRefOverlay ? "6 4" : undefined}
                    isAnimationActive
                    animationDuration={CHART_ANIM_MS}
                    animationEasing="ease-out"
                  />
                );
              });
              return [...hitLines, ...visLines];
            })()}
        </AppLineChart>
      </div>
    </div>
  );
}

export interface PieSlice {
  name: string;
  value: number;
  account_id?: number;
  /** i18n key for server-grouped bucket slices; resolved at render (falls back to `name`). */
  name_i18n_key?: string | null;
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
  const pieData = slices
    .filter((s) => s.value > 0)
    .map((s) => (s.name_i18n_key ? { ...s, name: i18n.t(s.name_i18n_key) } : s));
  if (pieData.length === 0) {
    return (
      <div className="chart-grid__col">
        <TitleTag className="chart-panel-title">{title}</TitleTag>
        <p className="empty muted">{i18n.t("charts.noRecentValuations")}</p>
      </div>
    );
  }
  return (
    <div className="chart-grid__col">
      <TitleTag className="chart-panel-title">{title}</TitleTag>
      <div className="chart-box">
        <AllocationPie
          slices={pieData}
          fill={(slice, i) =>
            sliceFill ? sliceFill(slice, i) : DEFAULT_LINE_COLORS[i % DEFAULT_LINE_COLORS.length]!
          }
          formatValue={(v) => formatMoneyForPie(v, displayUnit)}
        />
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
  xAxisGranularity?: "month" | "year" | "day";
  /** Override for the primary panel only (daily overview keeps the secondary monthly). */
  primaryXAxisGranularity?: "month" | "year" | "day";
  /**
   * `fullWidthStack`: one chart per row (full width). Default `twoColumn` matches legacy side-by-side on wide viewports.
   */
  chartLayout?: "twoColumn" | "fullWidthStack";
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
  primaryXAxisGranularity,
  chartLayout = "twoColumn",
}: Props) {
  const gridClass =
    chartLayout === "fullWidthStack" ? "chart-grid chart-grid--full-width-stack" : "chart-grid";
  return (
    <div className={gridClass}>
      <LineChartPanel
        title={primaryTitle}
        block={primary}
        displayUnit={displayUnit}
        thickKey={thickLineDataKey}
        includeAccumulatedLines={includeAccumulatedLines}
        trimLeadingInactive={trimLeadingInactive}
        colorPlan={primaryColorPlan}
        xAxisGranularity={primaryXAxisGranularity ?? xAxisGranularity}
      />
      <LineChartPanel
        title={secondaryTitle}
        block={secondary}
        displayUnit={displayUnit}
        includeAccumulatedLines={includeAccumulatedLines}
        trimLeadingInactive={trimLeadingInactive}
        colorPlan={secondaryColorPlan}
        xAxisGranularity={xAxisGranularity}
      />
    </div>
  );
}
