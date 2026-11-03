import {
  Children,
  cloneElement,
  isValidElement,
  useId,
  useMemo,
  useState,
  type CSSProperties,
  type ReactElement,
  type ReactNode,
} from "react";
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
  type AreaRevealShapeProps,
  type BarShapeProps,
  type LineDrawShapeProps,
} from "recharts";
import { RoughGenerator } from "roughjs/bin/generator";
import type { Options } from "roughjs/bin/core";
import type { Point } from "roughjs/bin/geometry";
import { AXIS_LINE_STROKE } from "./chartLayout";
import type { ChartStyle } from "../../chartStylePreference";
import { useChartStyle } from "./chartStyle";

/**
 * The hand-drawn chart styles (rehearsal 2026-11-03): the series drawn by rough.js as if by a
 * pen, a pencil, a marker or a crayon. Recharts 3.9+ hands a `shape` the computed geometry of a
 * Line (`points`), an Area (`points` + `baseLine`) and a Bar (`x`, `y`, `width`, `height`), so
 * the sketch is a pure function of that geometry: no DOM, no post-processing. `injectRoughShapes`
 * is what the chart wrappers call when `useChartStyle()` is not `plain` — it clones every
 * `<Line>`, `<Bar>` and `<Area>` child with the matching shape (and the entrance animation off,
 * which the shapes ignore), every `<ReferenceLine>` with a rough shape and a `<CartesianGrid>`
 * child with rough grid-line renderers; `plain` never goes through it, so it stays byte-identical.
 *
 * A series line is drawn as HAND STROKES ({@link handStrokes}): the data-point polyline is cut
 * into strokes of a few dozen px, each drawn on its own with its own doubled trace, the next one
 * starting a little before the previous one ends (some overshoot, now and then a stray) — a hand
 * going over a line by short strokes, never one long parallel copy. Each stroke is rough.js
 * `line` / `linearPath` STRAIGHT through the data points — the series' curve
 * `type` is ignored on purpose: a monotone spline reads as computer-drawn whatever is laid on
 * top of it, and a hand draws point to point (`preserveVertices` keeps the segment ends on the
 * data). The pen TYPE is the stroke's texture ({@link ROUGH_MODES}, one row each): a stroke is
 * drawn as several passes, each its own `<path>` — generated single-stroke with its own seed, so
 * each pass has its own width, opacity, dash pattern and offset — in the series colour; a pencil
 * breaks its coverage with irregular dashes, a marker's overlapping passes read darker like a felt
 * tip, a crayon adds a grain filter ({@link RoughChartDefs}, defined per chart) that masks the
 * stroke with noise. Bar and area fills are rough.js hachure at the type's opacity and gap; an
 * area's edge is the type's line. The chart's other lines — axis lines, grid lines, reference
 * lines — are hand-drawn under every type too, with rough's doubled trace; `XAxis` / `YAxis` draw
 * theirs from props alone, so `styles/chart-rough.css` hides them and {@link RoughAxisLines}, a
 * chart child the wrappers add, redraws one along each plot edge ({@link roughAxisSides}).
 *
 * Stability: every sketch is seeded from the series' `dataKey` (bars: plus their index; passes:
 * plus the pass index), so a hover re-render — Recharts re-renders series as the tooltip moves —
 * redraws the same strokes; the generated paths are memoized on the geometry and the pen, and
 * `isActive` takes no part in them.
 *
 * Cost: rough.js emits a few hundred bytes per segment per pass, so a dense run (the
 * full-history daily series, ~3.700 points) is thinned to one kept point per `minPointGapPx`.
 */

type Pt = { x: number | null | undefined; y: number | null | undefined };

const generator = new RoughGenerator();

/** One pass of a stroke: its own `<path>`. */
export type PenPass = {
  /** Width for a series drawn at the reference width (1,5 px); scaled with the series' own. */
  width: number;
  opacity: number;
  dash?: string;
  dashOffset?: number;
  /** A CSS `blur()` radius (px) on this pass alone (its fade tails too): a marker's soft halo. */
  blur?: number;
};

/** The texture of one pen type. */
export type RoughPen = {
  /** rough.js knobs for every series stroke (lines, area edges, bar outlines). */
  roughness: number;
  bowing: number;
  /** rough's `maxRandomnessOffset`: how far a segment end may wander (px). */
  maxOffset: number;
  passes: readonly PenPass[];
  linecap: "round" | "butt";
  /** `mix-blend-mode` on the series group (a marker's overlaps on the dark background). */
  blend: "screen" | null;
  /** The crayon's noise mask ({@link RoughChartDefs}); `dash` keeps the dashes alone. */
  grain: "filter" | "dash" | null;
  /**
   * How much of the stroke the grain filter eats: the noise's alpha is 3·(r+g+b) − cutoff, so a
   * higher cutoff opens more gaps. Crayon 3.6 (visible gaps); a lower one only specks the ink.
   * Unset = 3.6.
   */
  grainCutoff?: number;
  /**
   * Density relief: where stacked strokes make the ink close to solid (alpha above this), the
   * grain lifts — fewer holes in dense overlaps. Unset = 0.8.
   */
  grainDenseFrom?: number;
  /**
   * The floor: a second, lighter grain (this cutoff) applied everywhere, so even a dense overlap
   * keeps some texture. Unset = no floor.
   */
  grainFloorCutoff?: number;
  /**
   * Soft edges: a CSS `blur()` radius (px) on the series group, so the ink bleeds instead of
   * ending on a hard edge (pen, marker). Null = crisp.
   */
  soft: number | null;
  /** The bar / area fill: rough.js hachure with this gap, line weight and opacity. */
  fillGap: number;
  fillWeight: number;
  fillOpacity: number;
  /** A dense run (daily) is thinned to this spacing between kept points, so segments stay segments. */
  minPointGapPx: number;
  /** How a series stroke's two ends are finished ({@link EndSpec}). */
  ends: EndSpec;
  /** Where the ink fails mid-line and how it is gone over again ({@link RepairSpec}). */
  repair: RepairSpec;
} & StrokeSpec;

/**
 * Ink that fails mid-line, and the hand going back over it (series lines and area edges only).
 * The FAILED spans are the main pass's interior faint spans: a fade-out at a stroke end that
 * another stroke follows, a fade-in at a stroke start that follows one, and DRY SKIPS — on
 * `skipChance` of the strokes a `skipLengthPx` piece in the middle of the main pass is dropped
 * (the other passes are thinned to 0,3 of their opacity there). The line's first start and last
 * end are not interior. Each failed span is REPAIRED with `repairChance`: a back-and-forth
 * scribble of `repairStrokes` short dashes covering it plus 2–4 px each side, alternating
 * direction, each 0,6–1,0 × the span, offset across the line by `repairOffsetPx` (seeded sign),
 * turning in a tight 1–2 px hook; a small ink dot ends 30% of them. Unrepaired spans stay faint.
 */
export type RepairSpec = {
  skipChance: number;
  skipLengthPx: readonly [number, number];
  repairChance: number;
  repairStrokes: readonly [number, number];
  repairOffsetPx: readonly [number, number];
};

/**
 * The ends of a series stroke (lines and area edges; ruled lines and bar outlines keep plain
 * ends). Each end of each hand stroke gets at most one treatment, seeded per end:
 * - an INK DOT (the pen pressed down before moving, or held at the end): a small noisy blob on
 *   the end point, radius `dotRadius` × the main pass width (min 0,9 px), only on the main pass
 *   (highest opacity, then widest); starts get it ×1,3 as often, ends ×0,7;
 * - a FADE (the pen leaving the paper while moving): the last `fadeLengthPx` of the stroke drawn
 *   in `fadeSteps` pieces stepping down to 0,15 of the pass opacity and 0,4 of its width,
 *   drifting 0,5–1,5 px off the line; `fadeInChance` is the same at a stroke's start (the pen
 *   landing while already moving). The faded part replaces that part of the stroke.
 * A stroke with a treated end keeps its vertices (`preserveVertices`), so the dot or the taper
 * meets the drawn end exactly.
 */
export type EndSpec = {
  dotChance: number;
  dotRadius: readonly [number, number];
  fadeChance: number;
  fadeInChance: number;
  fadeLengthPx: readonly [number, number];
  fadeSteps: number;
};

/**
 * How a line is cut into hand strokes ({@link handStrokes}): each stroke runs a seeded length in
 * [strokeMinPx, strokeMaxPx] (ending at a data point, or inside a segment longer than the max);
 * the next one starts `overlapPx` back along the line and the previous one runs `overshootPx` past
 * the cut; about `strayChance` of the joins get a stray (a long overshoot or a kinked start).
 */
export type StrokeSpec = {
  strokeMinPx: number;
  strokeMaxPx: number;
  overlapPx: readonly [number, number];
  overshootPx: readonly [number, number];
  strayChance: number;
};

/** The ruled lines (axes, grid, reference lines): longer strokes, the same joins. */
const RULED_STROKES: StrokeSpec = {
  strokeMinPx: 80,
  strokeMaxPx: 220,
  overlapPx: [1, 4],
  overshootPx: [0, 4],
  strayChance: 0.15,
};

const PEN_STROKES: StrokeSpec = {
  strokeMinPx: 30,
  strokeMaxPx: 90,
  overlapPx: [1, 4],
  overshootPx: [0, 4],
  strayChance: 0.15,
};

const WIDE_STROKES: StrokeSpec = { ...PEN_STROKES, strokeMinPx: 45, strokeMaxPx: 130 };

/** What a chart style asks of the rough layer; null for a style that is not rough at all. */
export type RoughMode = RoughPen & {
  /** Hand-drawn axis lines, grid lines and reference lines too. */
  extras: boolean;
  /** rough's doubled stroke on those non-series lines. */
  multiStrokeExtras: boolean;
  /** Salts every seed, so two types side by side do not share their strokes. */
  seedSalt: number;
};

/** The reference series width the pass widths are stated for. */
const REFERENCE_SERIES_WIDTH = 1.5;

/**
 * One row per pen type — the knobs that tell them apart (the lab page shows them side by side).
 * Entries are constants so a wrapper's memo on the mode holds between renders.
 */
