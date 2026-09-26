import { useMemo } from "react";
import { Bar, Legend, Line, XAxis, YAxis } from "recharts";
import { chileTodayYmd } from "../../calendarMonth";
import { useTranslation } from "../../i18n";
import type { CcHistorialChartPoint as CcHistorialChartRow } from "../../types";
import { rollupCcHistorialChartYearly } from "../../ccYearlyRollup";
import { formatClp, formatUsdFine } from "../../format";
import { AppComposedChart } from "./AppComposedChart";
import { athTooltipIndexTolerance } from "./athMarkerPlacement";
import { renderPeriodRefLine } from "./PeriodRefLine";
import {
  buildNiceYAxis,
  computeRegularMonthXAxisTicks,
  formatLineChartXTick,
  RECHARTS_MONEY_CHART_MARGIN,
  moneyYAxisProps,
  AXIS_LINE_STROKE as AXIS_STROKE,
} from "./chartLayout";
import { useIsNarrowViewport } from "../../useIsNarrowViewport";

function formatYmEs(ym: string): string {
  const [ys, ms] = ym.split("-");
  const m = Number(ms);
  const names = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
  const label = m >= 1 && m <= 12 ? names[m - 1] : ym;
  return `${label} ${ys}`;
}

const CUPO_STROKE = "#f472b6";
const BALANCE_TOTAL_STROKE = "#38bdf8";

/**
 * The stacked facturación bar, bottom to top (one amber hue, the cuotas its darkest shade); the
 * tooltip lists it top to bottom, like the chart reads.
 */
const BAR_SEGMENTS = [
  {
    dataKey: "facturado_rest_clp",
    labelKey: "accountDetail.creditCard.chartFacturadoClp",
    fill: "#d97706",
  },
  {
    dataKey: "facturado_cuotas_clp",
    labelKey: "accountDetail.creditCard.chartFacturadoCuotasClp",
    fill: "#a14e10",
  },
  {
    dataKey: "facturado_usd_clp",
    labelKey: "accountDetail.creditCard.chartFacturadoUsd",
    fill: "#fbbf24",
  },
] as const;

function unifiedMinMax(points: CcHistorialChartRow[]) {
  let minV = 0;
  let maxV = 0;
  for (const row of points) {
    // Credit-card balances are debts (≥ 0); a rare negative month is an artifact, so the lines
    // never stretch the axis below zero for a single outlier.
    for (const v of [row.cupo_en_cuotas_clp, row.balance_total_clp]) {
      if (typeof v === "number" && Number.isFinite(v)) maxV = Math.max(maxV, v);
    }
    // stackOffset="sign": positive segments stack above zero, a negative one (a month whose
    // credits outweighed its únicos) below — real data, so the axis reaches it.
    let up = 0;
    let down = 0;
    for (const v of [row.facturado_cuotas_clp, row.facturado_rest_clp, row.facturado_usd_clp]) {
      if (typeof v !== "number" || !Number.isFinite(v)) continue;
      if (v >= 0) up += v;
      else down += v;
    }
    maxV = Math.max(maxV, up);
    minV = Math.min(minV, down);
  }
  return { min: minV, max: Math.max(maxV, 1) };
}

/** Day-mode bar width: a day's band is a fraction of a pixel at wide ranges. */
const DAILY_BAR_PX = 6;

type BarShapeProps = { x?: number; y?: number; width?: number; height?: number; fill?: string };

/**
 * Day mode: each segment drawn at a fixed width centred on its day. Recharts shrinks a fixed
 * `barSize` to the category band, which at 3a is under a pixel. Recharts calls the shape for
 * every day, bar or not — an empty day draws nothing (its stroked zero-height rect would paint
 * the gap colour along the baseline).
 */
function DailyBarSegment({ x = 0, y = 0, width = 0, height = 0, fill }: BarShapeProps) {
  if (height === 0) return null;
  return (
    <rect
      className="recharts-rectangle"
      x={x + width / 2 - DAILY_BAR_PX / 2}
      y={Math.min(y, y + height)}
      width={DAILY_BAR_PX}
      height={Math.abs(height)}
      fill={fill}
    />
  );
}

