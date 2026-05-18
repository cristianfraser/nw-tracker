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
import type { TailClipSeriesEntry } from "../chartTailClip";
import { dataSeriesKeysFromTailClip } from "../chartTailClip";

export type { TailClipSeriesEntry } from "../chartTailClip";

/** Months of trailing **0** kept before the rest of the tail is set to `null` (per series). */
export const DEFAULT_TRAILING_ZERO_MONTHS_KEPT = 3;

export type TailClipOptions = {
  /** Per-line role: only `type: "data"` series are tail-clipped. */
  series: readonly TailClipSeriesEntry[];
  monthsKept?: number;
  /**
   * When a valuation line is tail-clipped (trailing zeros), clip its deposit lines from the same month onward
   * even if deposits are still non-zero (e.g. pre-Fintual principal after APV-a cut).
   */
  depositKeysByValuationKey?: Readonly<Record<string, readonly string[]>>;
  /** After clipping parts, recompute `__group_val_total` as the sum of these keys per row (optional). */
  groupValTotalSourceKeys?: readonly string[];
  /** After clipping parts, recompute `__group_dep_total` as the sum of these keys per row (optional). */
  groupDepTotalSourceKeys?: readonly string[];
};

/** Index from which to set a series to `null` after trailing zeros; `null` if no clip. */
export function trailingZeroTailClipStartIndex(
  points: readonly Record<string, string | number | null>[],
  dataKey: string,
  monthsKept: number
): number | null {
  let lastNonZeroIdx = -1;
  for (let i = 0; i < points.length; i++) {
    const v = points[i]![dataKey];
    if (typeof v === "number" && Number.isFinite(v) && Math.abs(v) > 1e-9) {
      lastNonZeroIdx = i;
    }
  }
  const n = points.length;
  const trailingLen = lastNonZeroIdx >= 0 ? n - 1 - lastNonZeroIdx : n;
  if (trailingLen <= monthsKept) return null;
  return lastNonZeroIdx + 1 + monthsKept;
}

function applyTailClipFromIndex(
  points: Record<string, string | number | null>[],
  startNullAt: number,
  keysToClip: readonly string[]
): Record<string, string | number | null>[] {
  const clipSet = new Set(keysToClip);
  return points.map((row, idx) => {
    if (idx < startNullAt) return row;
    const next = { ...row };
    for (const k of clipSet) next[k] = null;
    return next;
  });
}

/**
 * For each `type: "data"` series, replace values with `null` from the (N+1)th trailing zero month onward
 * (N = monthsKept). Optionally recomputes group total lines from clipped parts.
 */
export function applyMultiSeriesTrailingZeroTailClip(
  points: Record<string, string | number | null>[],
  opts: TailClipOptions
): { points: Record<string, string | number | null>[]; tailClippedKeys: Set<string> } {
  const monthsKept = opts.monthsKept ?? DEFAULT_TRAILING_ZERO_MONTHS_KEPT;
  const keys = dataSeriesKeysFromTailClip(opts.series);
  if (keys.length === 0 || points.length === 0) {
    return { points, tailClippedKeys: new Set() };
  }

  const tailClippedKeys = new Set<string>();
  let out = points.map((r) => ({ ...r }));

  const depositKeysByVal = opts.depositKeysByValuationKey ?? {};
  const linkedDepositKeys = new Set<string>();
  for (const depKeys of Object.values(depositKeysByVal)) {
    for (const dk of depKeys) linkedDepositKeys.add(dk);
  }

  const clipKeysAt = (startNullAt: number, toClip: readonly string[]) => {
    for (const k of toClip) {
      if (!keys.includes(k)) continue;
      tailClippedKeys.add(k);
    }
    out = applyTailClipFromIndex(out, startNullAt, toClip);
  };

  for (const [valKey, depKeys] of Object.entries(depositKeysByVal)) {
    if (!keys.includes(valKey)) continue;
    const startNullAt = trailingZeroTailClipStartIndex(out, valKey, monthsKept);
    if (startNullAt == null) continue;
    const bundled = [valKey, ...depKeys.filter((dk) => keys.includes(dk))];
    clipKeysAt(startNullAt, bundled);
  }

  for (const dk of keys) {
    if (dk in depositKeysByVal) continue;
    if (linkedDepositKeys.has(dk)) continue;

    const startNullAt = trailingZeroTailClipStartIndex(out, dk, monthsKept);
    if (startNullAt == null) continue;
    clipKeysAt(startNullAt, [dk]);
  }

  const sample = out[0];
  if (opts.groupValTotalSourceKeys?.length && sample && "__group_val_total" in sample) {
    out = out.map((row) => {
      let sum = 0;
      let any = false;
      for (const k of opts.groupValTotalSourceKeys!) {
        const v = row[k];
        if (typeof v === "number" && Number.isFinite(v)) {
          sum += v;
          any = true;
        }
      }
      return { ...row, __group_val_total: any ? sum : null };
    });
  }

  if (opts.groupDepTotalSourceKeys?.length && sample && "__group_dep_total" in sample) {
    out = out.map((row) => {
      let sum = 0;
      let any = false;
      for (const k of opts.groupDepTotalSourceKeys!) {
        const v = row[k];
        if (typeof v === "number" && Number.isFinite(v)) {
          sum += v;
          any = true;
        }
      }
      return { ...row, __group_dep_total: any ? sum : null };
    });
  }

  return { points: out, tailClippedKeys };
}