const ROUGH_MODES: Record<Exclude<ChartStyle, "plain">, RoughMode> = {
  // Fine and translucent ink: a faint wide bleed under a main pass and a lighter second
  // trace, the whole stroke slightly blurred so its edges are soft.
  pen: {
    roughness: 1.5,
    bowing: 1.5,
    maxOffset: 2.5,
    passes: [
      { width: 3.2, opacity: 0.12 },
      { width: 1.4, opacity: 0.6 },
      { width: 0.9, opacity: 0.35 },
    ],
    linecap: "round",
    blend: null,
    grain: null,
    soft: 0.45,
    fillGap: 4,
    fillWeight: 0.8,
    fillOpacity: 0.85,
    minPointGapPx: 8,
    ends: { dotChance: 0.35, dotRadius: [0.55, 0.9], fadeChance: 0.4, fadeInChance: 0.15, fadeLengthPx: [8, 18], fadeSteps: 3 },
    repair: { skipChance: 0.12, skipLengthPx: [6, 14], repairChance: 0.75, repairStrokes: [3, 5], repairOffsetPx: [0.4, 1.2] },
    ...PEN_STROKES,
    extras: true,
    multiStrokeExtras: true,
    seedSalt: 1,
  },
  // Three light passes whose irregular dashes break the coverage into grain.
  pencil: {
    roughness: 1.8,
    bowing: 1.2,
    maxOffset: 2.5,
    passes: [
      { width: 1.1, opacity: 0.45, dash: "7 1.5 4 1 9 2", dashOffset: 0 },
      { width: 0.9, opacity: 0.45, dash: "7 1.5 4 1 9 2", dashOffset: 5 },
      { width: 1, opacity: 0.45, dash: "7 1.5 4 1 9 2", dashOffset: 11 },
    ],
    linecap: "butt",
    blend: null,
    grain: null,
    soft: null,
    fillGap: 4,
    fillWeight: 0.7,
    fillOpacity: 0.5,
    minPointGapPx: 8,
    ends: { dotChance: 0.15, dotRadius: [0.55, 0.9], fadeChance: 0.5, fadeInChance: 0.15, fadeLengthPx: [8, 18], fadeSteps: 3 },
    repair: { skipChance: 0.08, skipLengthPx: [6, 14], repairChance: 0.6, repairStrokes: [3, 5], repairOffsetPx: [0.4, 1.2] },
    ...PEN_STROKES,
    extras: true,
    multiStrokeExtras: true,
    seedSalt: 2,
  },
  // A felt tip: a solid core (a main trace and a lighter second one, diverging stroke by stroke)
  // inside a wider halo that alone is blurred, so the line is solid at the centre and soft at
  // the edges.
  marker: {
    roughness: 1.2,
    bowing: 1.8,
    maxOffset: 2.5,
    passes: [
      // Marker on rough paper: a faint blurred bleed, a core that is not quite solid, and a
      // light grain that specks the ink where the paper's tooth skipped it.
      { width: 5.4, opacity: 0.14, blur: 1.1 },
      { width: 2.5, opacity: 0.7 },
      { width: 1.9, opacity: 0.38 },
    ],
    linecap: "butt",
    blend: null,
    grain: "filter",
    grainCutoff: 2.3,
    soft: null,
    fillGap: 6,
    fillWeight: 2.5,
    fillOpacity: 0.5,
    minPointGapPx: 8,
    ends: { dotChance: 0.3, dotRadius: [0.55, 0.9], fadeChance: 0.35, fadeInChance: 0.15, fadeLengthPx: [8, 18], fadeSteps: 3 },
    repair: { skipChance: 0.08, skipLengthPx: [6, 14], repairChance: 0.5, repairStrokes: [3, 5], repairOffsetPx: [0.4, 1.2] },
    ...WIDE_STROKES,
    extras: true,
    multiStrokeExtras: true,
    seedSalt: 3,
  },
  // The former marker: two wide see-through passes over a fainter, wider bleed, the whole
  // stroke blurred — it reads as a wash, like watercolour.
  watercolor: {
    roughness: 1.2,
    bowing: 1.8,
    maxOffset: 2.5,
    passes: [
      { width: 5.4, opacity: 0.1 },
      { width: 3.5, opacity: 0.3 },
      { width: 2.7, opacity: 0.3 },
    ],
    linecap: "butt",
    blend: "screen",
    grain: null,
    soft: 0.65,
    fillGap: 6,
    fillWeight: 2.5,
    fillOpacity: 0.5,
    minPointGapPx: 8,
    ends: { dotChance: 0.15, dotRadius: [0.55, 0.9], fadeChance: 0.35, fadeInChance: 0.15, fadeLengthPx: [8, 18], fadeSteps: 3 },
    repair: { skipChance: 0.06, skipLengthPx: [6, 14], repairChance: 0.3, repairStrokes: [3, 5], repairOffsetPx: [0.4, 1.2] },
    ...WIDE_STROKES,
    extras: true,
    multiStrokeExtras: true,
    seedSalt: 5,
  },
  // Four faint wide passes with coarse dashes, masked by a noise grain into visible gaps.
  crayon: {
    roughness: 2.2,
    bowing: 2,
    maxOffset: 3.5,
    passes: [
      { width: 3, opacity: 0.28, dash: "5 2 3 1.5 8 3", dashOffset: 0 },
      { width: 3, opacity: 0.28, dash: "5 2 3 1.5 8 3", dashOffset: 6 },
      { width: 3, opacity: 0.28, dash: "5 2 3 1.5 8 3", dashOffset: 12 },
      { width: 3, opacity: 0.28, dash: "5 2 3 1.5 8 3", dashOffset: 17 },
    ],
    linecap: "round",
    blend: null,
    grain: "filter",
    grainDenseFrom: 0.75,
    grainFloorCutoff: 1.7,
    soft: null,
    fillGap: 6,
    fillWeight: 2,
    fillOpacity: 0.4,
    minPointGapPx: 8,
    ends: { dotChance: 0.1, dotRadius: [0.55, 0.9], fadeChance: 0.45, fadeInChance: 0.15, fadeLengthPx: [8, 18], fadeSteps: 3 },
    repair: { skipChance: 0.1, skipLengthPx: [6, 14], repairChance: 0.4, repairStrokes: [3, 5], repairOffsetPx: [0.4, 1.2] },
    ...WIDE_STROKES,
    extras: true,
    multiStrokeExtras: true,
    seedSalt: 4,
  },
};

export function roughModeFor(style: ChartStyle): RoughMode | null {
  return style === "plain" ? null : (ROUGH_MODES[style as Exclude<ChartStyle, "plain">] ?? null);
}

/** FNV-1a over the series key: a stable, non-zero seed per series. */
export function roughSeed(key: string | number | undefined, salt = 0): number {
  let h = 0x811c9dc5;
  const s = `${key ?? ""}|${salt}`;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  // rough treats seed 0 as "random each call"; keep it in [1, 2^31).
  return (h % 2147483646) + 1;
}

function isDefined(p: Pt): p is { x: number; y: number } {
  return typeof p.x === "number" && typeof p.y === "number" && Number.isFinite(p.x) && Number.isFinite(p.y);
}

/** Runs of consecutive defined points; with `connectNulls` one run over every defined point. */
function pointRuns(points: readonly Pt[], connectNulls: boolean | undefined): Point[][] {
  if (connectNulls) {
    const run = points.filter(isDefined).map((p): Point => [p.x, p.y]);
    return run.length ? [run] : [];
  }
  const runs: Point[][] = [];
  let cur: Point[] = [];
  for (const p of points) {
    if (isDefined(p)) cur.push([p.x, p.y]);
    else if (cur.length) {
      runs.push(cur);
      cur = [];
    }
  }
  if (cur.length) runs.push(cur);
  return runs;
}

/**
 * A dense run thinned to at least `gapPx` between kept points (first and last kept): rough's
 * segments must stay visible as segments, and a daily series puts a point on every pixel.
 */
function thinByGap(run: Point[], gapPx: number): Point[] {
  if (run.length <= 2 || gapPx <= 0) return run;
  const out: Point[] = [run[0]!];
  let last = run[0]!;
  for (let i = 1; i < run.length - 1; i++) {
    const p = run[i]!;
    if (Math.hypot(p[0] - last[0], p[1] - last[1]) >= gapPx) {
      out.push(p);
      last = p;
    }
  }
  out.push(run[run.length - 1]!);
  return out;
}

/** mulberry32: a small seeded PRNG, so a line is cut and joined the same way on every render. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A seed derived from `seed` and an index, kept in rough's [1, 2^31) (0 means «random»). */
function subSeed(seed: number, i: number): number {
  return ((seed + i * 104729) % 2147483646) + 1;
}

const between = (rnd: () => number, [lo, hi]: readonly [number, number]) => lo + rnd() * (hi - lo);
const dist = (a: Point, b: Point) => Math.hypot(b[0] - a[0], b[1] - a[1]);
const lerp = (a: Point, b: Point, t: number): Point => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
const polyLength = (pts: readonly Point[]) => pts.reduce((n, p, i) => (i ? n + dist(pts[i - 1]!, p) : 0), 0);

/**
 * The polyline cut into strokes: each runs until it reaches a seeded target length in
 * [strokeMinPx, strokeMaxPx], ending at the vertex that reaches it — or, inside a segment longer
 * than strokeMaxPx, at the interpolated point that does; a stroke never takes a further segment
 * that would carry it past strokeMaxPx. A short tail joins the previous stroke.
 */
function cutIntoStrokes(run: readonly Point[], spec: StrokeSpec, rnd: () => number): Point[][] {
  if (run.length < 2) return [];
  const draw = () => between(rnd, [spec.strokeMinPx, spec.strokeMaxPx]);
  const strokes: Point[][] = [];
  let cur: Point[] = [run[0]!];
  let pos = run[0]!;
  let acc = 0;
  let target = draw();
  for (let i = 1; i < run.length; i++) {
    const v = run[i]!;
    for (;;) {
      const segLen = dist(pos, v);
      if (segLen === 0) break;
      // Never past the max by taking one more segment: end at the vertex already reached.
      if (acc > 0 && acc + segLen > spec.strokeMaxPx) {
        strokes.push(cur);
        cur = [pos];
        acc = 0;
        target = draw();
        continue;
      }
      if (acc + segLen < target) {
        cur.push(v);
        acc += segLen;
        pos = v;
        break;
      }
      if (segLen > spec.strokeMaxPx) {
        const c = lerp(pos, v, (target - acc) / segLen);
        cur.push(c);
        strokes.push(cur);
        cur = [c];
        pos = c;
        acc = 0;
        target = draw();
        continue;
      }
      cur.push(v);
      strokes.push(cur);
      cur = [v];
      pos = v;
      acc = 0;
      target = draw();
      break;
    }
  }
  if (cur.length >= 2) {
    if (strokes.length && polyLength(cur) < spec.strokeMinPx * 0.4) strokes[strokes.length - 1]!.push(...cur.slice(1));
    else strokes.push(cur);
  }
  return strokes;
}

/**
 * Joins like a hand: the previous stroke runs on past the cut (overshoot), the next starts a
 * little before it, backed up along the line (overlap); a stray join overshoots further or starts
 * the next stroke slightly off the line, at an angle.
 */
function joinStrokes(strokes: readonly Point[][], spec: StrokeSpec, rnd: () => number): Point[][] {
  const out = strokes.map((st) => [...st]);
  for (let k = 0; k + 1 < strokes.length; k++) {
    const prev = strokes[k]!;
    const a = prev[prev.length - 2]!;
    const b = prev[prev.length - 1]!;
    const len = dist(a, b) || 1;
    const u: Point = [(b[0] - a[0]) / len, (b[1] - a[1]) / len];
    const stray = rnd() < spec.strayChance;
    const kink = stray && rnd() < 0.5;
    const overshoot = stray && !kink ? between(rnd, [5, 9]) : between(rnd, spec.overshootPx);
    const overlap = Math.min(between(rnd, spec.overlapPx), len * 0.5);
    const prevOut = out[k]!;
    prevOut[prevOut.length - 1] = [b[0] + u[0] * overshoot, b[1] + u[1] * overshoot];
    let start: Point = [b[0] - u[0] * overlap, b[1] - u[1] * overlap];
    if (kink) {
      const off = between(rnd, [1.5, 3]) * (rnd() < 0.5 ? -1 : 1);
      start = [start[0] - u[1] * off, start[1] + u[0] * off];
    }
    out[k + 1]!.unshift(start);
  }
  return out;
}

