import { Children, cloneElement, isValidElement, useMemo, type ReactElement, type ReactNode } from "react";
import {
  Area,
  Bar,
  CartesianGrid,
  DefaultLegendContent,
  DefaultZIndexes,
  Legend,
  Line,
  ReferenceLine,
  XAxis,
  YAxis,
  ZIndexLayer,
  usePlotArea,
} from "recharts";
import type { Options } from "roughjs/bin/core";
import { AXIS_LINE_STROKE } from "./chartLayout";
import {
  LegendBoxIcon,
  LegendSquiggleIcon,
  barHatchSlots,
  roughAreaShape,
  roughBarShape,
  roughGridProps,
  roughLineShape,
  roughReferenceLineShape,
  roughSeed,
  sketchLine,
  subSeed,
  type AxisSide,
  type BarHatchSlot,
  type GeometryBarShape,
  type RoughMode,
} from "./roughShapes";

/**
 * The parts of the hand-drawn chart styles that touch Recharts at runtime: the legend content, the
 * rough axis lines and the injection that hands a chart's series their rough shapes. Kept apart
 * from `roughShapes.tsx` so the shapes, pens and swatches (used by eager UI such as the pills and
 * the sidebar markers) do not pull the chart engine into the entry chunk; only chart components,
 * which live in the lazy charts chunk, import this module.
 */

type LegendContentProps = { payload?: readonly { color?: string; type?: string; dataKey?: unknown }[] } & Record<string, unknown>;

/** A `<Legend>`'s `content` that hands every entry the squiggle icon, keeping the chart's own content. */
function roughLegendContent(original: unknown, barSlots: ReadonlyMap<string, BarHatchSlot>) {
  return (lp: LegendContentProps) => {
    // Recharts draws its built-in line / plainline / rect icons before it looks at `legendIcon`,
    // so each entry (except hidden ones) is re-typed to a symbol type that falls through to it,
    // and the legend's own `iconType` override is dropped.
    // A box entry (the plain legend's filled square, a bar series) gets a hand-drawn box; every
    // other entry a hand-drawn line.
    const payload = (lp.payload ?? []).map((e) =>
      e.type === "none"
        ? e
        : {
            ...e,
            type: "square",
            legendIcon:
              e.type === "rect" || e.type === "square" ? (
                // A bar series' box leans the way its bars do.
                <LegendBoxIcon color={e.color} hatchSlot={barSlots.get(dataKeyString(e.dataKey))} />
              ) : (
                <LegendSquiggleIcon color={e.color} />
              ),
          }
    );
    const next = { ...lp, payload, iconType: undefined };
    if (typeof original === "function") return (original as (p: LegendContentProps) => ReactNode)(next);
    if (isValidElement(original)) return cloneElement(original, next as Record<string, unknown>);
    return <DefaultLegendContent {...(next as object)} />;
  };
}


/**
 * The axis lines, hand-drawn: one rough line along each plot edge in `sides` (the originals are
 * hidden by `chart-rough.css`). A chart child, like `AlternatingXBands`: it reads the plot area
 * from the chart and paints in the axis layer. Tick lines stay the axis' own.
 */
export function RoughAxisLines({
  sides,
  seed,
  multiStroke,
}: {
  sides: readonly AxisSide[];
  seed: number;
  multiStroke: boolean;
}) {
  const plot = usePlotArea();
  const ds = useMemo(() => {
    if (!plot) return [];
    const { x, y, width, height } = plot;
    const out: string[] = [];
    const o: Options = { roughness: 1, bowing: 0.5, strokeWidth: 1, disableMultiStroke: !multiStroke };
    sides.forEach((side, i) => {
      const sd = subSeed(seed, i);
      if (side === "bottom") out.push(sketchLine(x, y + height, x + width, y + height, o, sd));
      else if (side === "top") out.push(sketchLine(x, y, x + width, y, o, sd));
      else if (side === "left") out.push(sketchLine(x, y, x, y + height, o, sd));
      else out.push(sketchLine(x + width, y, x + width, y + height, o, sd));
    });
    return out;
  }, [plot, sides, seed, multiStroke]);
  if (!ds.length) return null;
  return (
    <ZIndexLayer zIndex={DefaultZIndexes.axis}>
      <g className="nw-rough nw-rough--axis" pointerEvents="none">
        {ds.map((d, i) => (
          <path key={i} d={d} fill="none" stroke={AXIS_LINE_STROKE} strokeWidth={1} strokeLinecap="round" />
        ))}
      </g>
    </ZIndexLayer>
  );
}

type AxisElement = ReactElement<{ orientation?: AxisSide; hide?: boolean; children?: ReactNode }>;

