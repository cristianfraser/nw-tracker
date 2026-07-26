import type { ReactNode } from "react";

/**
 * Chart panel heading: the `.chart-panel-title` heading plus optional right-aligned
 * per-surface controls (`SurfaceControls`). Without controls it renders the bare heading,
 * byte-identical to the pre-controls markup. Render this in EVERY branch of a chart —
 * including empty states — so a range that clips everything away still offers its controls.
 */
export function ChartPanelTitleRow({
  title,
  titleAs = "h2",
  controls,
}: {
  title: string;
  titleAs?: "h2" | "h3";
  controls?: ReactNode;
}) {
  const TitleTag = titleAs;
  if (!controls) return <TitleTag className="chart-panel-title">{title}</TitleTag>;
  return (
    <div className="chart-panel-title-row">
      <TitleTag className="chart-panel-title">{title}</TitleTag>
      {controls}
    </div>
  );
}
