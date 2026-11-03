import {
  Children,
  cloneElement,
  isValidElement,
  useId,
  useMemo,
  type ComponentProps,
  type ReactElement,
  type ReactNode,
} from "react";
import { Line, LineChart, ResponsiveContainer } from "recharts";
import { RECHARTS_MONEY_CHART_MARGIN } from "./chartLayout";
import { appTooltipElement, type AppTooltipSpec } from "./ChartTooltip";
import { useChartStyle } from "./chartStyle";
import {
  RoughAxisLines,
  RoughChartDefs,
  injectRoughShapes,
  roughAxisSides,
  roughGrainFilterId,
  roughModeFor,
  roughSeed,
} from "./roughShapes";

function tailClipKeySet(tailClippedKeys: ReadonlySet<string> | readonly string[] | null | undefined): Set<string> {
  if (tailClippedKeys == null) return new Set();
  return tailClippedKeys instanceof Set ? tailClippedKeys : new Set(tailClippedKeys);
}

function injectLineConnectNullsForTailClip(node: ReactNode, clipKeys: ReadonlySet<string>): ReactNode {
  return Children.map(node, (child) => {
    if (!isValidElement(child)) return child;
    if (child.type === Line) {
      const dk = child.props.dataKey;
      const dkStr = typeof dk === "string" ? dk : String(dk ?? "");
      const breakTail = clipKeys.has(dkStr);
      return cloneElement(child as ReactElement<ComponentProps<typeof Line>>, {
        connectNulls: !breakTail,
      });
    }
    const ch = child.props?.children as ReactNode | undefined;
    if (ch != null) {
      const mapped = injectLineConnectNullsForTailClip(ch, clipKeys);
      if (mapped !== ch) {
        return cloneElement(child, { children: mapped } as { children: ReactNode });
      }
    }
    return child;
  });
}

export type AppLineChartProps = Omit<ComponentProps<typeof LineChart>, "data"> & {
  data: Record<string, string | number | null>[];
  /** Set `connectNulls={false}` on matching `<Line dataKey=…>` descendants so clipped tails don’t bridge. */
  tailClippedKeys?: ReadonlySet<string> | readonly string[] | null;
  /** Docked collision-aware tooltip (see {@link AppTooltipSpec}). Omit for no tooltip. */
  tooltip?: AppTooltipSpec | null;
  children: ReactNode;
};

/**
 * App wrapper around Recharts {@link LineChart}: owns the ResponsiveContainer, default margin, and the docked
 * tooltip; injects `connectNulls` on `<Line>` children whose `dataKey` appears in `tailClippedKeys`.
 */
export function AppLineChart({ data, tailClippedKeys, tooltip, margin, children, ...rest }: AppLineChartProps) {
  const clipSet = useMemo(() => tailClipKeySet(tailClippedKeys), [tailClippedKeys]);
  const rough = roughModeFor(useChartStyle());
  const grainFilterId = roughGrainFilterId(useId());
  const mappedChildren = useMemo(() => {
    const clipped = clipSet.size === 0 ? children : injectLineConnectNullsForTailClip(children, clipSet);
    // The hand-drawn chart styles (roughShapes.tsx): every series drawn by rough.js; `plain` never clones.
    return rough ? injectRoughShapes(clipped, rough, grainFilterId) : clipped;
  }, [children, clipSet, rough, grainFilterId]);
  const axisSides = useMemo(() => (rough?.extras ? roughAxisSides(children) : []), [children, rough]);
  return (
    <ResponsiveContainer width="100%" height="100%">
      <LineChart data={data} margin={margin ?? RECHARTS_MONEY_CHART_MARGIN} {...rest}>
        {tooltip ? appTooltipElement(tooltip) : null}
        {rough ? <RoughChartDefs mode={rough} grainFilterId={grainFilterId} /> : null}
        {mappedChildren}
        {axisSides.length ? <RoughAxisLines sides={axisSides} seed={roughSeed("axis", rough?.seedSalt)} multiStroke={rough?.multiStrokeExtras ?? true} /> : null}
      </LineChart>
    </ResponsiveContainer>
  );
}
