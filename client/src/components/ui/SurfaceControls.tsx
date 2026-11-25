import type { CSSProperties } from "react";
import { useTranslation } from "../../i18n";
import { TIME_RANGE_OPTIONS, type TimeRange } from "../../timeRange";
import type { SurfaceCompositionView, SurfacePeriod } from "../../surfaceDisplayPrefs";

const ALL_PERIODS: readonly SurfacePeriod[] = ["day", "month", "year"];

const COMPOSITION_VIEWS: readonly SurfaceCompositionView[] = ["composition", "map"];

const VIEW_LABEL_KEYS: Record<SurfaceCompositionView, string> = {
  composition: "valueMap.viewComposition",
  map: "valueMap.viewMap",
};

/** Full period names: the buttons' hover titles and accessible names. */
const PERIOD_LABEL_KEYS: Record<SurfacePeriod, string> = {
  day: "dashboard.daily",
  month: "dashboard.monthly",
  year: "dashboard.yearly",
};

const PERIOD_SHORT_KEYS: Record<SurfacePeriod, string> = {
  day: "surfaceControls.short.day",
  month: "surfaceControls.short.month",
  year: "surfaceControls.short.year",
};

const RETURN_PERIOD_LABEL_KEYS: Record<SurfacePeriod, string> = {
  day: "valueMap.period.day",
  month: "valueMap.period.month",
  year: "valueMap.period.year",
};

export type SurfaceControlsProps = {
  /** Composition panels with a value map: the Composición / Mapa switch (offered first). */
  view?: SurfaceCompositionView;
  onViewChange?: (v: SurfaceCompositionView) => void;
  /** `return` = the value map's Día/Mes/Año return window; default = chart granularity. */
  periodKind?: "granularity" | "return";
  period?: SurfacePeriod;
  onPeriodChange?: (p: SurfacePeriod) => void;
  /** Restrict the offered periods (e.g. month/year-only surfaces). Default: all three. */
  periodOptions?: readonly SurfacePeriod[];
  range?: TimeRange;
  onRangeChange?: (r: TimeRange) => void;
  /** Restrict the offered Rangos (e.g. month/year-only charts). Default: all. */
  rangeOptions?: readonly TimeRange[];
  style?: CSSProperties;
};

/**
 * Per-surface view / Período / Rango control row (chart panel titles, table headings): short
 * text buttons, «D M A · 30d … total», the current one underlined. Renders only the set(s)
 * whose value + handler are provided: charts pass period and range, period tables period
 * only, the rates page range only. Labels translate at render, never cached.
 */
export function SurfaceControls({
  view,
  onViewChange,
  periodKind = "granularity",
  period,
  onPeriodChange,
  periodOptions = ALL_PERIODS,
  range,
  onRangeChange,
  rangeOptions = TIME_RANGE_OPTIONS,
  style,
}: SurfaceControlsProps) {
  const { t } = useTranslation();

  return (
    <div className="surface-controls" style={style}>
      {view != null && onViewChange ? (
        <span className="surface-controls__set" role="group" aria-label={t("valueMap.viewLabel")}>
          {COMPOSITION_VIEWS.map((v) => (
            <button
              key={v}
              type="button"
              className={v === view ? "is-on" : undefined}
              aria-pressed={v === view}
              onClick={() => onViewChange(v)}
            >
              {t(VIEW_LABEL_KEYS[v])}
            </button>
          ))}
        </span>
      ) : null}
      {period != null && onPeriodChange ? (
        <span
          className="surface-controls__set"
          role="group"
          aria-label={t(periodKind === "return" ? "valueMap.periodLabel" : "dashboard.chartGranularityLabel")}
        >
          {periodOptions.map((p) => (
            <button
              key={p}
              type="button"
              className={p === period ? "is-on" : undefined}
              aria-pressed={p === period}
              title={periodKind === "return" ? undefined : t(PERIOD_LABEL_KEYS[p])}
              aria-label={periodKind === "return" ? undefined : t(PERIOD_LABEL_KEYS[p])}
              onClick={() => onPeriodChange(p)}
            >
              {t((periodKind === "return" ? RETURN_PERIOD_LABEL_KEYS : PERIOD_SHORT_KEYS)[p])}
            </button>
          ))}
        </span>
      ) : null}
      {range != null && onRangeChange ? (
        <span className="surface-controls__set" role="group" aria-label={t("dashboard.rangeLabel")}>
          {rangeOptions.map((r) => (
            <button
              key={r}
              type="button"
              className={r === range ? "is-on" : undefined}
              aria-pressed={r === range}
              title={t(`surfaceControls.rangeName.${r}`)}
              aria-label={t(`surfaceControls.rangeName.${r}`)}
              onClick={() => onRangeChange(r)}
            >
              {t(`surfaceControls.shortRange.${r}`)}
            </button>
          ))}
        </span>
      ) : null}
    </div>
  );
}
