import { DefaultZIndexes, usePlotArea, useXAxisDomain, useXAxisScale, ZIndexLayer } from "recharts";
import { bandEdges, type BandScale } from "./chartBandEdges";

/**
 * Alternating background bands for the x axis, drawn *between* label groups.
 *
 * Recharts' vertical grid lines sit on the ticks, i.e. through the middle of each bar group. With
 * several side-by-side bars per category that reads as a line splitting the group; a faint band per
 * group separates them without adding strokes that compete with the series. Only charts with
 * grouped bars want this — a single or stacked bar is already one column per tick and needs no
 * bracketing (see {@link AppComposedChart}'s `groupedBars`).
 *
 * A plain chart child: reads the x axis and the plot offset from the chart's hooks, and paints
 * in a layer under the grid.
 */
export function AlternatingXBands() {
  const xScale = useXAxisScale();
  const domain = useXAxisDomain();
  const plot = usePlotArea();
  if (!xScale || !domain || !plot) return null;

  // Each category's center (band scales: the band's middle; point scales: the point), so
  // `bandEdges` needs no bandwidth.
  const scale: BandScale = Object.assign((v: unknown) => xScale(v, { position: "middle" }), {
    domain: () => [...domain],
  });
  const offset = { top: plot.y, left: plot.x, width: plot.width, height: plot.height };
  const edges = bandEdges({ scale }, offset);
  return (
    <ZIndexLayer zIndex={DefaultZIndexes.grid - 1}>
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
    </ZIndexLayer>
  );
}
