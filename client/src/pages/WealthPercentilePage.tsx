import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "../cn";
import { PageGridTile } from "../components/layout/PageGridTile";
import { WealthPercentileChart } from "../components/charts/WealthPercentileChart";
import { ChartEmptyState } from "../components/charts/ChartEmptyState";
import { ChartPanelTitleRow } from "../components/charts/ChartPanelTitleRow";
import { minMaxForKeys } from "../components/charts/chartLayout";
import { percentileLogAxisFor, topPercentOf } from "../components/charts/percentileLogAxis";
import { Loadable, loadableClass } from "../components/ui/Loadable";
import { WealthTodayRail } from "../components/wealth/WealthTodayRail";
import { WealthYearList } from "../components/wealth/WealthYearList";
import {
  BENCHMARK_COUNTRIES,
  BENCHMARK_STROKE,
  CL_FINANCIAL_STROKE,
  CL_TOTAL_STROKE,
  percentileLabel,
} from "../components/wealth/wealthSeries";
import styles from "../components/wealth/WealthPercentile.module.css";
import { useDisplayPreferences } from "../context/DisplayPreferencesContext";
import { formatCurrency, formatGroupedDecimal } from "../format";
import { useWealthPercentile } from "../queries/hooks";
import type { WealthBenchmarkCountry } from "../types";
import { queryLoadError, queryShowsLoading } from "../queries/pageShapeReady";
import bandStyles from "./accountDetail/PositionAccountDetailPage.module.css";

/** Benchmarks shown out of the box; the rail's buttons toggle the full list. */
const DEFAULT_ENABLED_BENCHMARKS: readonly WealthBenchmarkCountry[] = ["US", "AU", "DE", "MX"];

const ENABLED_BENCHMARKS_STORAGE_KEY = "nw-tracker.wealth-percentile.countries";

function loadEnabledBenchmarks(): WealthBenchmarkCountry[] {
  try {
    const raw = localStorage.getItem(ENABLED_BENCHMARKS_STORAGE_KEY);
    if (!raw) return [...DEFAULT_ENABLED_BENCHMARKS];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [...DEFAULT_ENABLED_BENCHMARKS];
    return BENCHMARK_COUNTRIES.filter((c) => (parsed as string[]).includes(c));
  } catch {
    return [...DEFAULT_ENABLED_BENCHMARKS];
  }
}

/** A figure not in yet: its box, no text. */
const BLANK = "\u00a0";

type ScaleMode = "linear" | "log";
const SCALE_MODES: readonly ScaleMode[] = ["log", "linear"];

const SCALE_STORAGE_KEY = "nw-tracker.wealth-percentile.scale";

function loadScaleMode(): ScaleMode {
  try {
    return localStorage.getItem(SCALE_STORAGE_KEY) === "linear" ? "linear" : "log";
  } catch {
    return "log";
  }
}

/** A viewer's choice kept for the next visit; where storage is blocked it lasts the visit. */
function remember(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Storage unavailable: the choice stays in this page's state.
  }
}

/**
 * /wealth-percentile: the position page's title line (today's percentile in Chile as the figure)
 * and band — the chart of every line by year beside the rail, which is the chart's legend
 * (today's standing per line) and holds the benchmark-country buttons — over the year list
 * (`WealthYearList`), whose rows open into the year's thresholds. One column below 880, in DOM
 * order. Headline, row order, country order and the words for each year's distribution are the
 * server's; the page only picks the countries switched on.
 */