/** A run as hand strokes: cut, then joined. */
export function handStrokes(run: readonly Point[], spec: StrokeSpec, rnd: () => number): Point[][] {
  return joinStrokes(cutIntoStrokes(run, spec, rnd), spec, rnd);
}

/**
 * Every stroke drawn on its own — a rough.js `line` (one segment) or `linearPath` with its own
 * seed and its own doubled trace (unless `options.disableMultiStroke`) — concatenated into ONE
 * path `d` (one `M` subpath per stroke trace), so a pass stays one element.
 */
function drawStrokes(
  strokes: readonly Point[][],
  options: Options,
  seed: number,
  pinned?: readonly boolean[]
): string {
  const ds: string[] = [];
  strokes.forEach((st, i) => {
    if (st.length < 2) return;
    const o = { ...options, seed: subSeed(seed, i), ...(pinned?.[i] ? { preserveVertices: true } : null) };
    const drawable =
      st.length === 2 ? generator.line(st[0]![0], st[0]![1], st[1]![0], st[1]![1], o) : generator.linearPath(st, o);
    for (const info of generator.toPaths(drawable)) if (info.d) ds.push(info.d);
  });
  return ds.join(" ");
}

/**
 * A pass's rough.js options: the doubled trace ON per stroke (so the doubles diverge stroke by
 * stroke) and `preserveVertices` OFF so a stroke's ends wander — rough has no per-vertex switch,
 * so a data point inside a stroke may move by up to `maxOffset` too.
 */
function passOptions(pen: RoughPen, width: number): Options {
  return {
    roughness: pen.roughness,
    bowing: pen.bowing,
    maxRandomnessOffset: pen.maxOffset,
    disableMultiStroke: false,
    preserveVertices: false,
    strokeWidth: width,
  };
}

/**
 * A pen used with care, for a shape's outline (a bar's sides): about two thirds of the line
 * pen's roughness, bow and wobble, so the sides come out straighter than a free line.
 */
function carefulPenOptions(pen: RoughPen, width: number): Options {
  return {
    ...passOptions(pen, width),
    roughness: pen.roughness * 0.65,
    bowing: pen.bowing * 0.6,
    maxRandomnessOffset: pen.maxOffset * 0.65,
  };
}

/**
 * A pass along its {@link handPath}: no bow of its own (the path carries the bow) and a small
 * wobble.
 */
function tracingPenOptions(pen: RoughPen, width: number): Options {
  return {
    ...passOptions(pen, width),
    roughness: pen.roughness * 0.45,
    bowing: 0,
    maxRandomnessOffset: Math.min(pen.maxOffset * 0.35, 0.9),
  };
}

/**
 * Where a hand means to take each side of a stroke: a bow to one side of up to about 1,2% of its
 * length × the pen's bow (6 px at most). Decided once per stroke, shared by every pass.
 */
function sideBows(stroke: readonly Point[], pen: RoughPen, rnd: () => number): number[] {
  return stroke.slice(1).map((b, i) => {
    const a = stroke[i]!;
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    return Math.max(-6, Math.min(6, (rnd() * 2 - 1) * len * 0.012 * pen.bowing));
  });
}

/**
 * One pass's path along a stroke of straight sides: it goes the way the hand meant
 * ({@link sideBows}) but on its own line — the bow scaled by 0,6–1,2 and nudged by up to
 * 1,5 px, the whole side shifted up to 1,2 px off, a little wobble, the corners up to 0,8 px
 * apart — so later passes run near the first, in its direction, without retracing it.
 */
function handPath(stroke: readonly Point[], pen: RoughPen, bows: readonly number[], rnd: () => number): Point[] {
  const jitter = (v: number) => (rnd() * 2 - 1) * v;
  const corner = (pt: Point): Point => [pt[0] + jitter(0.8), pt[1] + jitter(0.8)];
  const out: Point[] = [corner(stroke[0]!)];
  for (let i = 1; i < stroke.length; i++) {
    const [ax, ay] = stroke[i - 1]!;
    const [bx, by] = stroke[i]!;
    const len = Math.hypot(bx - ax, by - ay);
    if (len < 0.5) continue;
    const nx = -(by - ay) / len;
    const ny = (bx - ax) / len;
    const bow = bows[i - 1]! * (0.6 + rnd() * 0.6) + jitter(1.5);
    const shift = jitter(1.2);
    const wobble = Math.min(pen.maxOffset * 0.25, 0.6);
    const n = Math.max(2, Math.ceil(len / 14));
    for (let j = 1; j < n; j++) {
      const t = j / n;
      const off = bow * 4 * t * (1 - t) + shift * Math.min(1, 4 * t * (1 - t) * 2) + jitter(wobble);
      out.push([ax + (bx - ax) * t + nx * off, ay + (by - ay) * t + ny * off]);
    }
    out.push(corner([bx, by]));
  }
  return out;
}

/** The pass width for a series drawn at `seriesWidth` (its own `strokeWidth`). */
function passWidth(pass: PenPass, seriesWidth: number): number {
  const scale = Math.min(1.6, Math.max(0.75, seriesWidth / REFERENCE_SERIES_WIDTH));
  return pass.width * scale;
}

/** One opacity step of a pass's faded ends: every piece at that step in one `d`. */
type TailPath = { d: string; opacity: number; width: number };

/** A stroke's pass, ready to render: every hand stroke of the pass in one `d`, plus its fades. */
type PassPath = {
  d: string;
  pass: PenPass;
  width: number;
  strokes: number;
  tails?: TailPath[];
  /** The other passes over a dry skip of the main pass: drawn at 0,3 of the pass opacity. */
  dim?: string;
  /** The main pass's repair scribbles, one `d` (drawn at the pass opacity × 1,1). */
  repairs?: string;
};

/** A series' strokes: the passes, and every ink dot in one `d` (filled at the main pass's opacity). */
type SeriesStrokes = {
  passes: PassPath[];
  dots: string;
  dotOpacity: number;
  /** Interior faint spans of the main pass, and how many got a repair scribble (stats). */
  failed: number;
  repaired: number;
  /** The main pass's path (full ink + repairs), for the coverage check. */
  main: PassPath | null;
};

/** The main pass: highest opacity, then the widest (the bleed passes are faint). */
function mainPassIndex(passes: readonly PenPass[]): number {
  let best = 0;
  passes.forEach((p, i) => {
    const b = passes[best]!;
    if (p.opacity > b.opacity || (p.opacity === b.opacity && p.width > b.width)) best = i;
  });
  return best;
}

type EndKind = "dot" | "fade" | null;

/** One end's treatment; dots only on the main pass. Always draws one number, so seeds stay aligned. */
function endKind(rnd: () => number, ends: EndSpec, isMain: boolean, which: "start" | "end"): EndKind {
  const r = rnd();
  const dotP = isMain ? ends.dotChance * (which === "start" ? 1.3 : 0.7) : 0;
  if (r < dotP) return "dot";
  const fadeP = which === "start" ? ends.fadeInChance : ends.fadeChance;
  return r < dotP + fadeP ? "fade" : null;
}

/** The polyline split at arc length `s`: [up to the cut, from the cut], the cut point in both. */
function splitAtLength(pts: readonly Point[], s: number): [Point[], Point[]] {
  let acc = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]!;
    const b = pts[i]!;
    const d = dist(a, b);
    if (acc + d >= s) {
      const c = d ? lerp(a, b, (s - acc) / d) : a;
      return [[...pts.slice(0, i), c], [c, ...pts.slice(i)]];
    }
    acc += d;
  }
  const last = pts[pts.length - 1]!;
  return [[...pts], [last, last]];
}

const fmt = (n: number) => (Math.round(n * 100) / 100).toString();

/** Opacity and width factors of fade step `k` of `n`: down to 0,15 and 0,4 at the free end. */
function fadeStepFactors(k: number, n: number): { opacity: number; width: number } {
  const t = (k + 1) / n;
  return { opacity: 1 - 0.85 * t, width: 1 - 0.6 * t };
}

/**
 * A taper ordered from the solid end to the free end, cut into `steps` pieces of equal length,
 * each point pushed off the line along the taper's normal by drift × t² (t = how far along).
 * One plain polyline `d` per piece (the pieces are a few px: rough adds nothing there).
 */
function taperPieces(taper: readonly Point[], steps: number, rnd: () => number): string[] {
  const len = polyLength(taper);
  const a = taper[0]!;
  const b = taper[taper.length - 1]!;
  const l = dist(a, b) || 1;
  const n: Point = [-(b[1] - a[1]) / l, (b[0] - a[0]) / l];
  const drift = between(rnd, [0.5, 1.5]) * (rnd() < 0.5 ? -1 : 1);
  const out: string[] = [];
  let rest: Point[] = [...taper];
  for (let k = 0; k < steps; k++) {
    const pieceLen = len / steps;
    const [piece, after] = k === steps - 1 ? [rest, rest] : splitAtLength(rest, pieceLen);
    let acc = k * pieceLen;
    const shifted = piece.map((p, i) => {
      if (i) acc += dist(piece[i - 1]!, p);
      const t = len ? acc / len : 0;
      const off = drift * t * t;
      return [p[0] + n[0] * off, p[1] + n[1] * off] as Point;
    });
    out.push(`M${shifted.map((p) => `${fmt(p[0])} ${fmt(p[1])}`).join(" L")}`);
    rest = after;
  }
  return out;
}

/** A small noisy ink blob: ~8 jittered vertices joined by quadratic curves through their midpoints. */
function inkDot(c: Point, r: number, rnd: () => number): string {
  const n = 8;
  const pts: Point[] = Array.from({ length: n }, (_, i) => {
    const a = (i / n) * 2 * Math.PI + (rnd() - 0.5) * 0.35;
    const rr = r * (1 + (rnd() - 0.5) * 0.6);
    return [c[0] + Math.cos(a) * rr, c[1] + Math.sin(a) * rr];
  });
  const mid = (p: Point, q: Point): Point => [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
  const m0 = mid(pts[n - 1]!, pts[0]!);
  let d = `M${fmt(m0[0])} ${fmt(m0[1])}`;
  for (let i = 0; i < n; i++) {
    const m = mid(pts[i]!, pts[(i + 1) % n]!);
    d += ` Q${fmt(pts[i]![0])} ${fmt(pts[i]![1])} ${fmt(m[0])} ${fmt(m[1])}`;
  }
  return `${d} Z`;
}

/** Cumulative arc length at each vertex. */
function cumLengths(run: readonly Point[]): number[] {
  const out = [0];
  for (let i = 1; i < run.length; i++) out.push(out[i - 1]! + dist(run[i - 1]!, run[i]!));
  return out;
}

/** The arc position on `run` of the point of it nearest `pt`. */
function projectArc(run: readonly Point[], cum: readonly number[], pt: Point): number {
  let best = Infinity;
  let at = 0;
  for (let i = 1; i < run.length; i++) {
    const a = run[i - 1]!;
    const b = run[i]!;
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const l2 = dx * dx + dy * dy;
    const t = l2 ? Math.max(0, Math.min(1, ((pt[0] - a[0]) * dx + (pt[1] - a[1]) * dy) / l2)) : 0;
    const d = Math.hypot(a[0] + dx * t - pt[0], a[1] + dy * t - pt[1]);
    if (d < best) {
      best = d;
      at = cum[i - 1]! + Math.sqrt(l2) * t;
    }
  }
  return at;
}

/** The piece of `pts` between arc positions s0 and s1. */
function sliceArc(pts: readonly Point[], s0: number, s1: number): Point[] {
  const [, rest] = splitAtLength(pts, Math.max(0, s0));
  return splitAtLength(rest, Math.max(0, s1 - Math.max(0, s0)))[0];
}

/** The point at arc position `u` on `pts`, and the unit tangent there. */
function alongAt(pts: readonly Point[], u: number): { p: Point; t: Point } {
  let acc = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]!;
    const b = pts[i]!;
    const d = dist(a, b);
    if (acc + d >= u || i === pts.length - 1) {
      const k = d ? Math.max(0, Math.min(1, (u - acc) / d)) : 0;
      return { p: lerp(a, b, k), t: d ? [(b[0] - a[0]) / d, (b[1] - a[1]) / d] : [1, 0] };
    }
    acc += d;
  }
  return { p: pts[0]!, t: [1, 0] };
}