export function CcInstallmentHistoryChart({
  rows,
  openBillingMonth,
  dailyRows,
  period,
}: {
  rows: CcHistorialChartRow[];
  openBillingMonth?: string | null;
  /** Day-period rows (`month` = ISO date): the lines, with each facturación's bar on its close day. */
  dailyRows?: CcHistorialChartRow[] | null;
  /** Per-surface período (from the page's paired CC control). */
  period: "day" | "month" | "year";
}) {
  const { t } = useTranslation();
  const compactAxis = useIsNarrowViewport();
  const isYearly = period === "year";
  const isDailyMode = period === "day" && (dailyRows?.length ?? 0) > 0;
  const displayRows = useMemo(
    () => (isDailyMode ? dailyRows! : isYearly ? rollupCcHistorialChartYearly(rows) : rows),
    [rows, isYearly, isDailyMode, dailyRows]
  );
  const dayTicks = useMemo(
    () =>
      isDailyMode
        ? computeRegularMonthXAxisTicks(
            displayRows.map((r) => r.month),
            { includeLastDataPoint: false }
          )
        : undefined,
    [isDailyMode, displayRows]
  );
  // Day mode: a bar is a few pixels on a sub-pixel day grid, so the tooltip lists the bars within
  // a dozen pixels of cursor travel, not just the hovered day's.
  const dailyBarLookup = useMemo(() => {
    if (!isDailyMode) return null;
    const indexByDay = new Map(displayRows.map((r, i) => [r.month, i] as const));
    const barIndices = displayRows.flatMap((r, i) => (r.facturado_total_clp != null ? [i] : []));
    return { indexByDay, barIndices, tolerance: athTooltipIndexTolerance(displayRows.length) };
  }, [isDailyMode, displayRows]);
  const periodLabel = (ym: string) =>
    isDailyMode ? ym : isYearly ? ym.slice(0, 4) : formatYmEs(ym);
  const currentYm = chileTodayYmd().slice(0, 7);
  // Yearly buckets are keyed YYYY-12, so the marker lands on the year containing the ref month.
  const refMonth = isYearly
    ? `${(openBillingMonth ?? currentYm).slice(0, 4)}-12`
    : openBillingMonth ?? currentYm;
  // Either marker hides when its x is the LAST plotted point — a line hugging the right edge
  // conveys nothing; it only informs when future (projected) buckets extend the axis past it.
  const lastX = displayRows.length > 0 ? displayRows[displayRows.length - 1].month : null;
  const showCurrentMonthLine =
    !isDailyMode && refMonth !== lastX && displayRows.some((r) => r.month === refMonth);
  // Daily view: mark today, where the real owed walk ends and the plan projection begins.
  const todayYmd = chileTodayYmd();
  const showDailyTodayLine =
    isDailyMode && todayYmd !== lastX && displayRows.some((r) => r.month === todayYmd);
  const yScale = useMemo(() => {
    const { min, max } = unifiedMinMax(displayRows);
    return buildNiceYAxis(min, max);
  }, [displayRows]);

  if (rows.length === 0) {
    return <p className="muted empty">{t("accountDetail.creditCard.historialEmpty")}</p>;
  }

  const tooltipBars = (label: string, row: CcHistorialChartRow): CcHistorialChartRow[] => {
    if (!dailyBarLookup) return row.facturado_total_clp != null ? [row] : [];
    const at = dailyBarLookup.indexByDay.get(label);
    if (at == null) return [];
    return dailyBarLookup.barIndices
      .filter((i) => Math.abs(i - at) <= dailyBarLookup.tolerance)
      .map((i) => displayRows[i]!);
  };

  // The total, then its segments top to bottom as the stack reads.
  const renderBarLines = (bar: CcHistorialChartRow) => (
    <>
      <div>
        {t("accountDetail.creditCard.colTotalFacturado")}:{" "}
        {bar.facturado_total_clp != null ? formatClp(bar.facturado_total_clp) : "—"}
      </div>
      <div style={{ paddingLeft: 12 }}>
        {bar.facturado_usd_clp != null ? (
          <div>
            {t("accountDetail.creditCard.chartFacturadoUsd")}:{" "}
            {bar.facturado_usd != null
              ? `${formatUsdFine(bar.facturado_usd)} (${formatClp(bar.facturado_usd_clp)})`
              : formatClp(bar.facturado_usd_clp)}
          </div>
        ) : null}
        {bar.facturado_cuotas_clp != null ? (
          <div>
            {t("accountDetail.creditCard.chartFacturadoCuotasClp")}: {formatClp(bar.facturado_cuotas_clp)}
          </div>
        ) : null}
        {bar.facturado_rest_clp != null ? (
          <div>
            {t("accountDetail.creditCard.chartFacturadoClp")}: {formatClp(bar.facturado_rest_clp)}
          </div>
        ) : null}
      </div>
    </>
  );

  return (
    <div className="chart-box line-chart-focus-wrap" style={{ height: 280, marginTop: "0.35rem" }}>
        <AppComposedChart
          data={displayRows}
          margin={{ ...RECHARTS_MONEY_CHART_MARGIN, left: 4, right: 8, bottom: 4 }}
          stackOffset="sign"
          tooltip={{
            formatValue: (v) => formatClp(v),
            renderContent: ({ label, payload }) => {
              const d = payload[0]?.payload as CcHistorialChartRow | undefined;
              if (!d) return null;
              const bars = tooltipBars(String(label), d);
              return (
                <div style={{ fontSize: 12 }}>
                  <div style={{ marginBottom: 6, fontWeight: 600 }}>{periodLabel(String(label))}</div>
                  <div>
                    {t("accountDetail.creditCard.saldoTotal")}:{" "}
                    {d.balance_total_clp != null ? formatClp(d.balance_total_clp) : "—"}
                  </div>
                  <div>
                    {t("accountDetail.creditCard.colCupoEnCuotas")}:{" "}
                    {d.cupo_en_cuotas_clp != null ? formatClp(d.cupo_en_cuotas_clp) : "—"}
                  </div>
                  {bars.map((bar) => (
                    <div key={bar.month} style={{ marginTop: 6 }}>
                      {isDailyMode ? (
                        <div style={{ fontWeight: 600 }}>
                          {t("accountDetail.creditCard.tooltipCloseOn", { date: bar.month })}
                        </div>
                      ) : null}
                      {renderBarLines(bar)}
                    </div>
                  ))}
                </div>
              );
            },
            cursor: true,
          }}
        >
          <XAxis
            dataKey="month"
            type="category"
            tick={{ fontSize: 10, fill: "#94a3b8" }}
            tickFormatter={(ym: string) =>
              isDailyMode ? formatLineChartXTick(String(ym), "day") : periodLabel(String(ym))
            }
            axisLine={{ stroke: AXIS_STROKE }}
            tickLine={{ stroke: AXIS_STROKE }}
            {...(isDailyMode ? { ticks: dayTicks } : { interval: "preserveStartEnd" as const })}
          />
          <YAxis
            domain={yScale.domain}
            ticks={yScale.ticks}
            {...moneyYAxisProps("clp", compactAxis)}
          />
          <Legend
            wrapperStyle={{ fontSize: 12, color: "var(--muted, #94a3b8)", paddingTop: 6 }}
            formatter={(value) => <span style={{ color: "var(--muted, #94a3b8)" }}>{value}</span>}
          />
          {showCurrentMonthLine
            ? renderPeriodRefLine({
                x: refMonth,
                label: t(
                  isYearly
                    ? "accountDetail.creditCard.historialCurrentYear"
                    : openBillingMonth
                      ? "accountDetail.creditCard.historialOpenMonth"
                      : "accountDetail.creditCard.historialCurrentMonth"
                ),
              })
            : null}
          {showDailyTodayLine
            ? renderPeriodRefLine({
                x: todayYmd,
                label: t("accountDetail.creditCard.historialProjectionStart"),
              })
            : null}
          {BAR_SEGMENTS.map((segment) => (
            <Bar
              key={segment.dataKey}
              dataKey={segment.dataKey}
              name={t(segment.labelKey)}
              fill={segment.fill}
              stackId="facturado"
              className="cc-facturado-segment"
              {...(isDailyMode
                ? { shape: (props: BarShapeProps) => <DailyBarSegment {...props} /> }
                : { maxBarSize: 32 })}
            />
          ))}
          <Line
            type="monotone"
            dataKey="cupo_en_cuotas_clp"
            name={t("accountDetail.creditCard.colCupoEnCuotas")}
            stroke={CUPO_STROKE}
            strokeWidth={2}
            dot={isDailyMode ? false : { r: 2.5, fill: CUPO_STROKE }}
            connectNulls
          />
          <Line
            type="monotone"
            dataKey="balance_total_clp"
            name={t("accountDetail.creditCard.saldoTotal")}
            stroke={BALANCE_TOTAL_STROKE}
            strokeWidth={2}
            dot={isDailyMode ? false : { r: 2.5, fill: BALANCE_TOTAL_STROKE }}
            connectNulls
          />
        </AppComposedChart>
    </div>
  );
}
