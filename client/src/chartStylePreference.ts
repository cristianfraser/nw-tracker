/**
 * Global chart-style preference (rehearsal of hand-drawn chart renderings, 2026-11-03):
 *
 * - `plain`   — the current styling, untouched.
 * - `pen`     — rough.js segments through the data points, a fine pen: two thin passes, slightly
 *               translucent, hand-drawn axes, grid and reference lines.
 * - `pencil`  — several faint thin passes with grain, the stroke breaking here and there.
 * - `marker`  — a felt tip: a solid core with a soft, blurred edge.
 * - `watercolor` — wide washes of colour, fully soft, the series mixing where they cross.
 * - `crayon`  — a wide grainy stroke, low coverage, visible gaps.
 * All of them draw straight segments between data points (no curve interpolation) and keep the
 * series colours; the knobs are in `components/charts/roughShapes.tsx` (`ROUGH_MODES`).
 *
 * Same model as the decimal-separator preference: the stored value is authoritative, the
 * default is `plain`. The value is written to `<html data-chart-style>` by the preferences
 * provider, which is what the CSS keys on; a `ChartStyleScope` (`components/charts/chartStyle.tsx`)
 * can override it for a subtree, which the lab page (/panel/chart-styles) uses to show the
 * styles side by side.
 */
export const CHART_STYLES = ["plain", "pen", "pencil", "marker", "watercolor", "crayon"] as const;
export type ChartStyle = (typeof CHART_STYLES)[number];

export const CHART_STYLE_LS_KEY = "nw-tracker.chartStyle";

export function isChartStyle(v: unknown): v is ChartStyle {
  return typeof v === "string" && (CHART_STYLES as readonly string[]).includes(v);
}

export function persistChartStyle(style: ChartStyle): void {
  try {
    localStorage.setItem(CHART_STYLE_LS_KEY, style);
  } catch {
    /* ignore (private mode / node tests) */
  }
}

/** Stored value if valid; otherwise `plain`. */
export function readInitialChartStyle(): ChartStyle {
  if (typeof window === "undefined") return "plain";
  try {
    const stored = localStorage.getItem(CHART_STYLE_LS_KEY);
    if (isChartStyle(stored)) return stored;
  } catch {
    /* ignore */
  }
  return "plain";
}