/** A faint span on one run of the series: [s0, s1] in arc length along the (thinned) run. */
type Span = { run: number; s0: number; s1: number };

/**
 * The back-and-forth scribble over a failed span: dashes along the line alternating direction,
 * each offset across it, joined by tight hooks (a point just past the reversal, halfway between
 * the two offsets) — one polyline, drawn quick and low-rough.
 */
/** `poly` shifted sideways by `off` px (normal of each segment, averaged at the joints). */
function offsetPolyline(poly: readonly Point[], off: number): Point[] {
  return poly.map((p, i) => {
    const a = poly[Math.max(0, i - 1)]!;
    const b = poly[Math.min(poly.length - 1, i + 1)]!;
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const len = Math.hypot(dx, dy) || 1;
    return [p[0] - (dy / len) * off, p[1] + (dx / len) * off] as Point;
  });
}

function repairScribble(piece: readonly Point[], spec: RepairSpec, rnd: () => number): { poly: Point[]; end: Point } {
  const span = polyLength(piece);
  const n = Math.round(between(rnd, spec.repairStrokes));
  const sign = rnd() < 0.5 ? -1 : 1;
  const at = (u: number, off: number): Point => {
    const { p, t } = alongAt(piece, Math.max(0, Math.min(span, u)));
    return [p[0] - t[1] * off, p[1] + t[0] * off];
  };
  const poly: Point[] = [];
  let u = rnd() * span * 0.25;
  let prevOff = 0;
  for (let i = 0; i < n; i++) {
    const forward = i % 2 === 0;
    const len = between(rnd, [0.6, 1.0]) * span;
    const off = between(rnd, spec.repairOffsetPx) * (i % 2 === 0 ? sign : -sign) * (0.5 + 0.5 * rnd());
    if (i > 0) {
      // The hook: 1–2 px past the reversal, between the two offsets.
      const hook = between(rnd, [1, 2]) * (forward ? -1 : 1);
      poly.push(at(u + hook, (prevOff + off) / 2));
    }
    const start = u;
    const end = forward ? Math.min(span, start + len) : Math.max(0, start - len);
    poly.push(at(start, off), at((start + end) / 2, off), at(end, off));
    u = end;
    prevOff = off;
  }
  return { poly, end: poly[poly.length - 1]! };
}

/**
 * The geometry a series' main pass inks at full strength, gathered for {@link inkCoverage}: the
 * thinned runs the strokes follow, the main pass's full-ink bodies (fade tails and dry skips cut
 * out) and the repair scribbles, all before rough.js draws them, plus the main pass width.
 */
export type InkGeometry = { runs: Point[][]; fullInk: Point[][]; repairs: Point[][]; width: number };

/**
 * The longest stretches (px) of a series' line left without full ink: each thinned run sampled
 * every 1 px, a sample covered when a full-ink main-pass segment or a repair scribble passes within
 * the main pass width of it. A stretch touching a run's first or last point is the line's true
 * start or end — a deliberate fade there is allowed, bounded by the pen's fade length — and is
 * reported apart from the interior ones, which must stay tiny. Runs are checked one by one, so a
 * null in the data (a new run) is the only break. Segments are bucketed on a 4 px grid.
 */
export function inkCoverage(
  runs: Point[][],
  pen: RoughPen,
  seed: number,
  seriesWidth: number
): { longestInteriorGapPx: number; longestEndGapPx: number } {
  const geo: InkGeometry = { runs: [], fullInk: [], repairs: [], width: 0 };
  strokePasses(runs, pen, seed, seriesWidth, geo);
  const reach = geo.width;
  const cell = 4;
  const grid = new Map<string, [Point, Point][]>();
  const addSeg = (a: Point, b: Point) => {
    const x0 = Math.floor((Math.min(a[0], b[0]) - reach) / cell);
    const x1 = Math.floor((Math.max(a[0], b[0]) + reach) / cell);
    const y0 = Math.floor((Math.min(a[1], b[1]) - reach) / cell);
    const y1 = Math.floor((Math.max(a[1], b[1]) + reach) / cell);
    for (let x = x0; x <= x1; x++)
      for (let y = y0; y <= y1; y++) {
        const k = `${x},${y}`;
        const list = grid.get(k);
        if (list) list.push([a, b]);
        else grid.set(k, [[a, b]]);
      }
  };
  for (const poly of [...geo.fullInk, ...geo.repairs]) for (let i = 1; i < poly.length; i++) addSeg(poly[i - 1]!, poly[i]!);
  const covered = (p: Point) => {
    const list = grid.get(`${Math.floor(p[0] / cell)},${Math.floor(p[1] / cell)}`);
    if (!list) return false;
    for (const [a, b] of list) {
      const dx = b[0] - a[0];
      const dy = b[1] - a[1];
      const l2 = dx * dx + dy * dy;
      const t = l2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2)) : 0;
      if (Math.hypot(a[0] + dx * t - p[0], a[1] + dy * t - p[1]) <= reach) return true;
    }
    return false;
  };
  let interior = 0;
  let ends = 0;
  for (const run of geo.runs) {
    const total = polyLength(run);
    let gapStart: number | null = null;
    const close = (to: number) => {
      if (gapStart == null) return;
      const len = to - gapStart;
      if (gapStart < 1 || to > total - 1) ends = Math.max(ends, len);
      else interior = Math.max(interior, len);
      gapStart = null;
    };
    for (let u = 0; u <= total; u += 1) {
      if (covered(alongAt(run, u).p)) close(u);
      else if (gapStart == null) gapStart = u;
    }
    close(total);
  }
  return { longestInteriorGapPx: interior, longestEndGapPx: ends };
}

/** The pen of a chart style, for tests and tooling (null for `plain`). */
export function roughPenFor(style: ChartStyle): RoughPen | null {
  return roughModeFor(style);
}

/**
 * Every pass of the pen over the series' runs: each pass cuts the (thinned) data-point polyline
 * into its own hand strokes (seeded per pass, so the passes break at different places) and draws
 * them one by one; one {@link PassPath} per pass. Each stroke end is then finished per
 * {@link EndSpec}: an ink dot (main pass only) or a fade, whose pieces replace that part of the
 * stroke and are grouped by step into the pass's `tails`. The main pass is drawn first: its
 * interior faint spans and dry skips ({@link RepairSpec}) are the failed spans; the other passes
 * are dimmed over its skips, and the repair scribbles go into the main pass's `repairs`.
 */