/** The plot sides the chart's visible `<XAxis>` / `<YAxis>` children sit on (defaults bottom / left). */
export function roughAxisSides(node: ReactNode): AxisSide[] {
  const sides = new Set<AxisSide>();
  const walk = (n: ReactNode) => {
    Children.forEach(n, (child) => {
      if (!isValidElement(child)) return;
      const el = child as AxisElement;
      if (el.type === XAxis || el.type === YAxis) {
        if (el.props.hide) return;
        sides.add(el.props.orientation ?? (el.type === XAxis ? "bottom" : "left"));
        return;
      }
      if (el.props?.children != null) walk(el.props.children);
    });
  };
  walk(node);
  return [...sides];
}


// ---------------------------------------------------------------------------------------------
// Injection

type SeriesElement = ReactElement<{
  dataKey?: unknown;
  shape?: unknown;
  stroke?: string;
  children?: ReactNode;
  x?: unknown;
  y?: unknown;
  segment?: unknown;
  horizontal?: unknown;
  vertical?: unknown;
}>;

function dataKeyString(dk: unknown): string {
  return typeof dk === "string" || typeof dk === "number" ? String(dk) : "";
}

/**
 * Clone every `<Line>`, `<Bar>` and `<Area>` in `node` (recursively) with its rough shape and
 * the entrance animation off. Elements that already carry a `shape`, and lines whose stroke is
 * `transparent` / `none` (the hit layers behind the visible lines), are left alone so hover keeps
 * working as it does in the plain style. With `mode.extras`, `<ReferenceLine>`s get
 * {@link roughReferenceLineShape} (seeded from where they sit) and a `<CartesianGrid>` child the
 * rough grid-line renderers. `grainFilterId` names the chart's {@link RoughChartDefs} filter for a
 * pen with grain.
 */
export function injectRoughShapes(node: ReactNode, mode: RoughMode, grainFilterId?: string): ReactNode {
  // Each bar series of the chart gets its own hatch angle, spread evenly over the tuned range.
  const barKeys: string[] = [];
  collectBarSeriesKeys(node, barKeys);
  const barAngles = barHatchSlots(barKeys);
  return injectRoughShapesInner(node, mode, grainFilterId, barAngles);
}

/** The `dataKey`s of the `<Bar>`s in `node` (recursively), in drawing order, each once. */
function collectBarSeriesKeys(node: ReactNode, out: string[]): void {
  Children.forEach(node, (child) => {
    if (!isValidElement(child)) return;
    const el = child as SeriesElement;
    if (el.type === Bar) {
      const key = dataKeyString(el.props.dataKey);
      if (!out.includes(key)) out.push(key);
      return;
    }
    if (el.props?.children != null) collectBarSeriesKeys(el.props.children, out);
  });
}

function injectRoughShapesInner(
  node: ReactNode,
  mode: RoughMode,
  grainFilterId: string | undefined,
  barAngles: ReadonlyMap<string, BarHatchSlot>
): ReactNode {
  return Children.map(node, (child) => {
    if (!isValidElement(child)) return child;
    const el = child as SeriesElement;
    const props = el.props;
    if (el.type === Legend) {
      const legendContent = (props as { content?: unknown }).content;
      return cloneElement(el, { content: roughLegendContent(legendContent, barAngles) } as Partial<typeof props>);
    }
    if (el.type === ReferenceLine) {
      if (!mode.extras || props.shape != null) return child;
      const where = `${String(props.x ?? "")}|${String(props.y ?? "")}|${JSON.stringify(props.segment ?? null)}`;
      return cloneElement(el, {
        shape: roughReferenceLineShape(roughSeed(where, 1000 + mode.seedSalt), mode.multiStrokeExtras),
      } as Partial<typeof props>);
    }
    if (el.type === CartesianGrid) {
      return mode.extras ? cloneElement(el, roughGridProps(props, mode) as Partial<typeof props>) : child;
    }
    if (el.type === Line || el.type === Bar || el.type === Area) {
      const geometry =
        el.type === Bar && typeof props.shape === "function"
          ? (props.shape as Partial<GeometryBarShape>).roughGeometry
          : undefined;
      if (props.shape != null && !geometry) return child;
      if (el.type !== Bar && (props.stroke === "transparent" || props.stroke === "none")) return child;
      const seed = roughSeed(dataKeyString(props.dataKey), mode.seedSalt);
      const grain = mode.grain === "filter" ? grainFilterId : undefined;
      const shape =
        el.type === Line
          ? roughLineShape(seed, mode, grain)
          : el.type === Bar
            ? roughBarShape(seed, mode, grain, geometry, barAngles.get(dataKeyString(props.dataKey)))
            : roughAreaShape(seed, mode, grain);
      return cloneElement(el, { shape, isAnimationActive: false } as Partial<typeof props>);
    }
    const ch = props?.children;
    if (ch != null) {
      const mapped = injectRoughShapesInner(ch, mode, grainFilterId, barAngles);
      if (mapped !== ch) return cloneElement(el, { children: mapped } as { children: ReactNode });
    }
    return child;
  });
}
