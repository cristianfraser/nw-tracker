import type { CSSProperties } from "react";
import { useTranslation } from "../../i18n";
import { parseTimeRange, TIME_RANGE_OPTIONS, type TimeRange } from "../../timeRange";
import type { SurfaceCompositionView, SurfacePeriod } from "../../surfaceDisplayPrefs";

const ALL_PERIODS: readonly SurfacePeriod[] = ["day", "month", "year"];

const PERIOD_LABEL_KEYS: Record<SurfacePeriod, string> = {
  day: "dashboard.daily",
  month: "dashboard.monthly",
  year: "dashboard.yearly",
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
  style?: CSSProperties;
};

/**
 * Compact per-surface Período/Rango control row (chart panel titles, table headings).
 * Renders only the pair(s) whose value + handler are provided: charts pass both, period
 * tables pass period only, the rates page passes range only. Labels reuse the global
 * toolbar keys — translate at render, never cache.
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
  style,
}: SurfaceControlsProps) {
  const { t } = useTranslation();

  return (
    <div
      className="surface-controls"
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "0.75rem",
        flexWrap: "wrap",
        fontSize: "0.85rem",
        ...style,
      }}
    >
      {view != null && onViewChange ? (
        <label style={{ display: "inline-flex", alignItems: "center", gap: "0.35rem" }}>
          <span className="muted">{t("valueMap.viewLabel")}</span>
          <select
            value={view}
            onChange={(e) => {
              const v = e.target.value;
              if (v === "composition" || v === "map") onViewChange(v);
            }}
          >
            <option value="composition">{t("valueMap.viewComposition")}</option>
            <option value="map">{t("valueMap.viewMap")}</option>
          </select>
        </label>
      ) : null}
      {period != null && onPeriodChange ? (
        <label style={{ display: "inline-flex", alignItems: "center", gap: "0.35rem" }}>
          <span className="muted">
            {t(periodKind === "return" ? "valueMap.periodLabel" : "dashboard.chartGranularityLabel")}
          </span>
          <select
            value={period}
            onChange={(e) => {
              const v = e.target.value;
              if (v === "day" || v === "month" || v === "year") onPeriodChange(v);
            }}
          >
            {periodOptions.map((p) => (
              <option key={p} value={p}>
                {t((periodKind === "return" ? RETURN_PERIOD_LABEL_KEYS : PERIOD_LABEL_KEYS)[p])}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      {range != null && onRangeChange ? (
        <label style={{ display: "inline-flex", alignItems: "center", gap: "0.35rem" }}>
          <span className="muted">{t("dashboard.rangeLabel")}</span>
          <select
            value={range}
            onChange={(e) => {
              const v = parseTimeRange(e.target.value);
              if (v != null) onRangeChange(v);
            }}
          >
            {TIME_RANGE_OPTIONS.map((r) => (
              <option key={r} value={r}>
                {t(`dashboard.range.${r}`)}
              </option>
            ))}
          </select>
        </label>
      ) : null}
    </div>
  );
}