export function strokePasses(
  runs: Point[][],
  pen: RoughPen,
  seed: number,
  seriesWidth: number,
  collect?: InkGeometry,
  /**
   * The series is drawn with its own dash pattern. Its repairs then re-trace the span forward
   * in that pattern (two passes a little off the line) instead of a back-and-forth scribble,
   * whose doubling-back would pile the dashes into a solid patch.
   */
  dashed = false
): SeriesStrokes {
  const results: (PassPath | null)[] = pen.passes.map(() => null);
  const dots: string[] = [];
  const main = mainPassIndex(pen.passes);
  const ends = pen.ends;
  const spec = pen.repair;
  const steps = Math.max(1, Math.round(ends.fadeSteps));
  const thinned = runs.map((run) => thinByGap(run, pen.minPointGapPx));
  const cums = thinned.map(cumLengths);
  if (collect) collect.runs = thinned;
  const failed: (Span & { forced: boolean })[] = [];
  const skips: Span[] = [];
  const spanOf = (run: number, a: Point, b: Point): Span => {
    const s0 = projectArc(thinned[run]!, cums[run]!, a);
    const s1 = projectArc(thinned[run]!, cums[run]!, b);
    return { run, s0: Math.min(s0, s1), s1: Math.max(s0, s1) };
  };
  const order = [main, ...pen.passes.map((_, i) => i).filter((i) => i !== main)];
  for (const p of order) {
    const pass = pen.passes[p]!;
    const passSeed = subSeed(seed, 7919 * (p + 1));
    const rnd = prng(passSeed);
    const perRun = thinned.map((run) => handStrokes(run, pen, rnd));
    if (!perRun.some((r) => r.length)) continue;
    const width = passWidth(pass, seriesWidth);
    // The ends' own stream: the cutting above is unchanged by them.
    const endRnd = prng(subSeed(passSeed, 31337));
    const skipRnd = prng(subSeed(passSeed, 4241));
    const isMain = p === main;
    const bodies: Point[][] = [];
    const pinned: boolean[] = [];
    const dim: Point[][] = [];
    const tails: string[][] = Array.from({ length: steps }, () => []);
    let strokeCount = 0;
    perRun.forEach((rawStrokes, r) => {
      const run = thinned[r]!;
      const cum = cums[r]!;
      const total = cum[cum.length - 1] ?? 0;
      const geo = rawStrokes.map((st) => [...st]);
      const kinds = geo.map(() => ({
        start: endKind(endRnd, ends, isMain, "start"),
        end: endKind(endRnd, ends, isMain, "end"),
      }));
      // Fade lengths, drawn up front so the main pass can close its joins before it draws.
      const lens = geo.map((st) => polyLength(st));
      const fadeOut = geo.map((_, k) =>
        kinds[k]!.end === "fade" && lens[k]! > 4 ? Math.min(between(endRnd, ends.fadeLengthPx), lens[k]! * 0.35) : 0
      );
      const fadeIn = geo.map((_, k) =>
        kinds[k]!.start === "fade" && lens[k]! > 4 ? Math.min(between(endRnd, ends.fadeLengthPx), lens[k]! * 0.35) : 0
      );
      if (isMain) {
        // An interior fade never opens a gap in the main pass: one fade per join at most, and the
        // neighbouring stroke's full ink is carried over the faded part, leaving at most a 0,5–2 px
        // lighter spot where only the fade (and the other passes) carry the line.
        for (let k = 0; k + 1 < geo.length; k++) {
          if (fadeOut[k]! > 0 && fadeIn[k + 1]! > 0) {
            fadeIn[k + 1] = 0;
            kinds[k + 1]!.start = null;
          }
          if (fadeOut[k]! > 0) {
            const st = geo[k]!;
            const tailStart = splitAtLength(st, polyLength(st) - fadeOut[k]!)[1][0]!;
            const target = Math.max(0, projectArc(run, cum, tailStart) + between(endRnd, [0.5, 2]));
            const a = projectArc(run, cum, geo[k + 1]![0]!);
            if (a > target) geo[k + 1] = [...sliceArc(run, target, a), ...geo[k + 1]!.slice(1)];
          } else if (fadeIn[k + 1]! > 0) {
            const st = geo[k + 1]!;
            const headEnd = splitAtLength(st, fadeIn[k + 1]!)[0].at(-1)!;
            const target = Math.min(total, projectArc(run, cum, headEnd) - between(endRnd, [0.5, 2]));
            const e = projectArc(run, cum, geo[k]!.at(-1)!);
            if (e < target) {
              // Carry on from the last point ON the line, not from the overshoot's projection: an
              // overshoot runs straight past a corner, so its projection lands beyond the data
              // point and the extension would cut the corner as a chord, leaving the line bare.
              const kept = geo[k]!.slice(0, -1);
              const from = projectArc(run, cum, kept.at(-1) ?? geo[k]![0]!);
              geo[k] = [...kept, ...sliceArc(run, from, target).slice(1)];
            }
          }
        }
      }
      geo.forEach((st, k) => {
        strokeCount++;
        const first = k === 0;
        const last = k === geo.length - 1;
        const startKind = kinds[k]!.start;
        const finishKind = kinds[k]!.end;
        let body = st;
        if (fadeOut[k]! > 0) {
          const [bd, tail] = splitAtLength(body, polyLength(body) - fadeOut[k]!);
          body = bd;
          taperPieces(tail, steps, endRnd).forEach((d, i) => tails[i]!.push(d));
          if (isMain && !last) failed.push({ ...spanOf(r, tail[0]!, tail[tail.length - 1]!), forced: false });
        }
        if (fadeIn[k]! > 0) {
          const [head, bd] = splitAtLength(body, fadeIn[k]!);
          body = bd;
          taperPieces([...head].reverse(), steps, endRnd).forEach((d, i) => tails[i]!.push(d));
          if (isMain && !first) failed.push({ ...spanOf(r, head[0]!, head[head.length - 1]!), forced: false });
        }
        const dotRadius = () => Math.max(0.9, between(endRnd, ends.dotRadius) * width);
        if (startKind === "dot") dots.push(inkDot(st[0]!, dotRadius(), endRnd));
        if (finishKind === "dot") dots.push(inkDot(st[st.length - 1]!, dotRadius(), endRnd));
        // The main pass keeps its vertices: an unpinned stroke end wanders up to roughness ×
        // maxOffset along the line, which opened gaps at joins the 1–4 px overlap could not close.
        const pin = isMain || startKind != null || finishKind != null;
        const bodyLen = polyLength(body);
        if (isMain) {
          // A dry skip: a piece in the middle of the main pass that took no ink — always repaired.
          const skipLen = between(skipRnd, spec.skipLengthPx);
          if (skipRnd() < spec.skipChance && bodyLen > skipLen + 16) {
            const c = between(skipRnd, [skipLen / 2 + 8, bodyLen - skipLen / 2 - 8]);
            const [pre, rest] = splitAtLength(body, c - skipLen / 2);
            const [gap, post] = splitAtLength(rest, skipLen);
            const sp = spanOf(r, gap[0]!, gap[gap.length - 1]!);
            failed.push({ ...sp, forced: true });
            skips.push(sp);
            bodies.push(pre, post);
            pinned.push(true, true);
            return;
          }
        } else if (skips.length && body.length >= 2) {
          // Over the main pass's dry skip, this pass is thinned too.
          const a0 = projectArc(run, cum, body[0]!);
          const sp = skips.find((x) => x.run === r && x.s1 > a0 && x.s0 < a0 + bodyLen);
          if (sp) {
            const o0 = Math.max(0, sp.s0 - a0);
            const o1 = Math.min(bodyLen, sp.s1 - a0);
            if (o1 - o0 > 1) {
              const [pre, rest] = splitAtLength(body, o0);
              const [mid, post] = splitAtLength(rest, o1 - o0);
              if (polyLength(pre) > 0.5) {
                bodies.push(pre);
                pinned.push(true);
              }
              dim.push(mid);
              if (polyLength(post) > 0.5) {
                bodies.push(post);
                pinned.push(true);
              }
              return;
            }
          }
        }
        bodies.push(body);
        pinned.push(pin);
      });
    });
    if (collect && isMain) {
      collect.fullInk = bodies.map((b) => [...b]);
      collect.width = width;
    }
    const d = drawStrokes(bodies, passOptions(pen, width), passSeed, pinned);
    const tailPaths: TailPath[] = tails.flatMap((ds, k) => {
      if (!ds.length) return [];
      const f = fadeStepFactors(k, steps);
      return [{ d: ds.join(" "), opacity: f.opacity, width: f.width }];
    });
    const dimD = dim.length
      ? drawStrokes(dim, passOptions(pen, width), subSeed(passSeed, 555), dim.map(() => true))
      : undefined;
    if (d) results[p] = { d, pass, width, strokes: strokeCount, tails: tailPaths, ...(dimD ? { dim: dimD } : null) };
  }
  // Going back over the failed spans: one scribble each, all in the main pass's `repairs`.
  let repaired = 0;
  const mainPath = results[main];
  if (mainPath && failed.length) {
    const repRnd = prng(subSeed(seed, 9001));
    const scribbles: string[] = [];
    failed.forEach((sp, i) => {
      // A dry skip is always gone over; a faded join only by chance (it is never empty: see above).
      if (repRnd() >= spec.repairChance && !sp.forced) return;
      const run = thinned[sp.run]!;
      const piece = sliceArc(run, sp.s0 - between(repRnd, [2, 4]), sp.s1 + between(repRnd, [2, 4]));
      if (piece.length < 2 || polyLength(piece) < 2) return;
      const polys: Point[][] = [];
      let end: Point;
      if (dashed) {
        // A dashed line is gone over the way it was drawn: forward, in its own rhythm.
        for (let k = 0; k < 2; k++) {
          const off = (k === 0 ? -1 : 1) * between(repRnd, spec.repairOffsetPx) * 0.7;
          polys.push(offsetPolyline(piece, off));
        }
        end = piece[piece.length - 1]!;
      } else {
        const r = repairScribble(piece, spec, repRnd);
        polys.push(r.poly);
        end = r.end;
      }
      polys.forEach((poly, k) => {
        collect?.repairs.push(poly);
        const drawable = generator.linearPath(poly, {
          roughness: 0.8,
          bowing: 0.5,
          maxRandomnessOffset: 0.6,
          disableMultiStroke: true,
          preserveVertices: true,
          strokeWidth: mainPath.width,
          seed: subSeed(seed, 9001 + i * 7 + k),
        });
        for (const info of generator.toPaths(drawable)) if (info.d) scribbles.push(info.d);
      });
      if (repRnd() < 0.3) dots.push(inkDot(end, Math.max(0.9, between(repRnd, ends.dotRadius) * mainPath.width), repRnd));
      repaired++;
    });
    if (scribbles.length) mainPath.repairs = scribbles.join(" ");
  }
  const mainPass = pen.passes[main];
  return {
    passes: results.filter((x): x is PassPath => x != null),
    dots: dots.join(" "),
    dotOpacity: Math.min(1, (mainPass?.opacity ?? 1) * 1.2),
    failed: failed.length,
    repaired,
    main: mainPath ?? null,
  };
}

/** What the sketch carries over from the series element, besides the geometry. */
type CarriedProps = {
  className?: string;
  style?: CSSProperties;
  strokeOpacity?: number | string;
  strokeDasharray?: number | string;
  strokeLinecap?: "butt" | "round" | "square" | "inherit";
  strokeLinejoin?: "miter" | "round" | "bevel" | "inherit";
  opacity?: number | string;
  clipPath?: string;
};

/**
 * A hand-drawn version of a dash pattern: the base pattern repeated into 24 entries, each dash
 * and gap jittered by up to ±25% (seeded per series), so no two dashes or gaps come out
 * exactly the same and the repeat is too long to notice. Null for no dash.
 */
function handDash(dash: number | string | undefined, seed: number): string | undefined {
  if (dash == null) return undefined;
  const base = String(dash)
    .split(/[\s,]+/)
    .map(Number)
    .filter((n) => Number.isFinite(n) && n > 0);
  if (!base.length) return undefined;
  const even = base.length % 2 === 0 ? base : [...base, ...base];
  const rnd = prng(subSeed(seed, 4242));
  const out: string[] = [];
  for (let i = 0; i < 24; i++) {
    const v = even[i % even.length]! * (1 + (rnd() - 0.5) * 0.5);
    out.push(Math.max(0.5, v).toFixed(2));
  }
  return out.join(" ");
}

function carried(p: CarriedProps): CarriedProps {
  return {
    className: p.className,
    style: p.style,
    strokeOpacity: p.strokeOpacity,
    strokeDasharray: p.strokeDasharray,
    strokeLinecap: p.strokeLinecap ?? "round",
    strokeLinejoin: p.strokeLinejoin ?? "round",
    opacity: p.opacity,
    clipPath: p.clipPath,
  };
}

function strokeWidthNumber(w: number | string | undefined, fallback: number): number {
  const n = typeof w === "string" ? parseFloat(w) : w;
  return typeof n === "number" && Number.isFinite(n) ? n : fallback;
}

