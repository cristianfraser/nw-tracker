import type { CSSProperties } from "react";
import { AXIS_LINE_STROKE } from "./chartLayout";

/** Gridline fractions of the plot, top to bottom / left to right (the bottom and left edges are the axes). */
const PENDING_GRID_ROWS = [0, 0.25, 0.5, 0.75];
const PENDING_GRID_COLS = [0.2, 0.4, 0.6, 0.8, 1];

/**
 * Every chart's empty branch. While `loading`, the chart box at the chart's size with an empty
 * plot — axes and the grid in the charts' own strokes, no series — the «no data» copy is for a real absence, never for data that has not
 * arrived. Render it under the ChartPanelTitleRow. A chart that
 * sizes its box explicitly passes the same `boxStyle`, so nothing shifts when the data lands.
 */
export function ChartEmptyState({
  loading,
  message,
  boxStyle,
}: {
  loading?: boolean;
  message: string;
  boxStyle?: CSSProperties;
}) {
  if (loading) {
    return (
      <div className="chart-box chart-box--pending" style={boxStyle} aria-busy="true">
        {/* Plain SVG, not Recharts: this also stands in for a chart whose chunk has not loaded. */}
        <svg className="chart-box__pending-plot" width="100%" height="100%" aria-hidden="true">
          {PENDING_GRID_ROWS.map((f) => (
            <line key={`r${f}`} x1="0" x2="100%" y1={`${f * 100}%`} y2={`${f * 100}%`} className="chart-box__pending-grid" />
          ))}
          {PENDING_GRID_COLS.map((f) => (
            <line key={`c${f}`} x1={`${f * 100}%`} x2={`${f * 100}%`} y1="0" y2="100%" className="chart-box__pending-grid" />
          ))}
          <line x1="0" x2="100%" y1="100%" y2="100%" stroke={AXIS_LINE_STROKE} />
          <line x1="0" x2="0" y1="0" y2="100%" stroke={AXIS_LINE_STROKE} />
        </svg>
      </div>
    );
  }
  return <p className="empty muted">{message}</p>;
}
