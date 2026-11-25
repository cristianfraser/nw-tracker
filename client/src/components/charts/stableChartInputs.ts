import { replaceEqualDeep } from "@tanstack/react-query";
import { Children, Fragment, cloneElement, isValidElement, useRef, type ReactElement, type ReactNode } from "react";
import { Area, Bar, Line, Scatter, XAxis, YAxis } from "recharts";
import { useStructuralValue } from "../../useStructuralValue";

/**
 * How long after a change of shape the series may animate (ms): longer than any series' animation
 * (Recharts' default is 1500 ms, the app's 90–300 ms). An animation can still outlast it — a chart
 * first drawn in a hidden tab, where requestAnimationFrame does not run — and a series switched to
 * `isAnimationActive={false}` mid-animation jumps to its last frame but never reports its end, so
 * Recharts keeps its `isAnimating` (its labels hidden) for good. Hence such a series remounts.
 */
const ANIMATION_WINDOW_MS = 2000;

/** Numbers a value axis's formatter is probed with when the axis states no ticks. */
const NUMERIC_PROBES: readonly number[] = [0, 1.5, -1234.5, 1234567.89];

type Formatter = (value: unknown, index: number) => unknown;

type AxisSlot = {
  props: Record<string, unknown>;
  fn: Formatter | null;
  forwarder: Formatter | null;
  signature: string | null;
};

type Row = Record<string, unknown>;

type SeriesProps = {
  dataKey?: unknown;
  isAnimationActive?: boolean;
  onAnimationStart?: () => void;
  onAnimationEnd?: () => void;
};

/** A series' animation state across renders, and the stable callbacks that keep it. */
type SeriesSlot = {
  running: boolean;
  epoch: number;
  onStart: (() => void) | undefined;
  onEnd: (() => void) | undefined;
  start: () => void;
  end: () => void;
};