function numberOr(v: number | string | undefined, fallback: number): number {
  const n = typeof v === "string" ? parseFloat(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : fallback;
}

/** The series group's style: the pen's blend mode and grain filter on top of the element's own. */
function groupStyle(pen: RoughPen, grainFilterId: string | undefined, own: CSSProperties | undefined): CSSProperties | undefined {
  const style: CSSProperties = { ...own };
  if (pen.blend) style.mixBlendMode = pen.blend;
  const filters: string[] = [];
  if (pen.grain === "filter" && grainFilterId) filters.push(`url(#${grainFilterId})`);
  if (pen.soft) filters.push(`blur(${pen.soft}px)`);
  if (filters.length) style.filter = filters.join(" ");
  return Object.keys(style).length ? style : undefined;
}

/** The pass paths of a stroke in `stroke`, each with the pen's dash (unless the series has its own). */
function renderPasses(
  paths: readonly PassPath[],
  stroke: string | undefined,
  pen: RoughPen,
  c: CarriedProps,
  keyPrefix: string
) {
  const own = numberOr(c.strokeOpacity, 1);
  return paths.flatMap((p, i) => [
    <path
      key={`${keyPrefix}${i}`}
      d={p.d}
      fill="none"
      stroke={stroke}
      strokeWidth={p.width}
      strokeOpacity={p.pass.opacity * own}
      strokeDasharray={c.strokeDasharray ?? p.pass.dash}
      strokeDashoffset={c.strokeDasharray == null ? p.pass.dashOffset : undefined}
      strokeLinecap={pen.linecap}
      strokeLinejoin="round"
      style={p.pass.blur ? { filter: `blur(${p.pass.blur}px)` } : undefined}
    />,
    // This pass over the main pass's dry skips: thinned to 0,3 of its opacity.
    ...(p.dim
      ? [
          <path
            key={`${keyPrefix}${i}dim`}
            d={p.dim}
            fill="none"
            stroke={stroke}
            strokeWidth={p.width}
            strokeOpacity={p.pass.opacity * 0.3 * own}
            strokeDasharray={c.strokeDasharray ?? p.pass.dash}
            strokeLinecap={pen.linecap}
            strokeLinejoin="round"
            style={p.pass.blur ? { filter: `blur(${p.pass.blur}px)` } : undefined}
          />,
        ]
      : []),
    // The main pass's repair scribbles: quick deliberate dashes, a touch heavier than the pass.
    ...(p.repairs
      ? [
          <path
            key={`${keyPrefix}${i}rep`}
            d={p.repairs}
            fill="none"
            stroke={stroke}
            strokeWidth={p.width}
            strokeOpacity={Math.min(1, p.pass.opacity * 1.1) * own}
            strokeDasharray={c.strokeDasharray}
            strokeLinecap="round"
            strokeLinejoin="round"
            style={p.pass.blur ? { filter: `blur(${p.pass.blur}px)` } : undefined}
          />,
        ]
      : []),
    // The faded ends, one element per step: round caps so the taper ends soft.
    ...(p.tails ?? []).map((t, k) => (
      <path
        key={`${keyPrefix}${i}t${k}`}
        d={t.d}
        fill="none"
        stroke={stroke}
        strokeWidth={p.width * t.width}
        strokeOpacity={p.pass.opacity * t.opacity * own}
        strokeDasharray={c.strokeDasharray}
        strokeLinecap="round"
        strokeLinejoin="round"
        style={p.pass.blur ? { filter: `blur(${p.pass.blur}px)` } : undefined}
      />
    )),
  ]);
}

/** A series' ink dots: one filled path at the main pass's opacity (× 1,2). */
function renderDots(sk: SeriesStrokes, color: string | undefined, c: CarriedProps, key: string) {
  if (!sk.dots) return null;
  return <path key={key} d={sk.dots} fill={color} fillOpacity={sk.dotOpacity * numberOr(c.strokeOpacity, 1)} stroke="none" />;
}

// ---------------------------------------------------------------------------------------------
// Line

type RoughLineProps = LineDrawShapeProps & { seed: number; pen: RoughPen; grainFilterId?: string };

/**
 * A dashed line cut into its dashes by arc length, each dash its own run: the line's pattern
 * jittered by hand ({@link handDash}), the gaps truly empty. Drawing the dashes as geometry
 * (instead of an SVG dasharray over the hand strokes) keeps every pen pass's gaps in the same
 * place — the dasharray restarts at each hand stroke, and the passes cut their strokes at
 * different places, so one pass's dashes filled another's gaps.
 */
function dashRuns(runs: Point[][], pattern: readonly number[]): Point[][] {
  const out: Point[][] = [];
  if (!pattern.length) return runs;
  let k = 0;
  for (const run of runs) {
    const total = polyLength(run);
    let s = 0;
    while (s < total) {
      const d = pattern[k % pattern.length]!;
      const g = pattern[(k + 1) % pattern.length]!;
      k += 2;
      const piece = sliceArc(run, s, Math.min(total, s + d));
      if (piece.length >= 2 && polyLength(piece) >= 0.8) out.push(piece);
      s += d + g;
    }
  }
  return out;
}

/** The pen for a dash: fewer ink dots and fades, since a dash is a single short flick. */
const DASH_PEN_CACHE = new WeakMap<RoughPen, RoughPen>();
function dashPenFor(pen: RoughPen): RoughPen {
  const cached = DASH_PEN_CACHE.get(pen);
  if (cached) return cached;
  const derived: RoughPen = {
    ...pen,
    ends: { ...pen.ends, dotChance: pen.ends.dotChance * 0.25, fadeChance: pen.ends.fadeChance * 0.5, fadeInChance: 0 },
  };
  DASH_PEN_CACHE.set(pen, derived);
  return derived;
}

function RoughLineShapeImpl(props: RoughLineProps) {
  const { points, connectNulls, stroke, strokeWidth, seed, pen, grainFilterId } = props;
  const width = strokeWidthNumber(strokeWidth, REFERENCE_SERIES_WIDTH);
  const dash = handDash(props.strokeDasharray, seed);
  const sketch = useMemo(() => {
    const runs = pointRuns((points ?? []) as readonly Pt[], connectNulls);
    if (!dash) return strokePasses(runs, pen, seed, width);
    return strokePasses(dashRuns(runs, dash.split(" ").map(Number)), dashPenFor(pen), seed, width);
  }, [points, connectNulls, seed, pen, width, dash]);
  if (!sketch.passes.length) return null;
  const c = carried(props as CarriedProps);
  // A dashed line's dashes are geometry already: no SVG dasharray on top of them.
  if (dash) c.strokeDasharray = undefined;
  return (
    <g
      className={`nw-rough nw-rough--line ${c.className ?? ""}`.trim()}
      style={groupStyle(pen, grainFilterId, c.style)}
      clipPath={c.clipPath}
      opacity={c.opacity}
    >
      {renderPasses(sketch.passes, stroke, pen, c, "l")}
      {renderDots(sketch, stroke, c, "ld")}
    </g>
  );
}

/** A `shape` for `<Line>`: Recharts calls it as a function, so it returns the memoizing component. */
export function roughLineShape(seed: number, pen: RoughPen, grainFilterId?: string) {
  return (props: LineDrawShapeProps) => (
    <RoughLineShapeImpl {...props} seed={seed} pen={pen} grainFilterId={grainFilterId} />
  );
}

/**
 * Any set of polylines drawn with a pen exactly as a series line is (passes, soft edges, ends,
 * dots, repairs), in `color`. The ATH marker draws its zigzag through this, so it is the same
 * pen as the line it marks.
 */
export function RoughPolylines({
  runs,
  color,
  pen,
  seed,
  width,
  opacity = 1,
}: {
  runs: Point[][];
  color: string;
  pen: RoughPen;
  seed: number;
  width: number;
  opacity?: number;
}) {
  const sketch = useMemo(() => strokePasses(runs, pen, seed, width), [runs, pen, seed, width]);
  // Outside a chart there is no chart-level grain filter: a grainy pen (crayon, marker) defines
  // its own, so pills, legend lines and the ATH mark carry the same texture as the lines.
  const grainId = roughGrainFilterId(useId());
  if (!sketch.passes.length) return null;
  const c: CarriedProps = {};
  const grain = pen.grain === "filter" ? grainId : undefined;
  return (
    <g className="nw-rough nw-rough--polylines" style={{ ...groupStyle(pen, grain, undefined), pointerEvents: "none" }} opacity={opacity}>
      {grain ? <RoughChartDefs mode={pen as RoughMode} grainFilterId={grain} /> : null}
      {renderPasses(sketch.passes, color, pen, c, "p")}
      {renderDots(sketch, color, c, "pd")}
    </g>
  );
}

/** The pen for a legend squiggle: every point kept (it is tiny), no dry skips, few dots. */
const SQUIGGLE_PEN_CACHE = new WeakMap<RoughPen, RoughPen>();
export function squigglePenFor(pen: RoughPen): RoughPen {
  const cached = SQUIGGLE_PEN_CACHE.get(pen);
  if (cached) return cached;
  const derived: RoughPen = {
    ...pen,
    minPointGapPx: 0.5,
    repair: { ...pen.repair, skipChance: 0 },
    ends: { ...pen.ends, dotChance: pen.ends.dotChance * 0.5, fadeInChance: 0 },
  };
  SQUIGGLE_PEN_CACHE.set(pen, derived);
  return derived;
}

/** FNV-1a of a colour, so each legend entry keeps its squiggle across renders. */
function colorSeed(color: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < color.length; i++) {
    h ^= color.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) % 2147483647 || 1;
}

/**
 * A legend swatch in the hand-drawn styles: a short hand-drawn straight line across a w×h box, drawn with the
 * chart's pen in the series colour (SVG content; the caller supplies the `<svg>`). Null in the
 * plain style, where the caller keeps its own swatch.
 */
export function LegendSquiggle({
  color,
  w,
  h,
  width = 1.6,
  opacity = 1,
}: {
  color: string;
  w: number;
  h: number;
  width?: number;
  opacity?: number;
}) {
  const pen = roughPenFor(useChartStyle());
  // A different squiggle for every instance, drawn once per mount (hover re-renders keep it).
  const [mountSalt] = useState(() => Math.floor(Math.random() * 2147483646) + 1);
  const seed = ((colorSeed(color) ^ mountSalt) >>> 0) % 2147483647 || 1;
  const runs = useMemo(() => {
    // A short straight stroke drawn by hand: two points (its own start and end, so lengths
    // differ, with a slight tilt). The pen adds the rest: its bow and noise along the stroke, and
    // the ends — an ink dot, a fade as it lifts, or a sudden stop.
    const rnd = prng(seed);
    const x0 = 0.5 + rnd() * 1.8;
    const x1 = w - 0.5 - rnd() * 1.8;
    const tilt = (rnd() - 0.5) * Math.min(h * 0.22, 1.8);
    const pts: Point[] = [
      [x0, h / 2 - tilt / 2],
      [x1, h / 2 + tilt / 2],
    ];
    return [pts];
  }, [seed, w, h]);
  if (!pen) return null;
  return <RoughPolylines runs={runs} color={color} pen={squigglePenFor(pen)} seed={seed} width={width} opacity={opacity} />;
}

/**
 * The squiggle as a Recharts default-legend icon: the legend clones it with the entry's props
 * inside a 32-unit box drawn at the legend's icon size, so the squiggle sits in a nested
 * 14-unit `<svg>` that comes out at about 1:1 on screen.
 */
function LegendSquiggleIcon(props: { color?: string }) {
  const color = typeof props.color === "string" ? props.color : "#94a3b8";
  return (
    <svg x={0} y={0} width={32} height={32} viewBox="0 0 18 14" preserveAspectRatio="none" overflow="visible">
      <LegendSquiggle color={color} w={18} h={14} />
    </svg>
  );
}

/**
 * A box legend icon (a bar series: the plain legend draws a filled square) in the hand-drawn
 * styles: a small hand-drawn box, the bar's hatched fill and careful outline, in the series
 * colour. Same nested 14-unit box as {@link LegendSquiggleIcon}.
 */
function LegendBoxIcon(props: { color?: string }) {
  const color = typeof props.color === "string" ? props.color : "#94a3b8";
  const pen = roughPenFor(useChartStyle());
  const grainId = roughGrainFilterId(useId());
  // A different box for every instance, drawn once per mount.
  const [seed] = useState(() => Math.floor(Math.random() * 2147483646) + 1);
  if (!pen) return null;
  const grain = pen.grain === "filter" ? grainId : undefined;
  return (
    <svg x={0} y={0} width={32} height={32} viewBox="0 0 14 14" overflow="visible">
      {grain ? <RoughChartDefs mode={pen as RoughMode} grainFilterId={grain} /> : null}
      <g style={grain ? { filter: `url(#${grain})` } : undefined}>
        <RoughBarShapeImpl
          {...({} as BarShapeProps)}
          x={2}
          y={2}
          width={10}
          height={10}
          fill={color}
          stroke={color}
          strokeWidth={1.2}
          index={0}
          seed={seed}
          pen={pen}
        />
      </g>
    </svg>
  );
}

