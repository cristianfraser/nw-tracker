import {
  Children,
  cloneElement,
  isValidElement,
  useMemo,
  type ComponentProps,
  type ReactElement,
  type ReactNode,
} from "react";
import { Line, LineChart } from "recharts";

export function filterPointsThroughAsOfDate<T extends { as_of_date: string }>(
  rows: readonly T[],
  maxAsOfDate: string | null | undefined
): T[] {
  if (!maxAsOfDate) return [...rows];
  return rows.filter((r) => r.as_of_date.localeCompare(maxAsOfDate) <= 0);
}

/** When perf rows include a live today row newer than chart tail-clip, keep it visible. */
export function resolveMonthlyPerfClipEndDate(
  valuationTailClipEndDate: string | null | undefined,
  rowsNewestFirst: readonly { as_of_date: string }[]
): string | null | undefined {
  const latestPerfDate = rowsNewestFirst[0]?.as_of_date;
  if (
    valuationTailClipEndDate &&
    latestPerfDate &&
    latestPerfDate.localeCompare(valuationTailClipEndDate) > 0
  ) {
    return latestPerfDate;
  }
  return valuationTailClipEndDate;
}

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
  children: ReactNode;
};

/**
 * App wrapper around Recharts {@link LineChart}: forwards props and injects `connectNulls` on `<Line>` children
 * whose `dataKey` appears in `tailClippedKeys`.
 */
export function AppLineChart({ data, tailClippedKeys, children, ...rest }: AppLineChartProps) {
  const clipSet = useMemo(() => tailClipKeySet(tailClippedKeys), [tailClippedKeys]);
  const mappedChildren = useMemo(
    () => (clipSet.size === 0 ? children : injectLineConnectNullsForTailClip(children, clipSet)),
    [children, clipSet]
  );
  return (
    <LineChart data={data} {...rest}>
      {mappedChildren}
    </LineChart>
  );
}
