import { useMemo } from "react";
import { Bar, BarChart, Tooltip, XAxis, YAxis } from "recharts";
import type { BarShapeProps, TooltipContentProps } from "recharts";
import { AppChartTooltipContent, ChartTooltipRows, type AppTooltipSpec } from "./ChartTooltip";
import { useElementSize } from "./useElementSize";

/** One segment of a cupo bar, everything it shows decided by the caller (already formatted). */
export type CcGlanceCupoBarSegment = {
  key: string;
  /** Its width on the bar (server share: fraction of the bar). */
  share: number;
  /** CSS colour of the segment (and its tooltip swatch). */
  fill: string;
  /** Tooltip heading and its one row. */
  title: string;
  name: string;
  value: string;
  subValue?: string;
};

const NO_MARGIN = { top: 0, right: 0, bottom: 0, left: 0 } as const;

/**
 * The credit-card glance's cupo bar (CreditCardGlance.tsx): one row of segments stacked left to right
 * over the server's shares on [0, 1], so a segment spans exactly `share × width` — the same pixels as
 * the HTML bracket and labels laid out by the same shares (no margin, hidden axes take no room). The
 * free part is the track behind the chart (the caller's box). Each segment after the first starts with
 * a `gapPx` gap in the page background. Hovering a segment shows its own tooltip (item tooltip).
 * Fills its box; no animation (a static figure).
 */
export function CcGlanceCupoBar({
  segments,
  gapPx = 0,
}: {
  segments: readonly CcGlanceCupoBarSegment[];
  gapPx?: number;
}) {
  const { ref, width, height } = useElementSize<HTMLDivElement>();
  const row = useMemo(() => Object.fromEntries(segments.map((s, i) => [`s${i}`, s.share])), [segments]);
  const spec: AppTooltipSpec = {
    formatValue: () => "",
    cursor: false,
    horizontalGuide: false,
    renderContent: ({ payload }) => {
      const key = String(payload[0]?.dataKey ?? "");
      const seg = segments[Number(key.slice(1))];
      if (!seg) return null;
      return (
        <ChartTooltipRows
          title={seg.title}
          rows={[{ key: seg.key, name: seg.name, value: seg.value, subValue: seg.subValue, swatchColor: seg.fill }]}
        />
      );
    },
  };
  return (
    <div ref={ref} style={{ width: "100%", height: "100%" }}>
      {width > 0 && height > 0 ? (
        <BarChart
          width={width}
          height={height}
          data={[row]}
          layout="vertical"
          margin={NO_MARGIN}
          barCategoryGap={0}
          barGap={0}
        >
          <XAxis type="number" domain={[0, 1]} hide allowDataOverflow />
          <YAxis type="category" hide />
          <Tooltip
            shared={false}
            wrapperStyle={{ transform: "none", width: "100%", height: "100%" }}
            cursor={false}
            isAnimationActive={false}
            content={(props) => (
              <AppChartTooltipContent {...(props as TooltipContentProps<number, string>)} spec={spec} />
            )}
          />
          {segments.map((s, i) => (
            <Bar
              key={s.key}
              dataKey={`s${i}`}
              stackId="cupo"
              isAnimationActive={false}
              shape={(p: BarShapeProps) => <SegmentRect {...p} fill={s.fill} gapPx={i > 0 ? gapPx : 0} />}
            />
          ))}
        </BarChart>
      ) : null}
    </div>
  );
}

/** A segment's rectangle, its left `gapPx` drawn in the page background (the HTML bar's 2px border). */
function SegmentRect({ x, y, width, height, fill, gapPx }: BarShapeProps & { fill: string; gapPx: number }) {
  if (!(width > 0) || !(height > 0)) return <g />;
  const gap = Math.min(gapPx, width);
  return (
    <g>
      <rect x={x} y={y} width={width} height={height} style={{ fill }} />
      {gap > 0 ? <rect x={x} y={y} width={gap} height={height} style={{ fill: "var(--bg)" }} /> : null}
    </g>
  );
}