type LegendContentProps = { payload?: readonly { color?: string; type?: string }[] } & Record<string, unknown>;

/** A `<Legend>`'s `content` that hands every entry the squiggle icon, keeping the chart's own content. */
function roughLegendContent(original: unknown) {
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
              e.type === "rect" || e.type === "square" ? <LegendBoxIcon color={e.color} /> : <LegendSquiggleIcon color={e.color} />,
          }
    );
    const next = { ...lp, payload, iconType: undefined };
    if (typeof original === "function") return (original as (p: LegendContentProps) => ReactNode)(next);
    if (isValidElement(original)) return cloneElement(original, next as Record<string, unknown>);
    return <DefaultLegendContent {...(next as object)} />;
  };
}

// ---------------------------------------------------------------------------------------------
// Area

type RoughAreaProps = AreaRevealShapeProps & { seed: number; pen: RoughPen; grainFilterId?: string };

type AreaSketch = { fills: { d: string; strokeWidth: number }[]; edges: SeriesStrokes | null };

function areaSketch(
  points: readonly Pt[],
  baseLine: number | readonly Pt[] | undefined,
  layout: string | undefined,
  connectNulls: boolean | undefined,
  fill: string,
  stroke: string | undefined,
  width: number,
  seed: number,
  pen: RoughPen
): AreaSketch {
  const vertical = layout === "vertical";
  // Pair each point with its baseline coordinate, then split into runs where either is missing.
  const paired: Pt[] = points.map((p, i) => {
    const base = Array.isArray(baseLine) ? (baseLine[i] as Pt | undefined) : undefined;
    const baseOk =
      typeof baseLine === "number" ? Number.isFinite(baseLine) : base != null && isDefined(base);
    return isDefined(p) && baseOk ? p : { x: null, y: null };
  });
  const topRuns = pointRuns(paired, connectNulls);
  const fills: AreaSketch["fills"] = [];
  const fillOpts: Options = {
    roughness: Math.min(pen.roughness, 1.4),
    bowing: Math.min(pen.bowing, 1),
    seed,
    stroke: "none",
    fill,
    fillStyle: "hachure",
    hachureGap: pen.fillGap,
    hachureAngle: -41,
    fillWeight: pen.fillWeight,
    disableMultiStroke: true,
    disableMultiStrokeFill: true,
  };
  // The base run matches the top run point by point; rebuild it from the top run's x (or y).
  let cursor = 0;
  const definedIdx = paired.map((p, i) => (isDefined(p) ? i : -1)).filter((i) => i >= 0);
  for (const run of topRuns) {
    const idxs = definedIdx.slice(cursor, cursor + run.length);
    cursor += run.length;
    const base: Point[] = idxs.map((i) => {
      const p = points[i]!;
      if (typeof baseLine === "number") return vertical ? [baseLine, p.y as number] : [p.x as number, baseLine];
      const b = (baseLine as readonly Pt[])[i]!;
      return [b.x as number, b.y as number];
    });
    if (run.length >= 2) {
      // Straight segments to the baseline, thinned like the edge so the two agree.
      const keep = new Set(thinByGap(run, pen.minPointGapPx));
      const top = run.filter((p) => keep.has(p));
      const bottom = base.filter((_, i) => keep.has(run[i]!));
      const polygon = [...top, ...bottom.reverse()];
      const drawable = generator.polygon(polygon, fillOpts);
      for (const p of generator.toPaths(drawable)) {
        if (p.d) fills.push({ d: p.d, strokeWidth: p.strokeWidth });
      }
    }
  }
  // The same pen the lines use, so an area's edge matches a line beside it.
  const edges = stroke && stroke !== "none" ? strokePasses(topRuns, pen, seed + 1, width) : null;
  return { fills, edges };
}

function RoughAreaShapeImpl(props: RoughAreaProps) {
  const { points, baseLine, layout, connectNulls, fill, stroke, strokeWidth, fillOpacity, seed, pen, grainFilterId } =
    props;
  const width = strokeWidthNumber(strokeWidth, 1);
  const fillColor = typeof fill === "string" && fill !== "none" ? fill : (stroke ?? "#888");
  const sketch = useMemo(
    () =>
      areaSketch(
        (points ?? []) as readonly Pt[],
        baseLine as number | readonly Pt[] | undefined,
        layout,
        connectNulls,
        fillColor,
        stroke,
        width,
        seed,
        pen
      ),
    [points, baseLine, layout, connectNulls, fillColor, stroke, width, seed, pen]
  );
  if (!sketch.fills.length && !sketch.edges?.passes.length) return null;
  const c = carried(props as CarriedProps);
  return (
    <g
      className={`nw-rough nw-rough--area ${c.className ?? ""}`.trim()}
      style={groupStyle(pen, grainFilterId, c.style)}
      clipPath={c.clipPath}
      opacity={c.opacity}
    >
      <g opacity={numberOr(fillOpacity, 1) * pen.fillOpacity}>
        {sketch.fills.map((p, i) => (
          <path key={`f${i}`} d={p.d} fill="none" stroke={fillColor} strokeWidth={p.strokeWidth} strokeLinecap="round" />
        ))}
      </g>
      {sketch.edges ? renderPasses(sketch.edges.passes, stroke, pen, c, "e") : null}
      {sketch.edges ? renderDots(sketch.edges, stroke, c, "ed") : null}
    </g>
  );
}

/** A `shape` for `<Area>`. */
export function roughAreaShape(seed: number, pen: RoughPen, grainFilterId?: string) {
  return (props: AreaRevealShapeProps) => (
    <RoughAreaShapeImpl {...props} seed={seed} pen={pen} grainFilterId={grainFilterId} />
  );
}

// ---------------------------------------------------------------------------------------------
// Bar

type RoughBarProps = BarShapeProps & {
  seed: number;
  pen: RoughPen;
  grainFilterId?: string;
  /** The outline with the pen as it is, not used with care (still in 1–3 strokes): a looser shape. */
  loose?: boolean;
  /**
   * How strongly the hatch colours the shape in (1 = the pen's own): above 1 the lines sit closer
   * together, a little heavier and more opaque (capped at fully opaque).
   */
  fillStrength?: number;
};

function RoughBarShapeImpl(props: RoughBarProps) {
  const { x, y, width, height, fill, stroke, strokeWidth, fillOpacity, index, seed, pen, grainFilterId, loose } = props;
  const strength = Math.max(1, props.fillStrength ?? 1);
  // A negative height or width is a bar drawn the other way (stackOffset="sign").
  const rx = width < 0 ? x + width : x;
  const ry = height < 0 ? y + height : y;
  const rw = Math.abs(width);
  const rh = Math.abs(height);
  const fillColor = typeof fill === "string" && fill !== "none" ? fill : "#888";
  const strokeColor = typeof stroke === "string" && stroke !== "none" ? stroke : fillColor;
  const sw = strokeWidthNumber(strokeWidth, REFERENCE_SERIES_WIDTH);
  const barSeed = seed + (typeof index === "number" ? index * 7919 : 0);
  const fillClipId = `nw-barclip-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const sketch = useMemo(() => {
    if (!(rw > 0.5 && rh > 0.5) || !Number.isFinite(rx) || !Number.isFinite(ry)) return null;
    const fillDrawable = generator.rectangle(rx, ry, rw, rh, {
      roughness: Math.min(pen.roughness, 1.4),
      bowing: Math.min(pen.bowing, 1),
      // Hatch ends wander less (fewer overshoots); the clip below caps the rest at ~1 px.
      maxRandomnessOffset: Math.min(pen.maxOffset, 1),
      seed: barSeed,
      stroke: "none",
      fill: fillColor,
      fillStyle: "hachure",
      hachureGap: Math.max(2, Math.min(pen.fillGap, rw / 3) / strength),
      hachureAngle: -41,
      fillWeight: pen.fillWeight * Math.sqrt(strength),
      disableMultiStrokeFill: true,
    });
    const fills = generator.toPaths(fillDrawable).filter((p) => p.d);
    // The outline, drawn the way a hand boxes a shape: 1, 2 or 3 strokes going round from a
    // random corner, each able to turn corners, breaking mostly at corners, every stroke running
    // 1,5–3 px past where the next one starts (and the last past where the first began, closing
    // the box). Small bars mostly take 1–2 strokes, big ones 2–3. Drawn with a careful pen
    // ({@link carefulPenOptions}); the fill keeps the pen as is.
    const crnd = prng(subSeed(barSeed, 31));
    const corners: Point[] = [
      [rx, ry],
      [rx + rw, ry],
      [rx + rw, ry + rh],
      [rx, ry + rh],
    ];
    const s0 = Math.floor(crnd() * 4);
    // Twice round from the start corner, so a stroke can run past the closing corner.
    const loop: Point[] = Array.from({ length: 9 }, (_, i) => corners[(s0 + i) % 4]!);
    const perim = 2 * (rw + rh);
    const size = rw + rh;
    const u = crnd();
    const k =
      size < 40 ? (u < 0.55 ? 1 : 2) : size < 150 ? (u < 0.2 ? 1 : u < 0.7 ? 2 : 3) : u < 0.4 ? 2 : 3;
    // Where strokes break: at the corners after the start one (arc position = the sides walked
    // so far), sometimes part-way along a side.
    const lens = [rw, rh, rw, rh].map((_, i) => [rw, rh, rw, rh][(s0 + i) % 4]!);
    const cum = [0, lens[0]!, lens[0]! + lens[1]!, lens[0]! + lens[1]! + lens[2]!];
    const cuts: number[] = [];
    const pool = [1, 2, 3];
    while (cuts.length < k - 1 && pool.length) {
      const j = pool.splice(Math.floor(crnd() * pool.length), 1)[0]!;
      const atCorner = crnd() < 0.7;
      const base = cum[j]!;
      const along = atCorner ? 0 : (crnd() - 0.5) * 0.5 * lens[j]!;
      cuts.push(Math.max(2, Math.min(perim - 2, base + along)));
    }
    cuts.sort((a, b) => a - b);
    const ov = () => 1.5 + crnd() * 1.5;
    const bounds = [0, ...cuts, perim];
    const sides: Point[][] = [];
    for (let i = 0; i < bounds.length - 1; i++) {
      const from = i === 0 ? 0 : bounds[i]! - ov() / 2;
      const to = bounds[i + 1]! + ov();
      const piece = sliceArc(loop, Math.max(0, from), to);
      if (piece.length >= 2) sides.push(piece);
    }
    const pinned = sides.map(() => true);
    // Loose: the way each side bows is decided once and every pass follows it on a line of its
    // own ({@link handPath}), so a later pass heads where the first one went instead of bowing
    // its own way, without retracing it.
    const bowRnd = prng(subSeed(barSeed, 53));
    const bows = loose ? sides.map((st) => sideBows(st, pen, bowRnd)) : [];
    const outline: PassPath[] = pen.passes.map((pass, p) => {
      const width = passWidth(pass, sw);
      const outlinePen = loose ? tracingPenOptions(pen, width) : carefulPenOptions(pen, width);
      const passRnd = prng(subSeed(barSeed, 59 + p));
      const traced = loose ? sides.map((st, i) => handPath(st, pen, bows[i]!, passRnd)) : sides;
      // A tracing pass's points may wander (up to 0,9 px), so it lies near the path, not on it.
      return { d: drawStrokes(traced, outlinePen, subSeed(barSeed + 1, p), loose ? undefined : pinned), pass, width, strokes: sides.length };
    });
    return { fills, outline };
  }, [rx, ry, rw, rh, barSeed, fillColor, sw, pen, loose, strength]);
  if (!sketch) return null;
  const c = carried(props as CarriedProps);
  return (
    <g
      className={`nw-rough nw-rough--bar ${c.className ?? ""}`.trim()}
      style={groupStyle(pen, grainFilterId, c.style)}
      opacity={c.opacity}
    >
      {/* The hatch may leave the bar only barely: clipped to the bar plus 1,2 px. */}
      <clipPath id={fillClipId}>
        <rect x={rx - 1.2} y={ry - 1.2} width={rw + 2.4} height={rh + 2.4} />
      </clipPath>
      <g opacity={numberOr(fillOpacity, 1) * Math.min(1, pen.fillOpacity * strength)} clipPath={`url(#${fillClipId})`}>
        {sketch.fills.map((p, i) => (
          <path key={`f${i}`} d={p.d} fill="none" stroke={fillColor} strokeWidth={p.strokeWidth} strokeLinecap="round" />
        ))}
      </g>
      {renderPasses(sketch.outline, strokeColor, pen, c, "o")}
    </g>
  );
}

