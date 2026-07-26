import type { CSSProperties } from "react";
import { useTranslation } from "../../i18n";
import { parseTimeRange, TIME_RANGE_OPTIONS, type TimeRange } from "../../timeRange";
import type { SurfacePeriod } from "../../surfaceDisplayPrefs";

const ALL_PERIODS: readonly SurfacePeriod[] = ["day", "month", "year"];

const PERIOD_LABEL_KEYS: Record<SurfacePeriod, string> = {
  day: "dashboard.daily",
  month: "dashboard.monthly",
  year: "dashboard.yearly",
};

export type SurfaceControlsProps = {
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
      {period != null && onPeriodChange ? (
        <label style={{ display: "inline-flex", alignItems: "center", gap: "0.35rem" }}>
          <span className="muted">{t("dashboard.chartGranularityLabel")}</span>
          <select
            value={period}
            onChange={(e) => {
              const v = e.target.value;
              if (v === "day" || v === "month" || v === "year") onPeriodChange(v);
            }}
          >
            {periodOptions.map((p) => (
              <option key={p} value={p}>
                {t(PERIOD_LABEL_KEYS[p])}
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
