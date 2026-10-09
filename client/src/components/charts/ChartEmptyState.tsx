import type { CSSProperties } from "react";

/**
 * Every chart's empty branch. While `loading`, an empty chart box at the chart's size with
 * nothing drawn — the «no data» copy is for a real absence, never for data that has not
 * arrived. Render it under the ChartPanelTitleRow, where the message used to go. A chart that
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
  if (loading) return <div className="chart-box chart-box--pending" style={boxStyle} aria-busy="true" />;
  return <p className="empty muted">{message}</p>;
}