/**
 * A rectangle drawn with a pen outside any chart (the value map's tiles): the bar's hatched
 * fill and per-side outline. `fill` null draws the outline alone (a frame).
 */
export function RoughRect({
  x,
  y,
  width,
  height,
  fill,
  stroke,
  pen,
  seed,
  loose,
  fillStrength,
}: {
  x: number;
  y: number;
  width: number;
  height: number;
  fill: string | null;
  stroke: string;
  pen: RoughPen;
  seed: number;
  loose?: boolean;
  fillStrength?: number;
}) {
  return (
    <RoughBarShapeImpl
      loose={loose}
      fillStrength={fillStrength}
      {...({} as BarShapeProps)}
      x={x}
      y={y}
      width={width}
      height={height}
      fill={fill ?? stroke}
      fillOpacity={fill ? 1 : 0}
      stroke={stroke}
      strokeWidth={1.2}
      index={0}
      seed={seed}
      pen={pen}
    />
  );
}

/** A `shape` for `<Bar>`: the bar's index salts the series seed, so every bar sketches differently. */
export function roughBarShape(seed: number, pen: RoughPen, grainFilterId?: string) {
  return (props: BarShapeProps) => <RoughBarShapeImpl {...props} seed={seed} pen={pen} grainFilterId={grainFilterId} />;
}

// ---------------------------------------------------------------------------------------------
// The crayon's grain: a per-chart filter

/**
 * The `<defs>` a chart needs for its pen: the crayon's grain filter — fractal noise, its
 * luminance mapped to alpha and composited INTO the stroke, so the stroke breaks into gaps where
 * the noise is dark. Rendered as a chart child by the wrappers; `id` comes from the wrapper's
 * `useId`, so several charts on one page do not collide. Nothing for a pen without grain.
 */
export function RoughChartDefs({ mode, grainFilterId }: { mode: RoughMode; grainFilterId: string }) {
  if (mode.grain !== "filter") return null;
  return (
    <defs>
      <filter id={grainFilterId} x="-2%" y="-5%" width="104%" height="110%" colorInterpolationFilters="sRGB">
        <feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="1" seed="7" result="noise" />
        {/* alpha = 3·(r+g+b) − cutoff: crayon's 3.6 opens gaps where the noise is below ≈ 0,4
            per channel; the marker's lower cutoff leaves only the odd speck. */}
        <feColorMatrix
          in="noise"
          type="matrix"
          values={`0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  3 3 3 0 -${mode.grainCutoff ?? 3.6}`}
          result="mask"
        />
        {/* Density relief, add-only: boost = clamp(3·(alpha − denseFrom), 0, 1) from the ink's
            own alpha, added to the mask. Where overlapping strokes make the ink near solid the
            holes close; faint ink (a bar's hatch, a single pass) keeps exactly its grain — never
            less, which a signed term would do, wiping faint fills out. */}
        <feComponentTransfer in="SourceAlpha" result="boost">
          <feFuncA type="linear" slope="3" intercept={String(-3 * (mode.grainDenseFrom ?? 0.8))} />
        </feComponentTransfer>
        <feComposite in="mask" in2="boost" operator="arithmetic" k1="0" k2="1" k3="1" k4="0" result="relieved" />
        <feComposite in="SourceGraphic" in2="relieved" operator="in" result="grained" />
        {mode.grainFloorCutoff != null ? (
          <>
            {/* The floor: a lighter grain from other noise, everywhere, so dense ink keeps some. */}
            <feTurbulence type="fractalNoise" baseFrequency="1.1" numOctaves="1" seed="19" result="noise2" />
            <feColorMatrix
              in="noise2"
              type="matrix"
              values={`0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  3 3 3 0 -${mode.grainFloorCutoff}`}
              result="floor"
            />
            <feComposite in="grained" in2="floor" operator="in" />
          </>
        ) : null}
      </filter>
    </defs>
  );
}

/** A DOM-safe id for the chart's grain filter from React's `useId` (which carries colons / guillemets). */
export function roughGrainFilterId(reactId: string): string {
  return `nw-grain-${reactId.replace(/[^a-zA-Z0-9_-]/g, "")}`;
}

// ---------------------------------------------------------------------------------------------
// Straight lines: reference lines, grid lines, axis lines (rough's doubled stroke allowed)

type StraightLineProps = CarriedProps & {
  x1?: number | string;
  y1?: number | string;
  x2?: number | string;
  y2?: number | string;
  stroke?: string;
  strokeWidth?: number | string;
};

function coord(v: number | string | undefined): number | null {
  const n = typeof v === "string" ? parseFloat(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}

/** A ruled line between the two points, as hand strokes ({@link RULED_STROKES}): one `d`. */
function sketchLine(x1: number, y1: number, x2: number, y2: number, options: Options, seed: number): string {
  const strokes = handStrokes(
    [
      [x1, y1],
      [x2, y2],
    ],
    RULED_STROKES,
    prng(seed)
  );
  return drawStrokes(strokes, { ...options, preserveVertices: false }, seed);
}

function RoughStraightLine({
  props,
  seed,
  roughness,
  multiStroke,
  fallbackStroke,
  extraClass,
}: {
  props: StraightLineProps;
  seed: number;
  roughness: number;
  multiStroke: boolean;
  fallbackStroke: string;
  extraClass: string;
}) {
  const x1 = coord(props.x1);
  const y1 = coord(props.y1);
  const x2 = coord(props.x2);
  const y2 = coord(props.y2);
  const width = strokeWidthNumber(props.strokeWidth, 1);
  const ds = useMemo(
    () =>
      x1 == null || y1 == null || x2 == null || y2 == null
        ? []
        : [
            sketchLine(
              x1,
              y1,
              x2,
              y2,
              { roughness, bowing: 0.6, strokeWidth: width, disableMultiStroke: !multiStroke },
              seed
            ),
          ].filter(Boolean),
    [x1, y1, x2, y2, roughness, multiStroke, seed, width]
  );
  if (!ds.length) return null;
  const c = carried(props);
  const stroke = props.stroke && props.stroke !== "none" ? props.stroke : fallbackStroke;
  return (
    <g className={`nw-rough ${extraClass} ${c.className ?? ""}`.trim()} style={c.style} clipPath={c.clipPath}>
      {ds.map((d, i) => (
        <path
          key={i}
          d={d}
          fill="none"
          stroke={stroke}
          strokeWidth={width}
          strokeOpacity={c.strokeOpacity}
          strokeDasharray={c.strokeDasharray}
          strokeLinecap="round"
          strokeLinejoin="round"
          opacity={c.opacity}
        />
      ))}
    </g>
  );
}

/**
 * A `shape` for `<ReferenceLine>`: Recharts hands it the line's end points with the element's
 * stroke props (the faint USD milestone lines rely on `strokeOpacity` / `opacity`, carried).
 */
export function roughReferenceLineShape(seed: number, multiStroke: boolean) {
  return (props: StraightLineProps) => (
    <RoughStraightLine
      props={props}
      seed={seed}
      roughness={1}
      multiStroke={multiStroke}
      fallbackStroke="#ccc"
      extraClass="nw-rough--ref"
    />
  );
}

/** A `horizontal` / `vertical` render function for `<CartesianGrid>`; seeded per grid line index. */
export function roughGridLine(seed: number, multiStroke: boolean) {
  return (props: StraightLineProps & { index?: number; key?: string | number }) => (
    <RoughStraightLine
      key={props.key}
      props={props}
      seed={seed + (typeof props.index === "number" ? props.index * 7919 : 0)}
      roughness={0.8}
      multiStroke={multiStroke}
      fallbackStroke="#ccc"
      extraClass="nw-rough--grid"
    />
  );
}

export type AxisSide = "top" | "bottom" | "left" | "right";

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

/** Rough `horizontal` / `vertical` render functions for a `<CartesianGrid>`, unless it sets its own. */
export function roughGridProps(existing: { horizontal?: unknown; vertical?: unknown }, mode: RoughMode) {
  const out: { horizontal?: unknown; vertical?: unknown } = {};
  if (typeof existing.horizontal !== "function" && existing.horizontal !== false) {
    out.horizontal = roughGridLine(roughSeed("grid-h", mode.seedSalt), mode.multiStrokeExtras);
  }
  if (typeof existing.vertical !== "function" && existing.vertical !== false) {
    out.vertical = roughGridLine(roughSeed("grid-v", mode.seedSalt), mode.multiStrokeExtras);
  }
  return out;
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
  return Children.map(node, (child) => {
    if (!isValidElement(child)) return child;
    const el = child as SeriesElement;
    const props = el.props;
    if (el.type === Legend) {
      const legendContent = (props as { content?: unknown }).content;
      return cloneElement(el, { content: roughLegendContent(legendContent) } as Partial<typeof props>);
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
      if (props.shape != null) return child;
      if (el.type !== Bar && (props.stroke === "transparent" || props.stroke === "none")) return child;
      const seed = roughSeed(dataKeyString(props.dataKey), mode.seedSalt);
      const grain = mode.grain === "filter" ? grainFilterId : undefined;
      const shape =
        el.type === Line
          ? roughLineShape(seed, mode, grain)
          : el.type === Bar
            ? roughBarShape(seed, mode, grain)
            : roughAreaShape(seed, mode, grain);
      return cloneElement(el, { shape, isAnimationActive: false } as Partial<typeof props>);
    }
    const ch = props?.children;
    if (ch != null) {
      const mapped = injectRoughShapes(ch, mode, grainFilterId);
      if (mapped !== ch) return cloneElement(el, { children: mapped } as { children: ReactNode });
    }
    return child;
  });
}