export function WealthPercentilePage() {
  const { t } = useTranslation();
  const [scaleMode, setScaleMode] = useState<ScaleMode>(loadScaleMode);
  const [enabledBenchmarks, setEnabledBenchmarks] = useState<WealthBenchmarkCountry[]>(
    loadEnabledBenchmarks
  );
  // null = the viewer has not touched a row yet: the newest year is open.
  const [openYearsChoice, setOpenYearsChoice] = useState<ReadonlySet<number> | null>(null);
  const { displayUnit } = useDisplayPreferences();
  const wealthQuery = useWealthPercentile(displayUnit);
  const { data, error: queryError } = wealthQuery;
  const error = queryLoadError({ data, error: queryError });
  // Dim while nothing has loaded or the previous unit's payload is held (shown in its own unit).
  const loading = queryShowsLoading(wealthQuery);
  const amountsUnit = data?.unit ?? displayUnit;

  const toggleBenchmark = (country: WealthBenchmarkCountry) => {
    const set = new Set(enabledBenchmarks);
    if (set.has(country)) set.delete(country);
    else set.add(country);
    const next = BENCHMARK_COUNTRIES.filter((c) => set.has(c));
    setEnabledBenchmarks(next);
    remember(ENABLED_BENCHMARKS_STORAGE_KEY, JSON.stringify(next));
  };
  const chooseScale = (mode: ScaleMode) => {
    setScaleMode(mode);
    remember(SCALE_STORAGE_KEY, mode);
  };

  // The countries switched on, in the server's order (today's percentile, highest first).
  const countries = useMemo(
    () => (data?.benchmark_order ?? BENCHMARK_COUNTRIES).filter((c) => enabledBenchmarks.includes(c)),
    [data, enabledBenchmarks]
  );

  // Series plotted in both chart modes (percentile in linear mode, top-% in log mode).
  const chartSeriesKeys = useMemo(() => ["total", "financial", ...countries.map((c) => c.toLowerCase())], [countries]);

  // Raw numbers only — formatting happens at render time (separator/language toggles).
  const chartPoints = useMemo(
    () =>
      (data?.chart ?? []).map((point) => {
        const p: Record<string, string | number | null> = {
          year: String(point.year),
          total: point.cl_total,
          financial: point.cl_financial,
        };
        for (const c of countries) p[c.toLowerCase()] = point.benchmarks[c];
        return p;
      }),
    [data, countries]
  );

  // Log mode plots "top X%" (100 − percentile) on a reversed-log axis so the crowded 90–100 band opens up.
  const logChartPoints = useMemo(
    () =>
      chartPoints.map((p) => {
        const out: Record<string, string | number | null> = { year: p.year };
        for (const k of chartSeriesKeys) {
          const v = p[k];
          out[k] = typeof v === "number" ? topPercentOf(v) : null;
        }
        return out;
      }),
    [chartPoints, chartSeriesKeys]
  );
  const logAxis = useMemo(
    () => percentileLogAxisFor(minMaxForKeys(logChartPoints, chartSeriesKeys).min),
    [logChartPoints, chartSeriesKeys]
  );

  if (error) {
    return (
      <main>
        <p className="error">{error instanceof Error ? error.message : t("common.loadFailed")}</p>
      </main>
    );
  }

  const rows = data?.rows ?? [];
  const today = data?.today ?? null;
  // The list is newest first: its first row is today's.
  const latestRow = rows[0] ?? null;
  const openYears = openYearsChoice ?? new Set(today ? [today.year] : []);
  const toggleYear = (year: number) => {
    const next = new Set(openYears);
    if (next.has(year)) next.delete(year);
    else next.add(year);
    setOpenYearsChoice(next);
  };
  const standing = (percentile: number | null) =>
    percentile == null ? t("wealthPercentile.belowSupport") : percentileLabel(percentile);

  return (
    <main>
      <div className={styles.titleBlock}>
        <div className={styles.titleLine}>
          <h1>{t("wealthPercentile.title")}</h1>
          {/* The figures' frame stands while the payload is pending (blank, dimmed). */}
          <Loadable loading={loading} className={styles.titleLine}>
            <span className={styles.titleValue}>
              <span className="mono">{today ? standing(today.percentile) : BLANK}</span>
              <span className={styles.titleUnit}>{t("wealthPercentile.headline.inChile")}</span>
            </span>
            {today == null || today.top_percent != null ? (
              <span className={cn("mono", styles.titleSecondary)}>
                {today?.top_percent != null
                  ? t("wealthPercentile.headline.top", { percent: formatGroupedDecimal(today.top_percent, 1) })
                  : BLANK}
              </span>
            ) : null}
          </Loadable>
        </div>
        <p className={loadableClass(loading, styles.sub)}>
          <span>
            {t("wealthPercentile.headline.financial")}{" "}
            <strong className="mono">{today ? standing(today.financial_percentile) : BLANK}</strong>
          </span>
          <span aria-hidden>·</span>
          <span>
            {t("wealthPercentile.headline.netWorth")}{" "}
            <strong className="mono">{today ? formatCurrency(today.net_worth, amountsUnit) : BLANK}</strong>
          </span>
          {today ? (
            <span>
              {t("wealthPercentile.headline.asOf", { date: today.as_of_date, year: today.distribution_year })}
            </span>
          ) : null}
        </p>
      </div>

      <PageGridTile id="percentile-band" className={cn("page-grid", bandStyles.band)}>
        <div className={bandStyles.bandChart}>
          <ChartPanelTitleRow
            title={t("wealthPercentile.chart.title")}
            controls={
              <div className="surface-controls">
                <span className="surface-controls__set" role="group" aria-label={t("wealthPercentile.chart.scaleLabel")}>
                  {SCALE_MODES.map((m) => {
                    const name = t(m === "log" ? "wealthPercentile.chart.scaleLogName" : "wealthPercentile.chart.scaleLinearName");
                    return (
                      <button
                        key={m}
                        type="button"
                        className={m === scaleMode ? "is-on" : undefined}
                        aria-pressed={m === scaleMode}
                        title={name}
                        aria-label={name}
                        onClick={() => chooseScale(m)}
                      >
                        {t(m === "log" ? "wealthPercentile.chart.scaleLog" : "wealthPercentile.chart.scaleLinear")}
                      </button>
                    );
                  })}
                </span>
              </div>
            }
          />
          {chartPoints.length === 0 ? (
            <ChartEmptyState loading={loading} message={t("wealthPercentile.empty")} boxStyle={{ height: 320 }} />
          ) : (
            <Loadable loading={loading} className={styles.chartBox}>
              <WealthPercentileChart
                data={scaleMode === "log" ? logChartPoints : chartPoints}
                logAxis={scaleMode === "log" ? logAxis : null}
                lines={[
                  { dataKey: "total", name: t("wealthPercentile.series.chile"), stroke: CL_TOTAL_STROKE, strokeWidth: 2 },
                  {
                    dataKey: "financial",
                    name: t("wealthPercentile.series.chileFinancial"),
                    stroke: CL_FINANCIAL_STROKE,
                    strokeWidth: 2,
                  },
                  ...countries.map((c) => ({
                    dataKey: c.toLowerCase(),
                    name: t(`wealthPercentile.countries.${c}`),
                    stroke: BENCHMARK_STROKE[c],
                    strokeWidth: 1.5,
                  })),
                ]}
              />
            </Loadable>
          )}
        </div>
        <div className={loadableClass(loading, bandStyles.bandRail)} aria-busy={loading || undefined}>
          <WealthTodayRail
            latest={latestRow}
            countries={countries}
            enabled={enabledBenchmarks}
            onToggle={toggleBenchmark}
          />
        </div>
      </PageGridTile>

      <PageGridTile id="years">
        <h2>{t("wealthPercentile.years.title")}</h2>
        <WealthYearList
          rows={rows}
          countries={countries}
          unit={amountsUnit}
          latestDistributionYear={today?.distribution_year ?? null}
          openYears={openYears}
          onToggleYear={toggleYear}
          loading={loading}
        />
      </PageGridTile>
    </main>
  );
}
