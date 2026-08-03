import { bandEdges, type BandAxis, type ChartOffset } from "./chartBandEdges";

/**
 * Alternating background bands for the x axis, drawn *between* label groups.
 *
 * Recharts' vertical grid lines sit on the ticks, i.e. through the middle of each bar group. With
 * several side-by-side bars per category that reads as a line splitting the group; a faint band per
 * group separates them without adding strokes that compete with the series. Only charts with
 * grouped bars want this — a single or stacked bar is already one column per tick and needs no
 * bracketing (see {@link AppComposedChart}'s `groupedBars`).
 */
export type AlternatingXBandsProps = {
  xAxisMap?: Record<string, BandAxis>;
  offset?: ChartOffset;
};

/** Rendered through Recharts' `<Customized>`, which injects `xAxisMap` and `offset`. */
export function AlternatingXBands({ xAxisMap, offset }: AlternatingXBandsProps) {
  const xAxis = xAxisMap ? Object.values(xAxisMap)[0] : undefined;
  if (!xAxis || !offset) return null;

  const edges = bandEdges(xAxis, offset);
  return (
    <g className="recharts-x-bands" pointerEvents="none">
      {edges.slice(0, -1).map((x, i) =>
        i % 2 === 0 ? (
          <rect
            key={x}
            className="recharts-x-band"
            x={x}
            y={offset.top}
            width={edges[i + 1]! - x}
            height={offset.height}
          />
        ) : null
      )}
    </g>
  );
}