function isShareable(v: unknown): boolean {
  if (Array.isArray(v)) return true;
  if (v == null || typeof v !== "object" || isValidElement(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

function dataRows(data: unknown): Row[] {
  return Array.isArray(data) ? (data as Row[]) : [];
}

/** The values a formatter is judged by: the axis's own ticks, else a few of its category values, else numbers. */
function formatterProbeValues(isX: boolean, props: Record<string, unknown>, rows: Row[]): readonly unknown[] {
  const ticks = props.ticks;
  if (Array.isArray(ticks) && ticks.length > 0) return ticks;
  const dataKey = props.dataKey;
  if (isX && props.type !== "number" && typeof dataKey === "string") {
    if (!rows.length) return [];
    return [rows[0], rows[rows.length >> 1], rows[rows.length - 1]].map((r) => r?.[dataKey]);
  }
  return NUMERIC_PROBES;
}

function seriesShapeKey(rows: Row[], xKey: string | null, seriesKeys: string[]): string {
  const first = rows[0];
  const last = rows[rows.length - 1];
  const edge = (r: Row | undefined) => (r && xKey ? String(r[xKey] ?? "") : "");
  // A placeholder of zeros (or nulls) turning into real values is a change of shape: the
  // loaded data draws in, and a live update of real values does not.
  let hasValues = false;
  outer: for (const r of rows) {
    for (const k of seriesKeys) {
      const v = r[k];
      if (typeof v === "number" && v !== 0 && Number.isFinite(v)) {
        hasValues = true;
        break outer;
      }
    }
  }
  return [rows.length, edge(first), edge(last), [...seriesKeys].sort().join(","), hasValues ? 1 : 0].join("|");
}

/**
 * What the app's chart wrappers hand Recharts, kept stable while nothing a viewer would see has
 * changed. Recharts restarts a series' animation whenever its computed points are a new object,
 * and those are rebuilt from any new `data` array and any axis whose `tickFormatter` or `ticks`
 * is a new reference (axes compare those by `===`), so a chart re-rendered by a live-quote poll
 * re-animated, and an Area hid its labels while doing so. Three layers:
 *
 * 1. `data` keeps its identity while equal ({@link useStructuralValue}).
 * 2. Every `<XAxis>` / `<YAxis>` keeps equal array / object props as the previous objects, and its
 *    `tickFormatter` as one forwarding function that calls the latest formatter. The forwarder is
 *    replaced (so the axis re-renders its labels) whenever the formatter's output changes on the
 *    axis's ticks, a few of its categories or a set of probe numbers — a language, decimal
 *    separator, unit or compact-format change — never kept stale.
 * 3. Series (`Line`, `Area`, `Bar`, `Scatter`) animate only for {@link ANIMATION_WINDOW_MS} after
 *    the chart's shape changes (first draw, row count, first or last category, the set of series,
 *    placeholder zeros becoming values, or the caller's `animationKey`); a live update of today's
 *    point redraws without a tween.
 */
export function useStableChartInputs<D>(
  data: D,
  children: ReactNode,
  animationKey?: string | null
): { data: D; children: ReactNode } {
  const stableData = useStructuralValue(data);
  const rows = dataRows(stableData);
  const slots = useRef(new Map<string, AxisSlot>());
  const shape = useRef<{ key: string | null; until: number }>({ key: null, until: 0 });
  const series = useRef(new Map<string, SeriesSlot>());
  const wasAnimate = useRef(true);

  let xKey: string | null = null;
  const seriesKeys: string[] = [];
  const scan = (node: ReactNode) => {
    Children.forEach(node, (child) => {
      if (!isValidElement(child)) return;
      const props = child.props as Record<string, unknown>;
      if (child.type === XAxis && xKey == null && typeof props.dataKey === "string") xKey = props.dataKey;
      if (isSeries(child.type)) seriesKeys.push(String(props.dataKey ?? ""));
      if (child.type === Fragment) scan(props.children as ReactNode);
    });
  };
  scan(children);

  const key = `${seriesShapeKey(rows, xKey, seriesKeys)}|${animationKey ?? ""}`;
  const now = performance.now();
  if (shape.current.key !== key) shape.current = { key, until: now + ANIMATION_WINDOW_MS };
  const animate = now < shape.current.until;
  // A series switched to still while its animation is running (an animation can outlast the
  // window, e.g. one first drawn in a hidden tab) gets a new key and remounts with no animation
  // state, so it cannot stay "animating". Only those: a remounted Line has not measured its path
  // yet, so the next change of shape would wipe it in from the left instead of tweening.
  if (wasAnimate.current && !animate) {
    for (const slot of series.current.values()) {
      if (slot.running) {
        slot.running = false;
        slot.epoch += 1;
      }
    }
  }
  wasAnimate.current = animate;

  const seriesSeen = new Map<string, number>();
  const stabilizeSeries = (el: ReactElement): ReactElement => {
    const props = el.props as SeriesProps;
    const base = el.key ?? `series:${String(props.dataKey ?? "")}`;
    const n = seriesSeen.get(base) ?? 0;
    seriesSeen.set(base, n + 1);
    const id = `${base}:${n}`;
    let slot = series.current.get(id);
    if (slot == null) {
      const created: SeriesSlot = { running: false, epoch: 0, onStart: undefined, onEnd: undefined, start: () => {}, end: () => {} };
      // One function per series for good: Recharts restarts an animation when its callbacks change.
      created.start = () => {
        created.running = true;
        created.onStart?.();
      };
      created.end = () => {
        created.running = false;
        created.onEnd?.();
      };
      series.current.set(id, created);
      slot = created;
    }
    slot.onStart = props.onAnimationStart;
    slot.onEnd = props.onAnimationEnd;
    const next: Partial<SeriesProps> & { key: string } = {
      key: `${el.key ?? ""}|e${slot.epoch}`,
      onAnimationStart: slot.start,
      onAnimationEnd: slot.end,
    };
    if (!animate) next.isAnimationActive = false;
    return cloneElement(el as ReactElement<SeriesProps>, next);
  };

  const seen = new Map<string, number>();
  const stabilizeAxis = (el: ReactElement, isX: boolean): ReactElement => {
    const props = el.props as Record<string, unknown>;
    const id = String((isX ? props.xAxisId : props.yAxisId) ?? 0);
    const base = `${isX ? "x" : "y"}:${id}`;
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    const slotKey = `${base}:${n}`;
    const slot = slots.current.get(slotKey) ?? { props: {}, fn: null, forwarder: null, signature: null };
    const next: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(props)) {
      if (k === "children" || k === "tickFormatter") continue;
      next[k] = isShareable(v) && k in slot.props ? replaceEqualDeep(slot.props[k], v) : v;
    }
    const fmt = props.tickFormatter;
    if (typeof fmt === "function") {
      slot.fn = fmt as Formatter;
      const signature = formatterProbeValues(isX, next, rows)
        .map((v) => String(slot.fn!(v, 0)))
        .join("\u0001");
      if (slot.forwarder == null || slot.signature !== signature) {
        slot.forwarder = (value, index) => slot.fn!(value, index);
        slot.signature = signature;
      }
      next.tickFormatter = slot.forwarder;
    } else {
      slot.fn = null;
      slot.forwarder = null;
      slot.signature = null;
    }
    slot.props = next;
    slots.current.set(slotKey, slot);
    return cloneElement(el, next);
  };

  const map = (node: ReactNode): ReactNode =>
    Children.map(node, (child) => {
      if (!isValidElement(child)) return child;
      if (child.type === XAxis) return stabilizeAxis(child, true);
      if (child.type === YAxis) return stabilizeAxis(child, false);
      if (isSeries(child.type)) return stabilizeSeries(child);
      // Fragments are walked; any other element is the chart's own component, left as it is.
      if (child.type !== Fragment) return child;
      return cloneElement(child, undefined, map((child.props as { children?: ReactNode }).children));
    });

  return { data: stableData, children: map(children) };
}

function isSeries(type: unknown): boolean {
  return type === Line || type === Area || type === Bar || type === Scatter;
}