/**
 * Last `as_of_date` still shown when **every** independent data series qualifies for tail clip
 * (long run of trailing zeros). If only some data series tail to zero, returns `null` so the chart
 * x-range is not shortened (e.g. APV principal ends early while other regime lines continue).
 *
 * When all qualify, uses the **latest** such date so the axis spans every series' last visible point.
 */
export function trailingZeroTailClipLastVisibleDate(
  points: readonly Record<string, string | number | null>[],
  opts: TailClipOptions,
  dateKey = "as_of_date"
): string | null {
  const monthsKept = opts.monthsKept ?? DEFAULT_TRAILING_ZERO_MONTHS_KEPT;
  const keys = dataSeriesKeysFromTailClip(opts.series);
  if (keys.length === 0 || points.length === 0) return null;

  const depositKeysByVal = opts.depositKeysByValuationKey ?? {};
  const linkedDepositKeys = new Set<string>();
  for (const depKeys of Object.values(depositKeysByVal)) {
    for (const dk of depKeys) linkedDepositKeys.add(dk);
  }

  /** Same “subjects” as {@link applyMultiSeriesTrailingZeroTailClip}: one entry per valuation or orphan data key. */
  const subjects: string[] = [];
  for (const valKey of Object.keys(depositKeysByVal)) {
    if (keys.includes(valKey)) subjects.push(valKey);
  }
  for (const dk of keys) {
    if (dk in depositKeysByVal) continue;
    if (linkedDepositKeys.has(dk)) continue;
    subjects.push(dk);
  }

  const lastVisibleDates: string[] = [];
  for (const sub of subjects) {
    const startNullAt = trailingZeroTailClipStartIndex(points, sub, monthsKept);
    if (startNullAt == null || startNullAt <= 0) return null;
    const d = String(points[startNullAt - 1]![dateKey] ?? "").trim();
    if (!d) return null;
    lastVisibleDates.push(d);
  }

  if (lastVisibleDates.length === 0) return null;
  return lastVisibleDates.reduce((a, b) => (a.localeCompare(b) >= 0 ? a : b));
}

export function filterPointsThroughAsOfDate<T extends { as_of_date: string }>(
  rows: readonly T[],
  maxAsOfDate: string | null | undefined
): T[] {
  if (!maxAsOfDate) return [...rows];
  return rows.filter((r) => r.as_of_date.localeCompare(maxAsOfDate) <= 0);
}

/** Same as {@link filterPointsThroughAsOfDate} for sparse chart rows keyed by `dateKey`. */
export function filterChartRowsThroughDate(
  rows: readonly Record<string, string | number | null>[],
  maxAsOfDate: string | null | undefined,
  dateKey = "as_of_date"
): Record<string, string | number | null>[] {
  if (!maxAsOfDate) return [...rows];
  return rows.filter((r) => String(r[dateKey] ?? "").localeCompare(maxAsOfDate) <= 0);
}

export function useMultiSeriesTrailingZeroTailClip(
  points: Record<string, string | number | null>[],
  opts: TailClipOptions | null | undefined
): { chartData: Record<string, string | number | null>[]; tailClippedKeys: Set<string> } {
  return useMemo(() => {
    if (!opts?.series?.length || !points.length) {
      return { chartData: points, tailClippedKeys: new Set<string>() };
    }
    const { points: clipped, tailClippedKeys } = applyMultiSeriesTrailingZeroTailClip(points, opts);
    return { chartData: clipped, tailClippedKeys };
  }, [points, opts]);
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
