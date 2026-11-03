import { useMemo, useState, type ReactElement } from "react";
import { DefaultZIndexes, ReferenceDot } from "recharts";
import type { ChartStyle } from "../../chartStylePreference";
import { useChartStyle } from "./chartStyle";
import { RoughPolylines, roughPenFor, type RoughPen } from "./roughShapes";

/** The marker's tint: a deep gold, clearly apart from the white net-worth line it marks. */
export const ATH_MARKER_STROKE = "#c9971c";
/** Base opacity of the marker; the line's legend-focus dimming multiplies it. */
const ATH_MARKER_OPACITY = 0.85;
const ATH_MARKER_WIDTH = 2;
/** Height of the tick, centered on the peak point (px). */
const ATH_MARKER_HEIGHT = 12;

/**
 * The hand-drawn styles (rehearsal, 2026-11-03) mark the peak with a dry-brush scribble ON the
 * point: a few thick tapered strokes going back and forth on a slant, each with ragged edges,
 * plus thin dry streaks trailing off the ends — like a quick swipe of a loaded brush. Size of
 * the patch in px (the stroke run's length and the zigzag's height).
 */
const ATH_SCRIBBLE_LENGTH = 6;
const ATH_SCRIBBLE_HEIGHT = 12;
/** The series width the pen is drawn at for the marker (pass widths scale with it). */
const ATH_PEN_WIDTH = 1.8;

/** Per pen type: the brush's widest stroke (px), the base stroke count, and the patch's opacity. */
type ScribblePen = { width: number; strokes: number; opacity: number };
const ATH_SCRIBBLE_PEN: Record<Exclude<ChartStyle, "plain">, ScribblePen> = {
  pen: { width: 3, strokes: 7, opacity: 0.95 },
  pencil: { width: 2.3, strokes: 8, opacity: 0.75 },
  marker: { width: 3.6, strokes: 6, opacity: 0.9 },
  watercolor: { width: 3.8, strokes: 6, opacity: 0.6 },
  crayon: { width: 3.3, strokes: 7, opacity: 0.7 },
};

/**
 * The zigzag's shape, picked per peak from its seed (the lab page shows them all):
 * - `tight`  — even steps, every stroke the full width: a dense solid swipe.
 * - `loose`  — uneven steps, some strokes stopping short of the far side.
 * - `flick`  — a zigzag that ends in one long thin flick out past the patch.
 * - `hatch`  — separate parallel swipes, each starting on the same side (the pen lifted between).
 * - `scrawl` — the slant drifts stroke to stroke, the turns jittered: a hurried scrawl.
 */
export const ATH_SCRIBBLE_VARIANTS = ["tight", "loose", "flick", "hatch", "scrawl"] as const;
export type AthScribbleVariant = (typeof ATH_SCRIBBLE_VARIANTS)[number];

/** FNV-1a: the scribble's seed from the peak's x, so it keeps its shape across hover re-renders. */
function seedFor(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) % 2147483647 || 1;
}

type Pt = [number, number];

/** A seeded Park–Miller generator (module-level so the render closure holds no reassigned local). */
function seededRandom(seed: number): () => number {
  const state = { s: seed };
  return () => {
    state.s = (Math.imul(state.s, 48271) % 2147483647 + 2147483647) % 2147483647;
    return state.s / 2147483647;
  };
}

/**
 * One brush stroke from `a` to `b`: 2–3 bristle bands side by side with thin gaps between them,
 * each a filled ribbon that swells early and tapers to a point at both ends, its edges jittered
 * so they are ragged. Each band carries its own opacity, so where strokes overlap the ink builds
 * up unevenly and the gaps between bristles let the background through.
 */
function brushStroke(a: Pt, b: Pt, width: number, rand: () => number): { d: string; o: number }[] {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len = Math.hypot(dx, dy) || 1;
  const nx = -dy / len;
  const ny = dx / len;
  const bands = width > 2.6 ? 3 : 2;
  const gap = 0.18; // share of the stroke's width left empty between neighbouring bands
  const bandW = (width * (1 - gap * (bands - 1))) / bands;
  const out: { d: string; o: number }[] = [];
  for (let k = 0; k < bands; k++) {
    // Band centre offset across the stroke, plus a little drift so bristles are not parallel.
    const off = -width / 2 + bandW / 2 + k * (bandW + width * gap);
    const drift = (rand() - 0.5) * bandW * 0.6;
    // A bristle may lift early or start late: dry brush.
    const t0 = rand() < 0.3 ? rand() * 0.25 : 0;
    const t1 = rand() < 0.35 ? 1 - rand() * 0.3 : 1;
    const n = 8;
    const top: Pt[] = [];
    const bottom: Pt[] = [];
    for (let i = 0; i <= n; i++) {
      const t = t0 + ((t1 - t0) * i) / n;
      const profile = Math.sin(Math.PI * Math.pow(i / n, 0.8));
      const half = (bandW / 2) * profile;
      const o = off + drift * (i / n);
      const cx = a[0] + dx * t + nx * o;
      const cy = a[1] + dy * t + ny * o;
      const jt = (rand() - 0.5) * bandW * 0.4;
      const jb = (rand() - 0.5) * bandW * 0.4;
      top.push([cx + nx * (half + jt), cy + ny * (half + jt)]);
      bottom.push([cx - nx * (half + jb), cy - ny * (half + jb)]);
    }
    const pts = [...top, ...bottom.reverse()];
    out.push({ d: `M${pts.map((p) => `${p[0].toFixed(2)},${p[1].toFixed(2)}`).join("L")}Z`, o: 0.4 + rand() * 0.4 });
  }
  return out;
}

type AthScribbleShape = {
  fills: { d: string; o: number }[];
  streaks: { d: string; w: number }[];
  /** The zigzag's centre lines (one run for a zigzag, one per swipe for `hatch`), for the pen. */
  runs: [number, number][][];
};

/**
 * The scribble's geometry at (x, y): a fill path (all strokes) and the dry streaks. `variant`
 * defaults to the one the seed picks.
 */
function athScribble(
  x: number,
  y: number,
  pen: ScribblePen,
  seed: number,
  variant?: AthScribbleVariant,
  /** Overrides the stroke count (the pen's two-zigzag mark sets one dense, one sparse). */
  strokes?: number
): AthScribbleShape {
  const rand = seededRandom(seed);
  const kind = variant ?? ATH_SCRIBBLE_VARIANTS[Math.floor(rand() * ATH_SCRIBBLE_VARIANTS.length)]!;
  // The band leans slightly (about −8°): strokes run across it (u), stepping down it (v).
  const baseAngle = (-8 + (rand() - 0.5) * 6) * (Math.PI / 180);
  const L = ATH_SCRIBBLE_LENGTH;
  const H = ATH_SCRIBBLE_HEIGHT;
  const n = strokes ?? pen.strokes + (kind === "tight" ? 1 : kind === "hatch" ? -2 : 0);
  const frame = (angle: number) => {
    const ux = Math.cos(angle);
    const uy = Math.sin(angle);
    return (u: number, v: number): Pt => [x + ux * u - uy * v, y + uy * u + ux * v];
  };
  const at = frame(baseAngle);
  // Everything stays inside the patch: a point is pulled back into the band's box (in the
  // band's own frame), so overshoots, streaks and the scrawl's drifting slant never poke out.
  const cosB = Math.cos(baseAngle);
  const sinB = Math.sin(baseAngle);
  const clampIn = (p: Pt, extraU = 0): Pt => {
    const lx = p[0] - x;
    const ly = p[1] - y;
    const u = lx * cosB + ly * sinB;
    const v = -lx * sinB + ly * cosB;
    const uc = Math.max(-L / 2 - 1, Math.min(L / 2 + 1 + extraU, u));
    const vc = Math.max(-H / 2, Math.min(H / 2, v));
    return at(uc, vc);
  };
  // Where each stroke sits down the band: even steps, or uneven ones (normalised to fill H).
  const steps = Array.from({ length: n }, () => (kind === "loose" || kind === "scrawl" ? 0.4 + rand() * 1.2 : 1));
  const total = steps.reduce((a, b) => a + b, 0);
  const vAt: number[] = [-H / 2];
  for (const st of steps) vAt.push(vAt[vAt.length - 1]! + (st / total) * H);

  const segs: [Pt, Pt][] = [];
  if (kind === "hatch") {
    // Separate swipes, all left to right, each a little lower: the pen lifts between them.
    for (let i = 0; i < n; i++) {
      const v = (vAt[i]! + vAt[i + 1]!) / 2 + (rand() - 0.5);
      const reach = 0.75 + rand() * 0.25;
      segs.push([at((-L / 2) * reach, v - 1.5), at((L / 2) * reach, v + 0.5)]);
    }
  } else {
    // A zigzag without lifting: each stroke starts where the last one turned.
    const turns: Pt[] = [];
    for (let k = 0; k <= n; k++) {
      const side = k % 2 === 0 ? -1 : 1;
      const short = kind === "loose" && rand() < 0.35 ? 0.45 + rand() * 0.3 : 1;
      const reach = (0.7 + rand() * 0.3) * short;
      const jitter = kind === "scrawl" ? (rand() - 0.5) * 3 : (rand() - 0.5) * 1.2;
      const f = kind === "scrawl" ? frame(baseAngle + (rand() - 0.5) * 0.5) : at;
      turns.push(f(side * (L / 2) * reach, vAt[k]! + jitter));
    }
    for (let i = 0; i < n; i++) segs.push([turns[i]!, turns[i + 1]!]);
  }

  const fills: { d: string; o: number }[] = [];
  const streaks: { d: string; w: number }[] = [];
  const runs: [number, number][][] = [];
  segs.forEach(([a, b], i) => {
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const len = Math.hypot(dx, dy) || 1;
    // Each stroke overshoots its turn a little, so the reversals read as loose, not as joined Vs.
    const over = 1 + rand() * 2;
    const b2 = clampIn([b[0] + (dx / len) * over, b[1] + (dy / len) * over]);
    const a2 = clampIn([a[0] - (dx / len) * over * 0.5, a[1] - (dy / len) * over * 0.5]);
    const w = pen.width * (0.75 + rand() * 0.4);
    fills.push(...brushStroke(a2, b2, w, rand));
    // The pen's centre line: a zigzag continues the previous run, a hatch swipe starts its own.
    if (kind === "hatch" || runs.length === 0) runs.push([a2, b2]);
    else runs[runs.length - 1]!.push(b2);
    // Dry streaks: thin hairlines trailing past some strokes' ends.
    if (rand() < 0.35) {
      const ext = 1.5 + rand() * 2;
      for (let k = 0; k < 2; k++) {
        const off = (k - 0.5) * w * 0.6;
        const [sx, sy] = clampIn([b2[0] - (dx / len) * 3 + (-dy / len) * off, b2[1] - (dy / len) * 3 + (dx / len) * off]);
        const [ex, ey] = clampIn([b2[0] + (dx / len) * ext + (-dy / len) * off, b2[1] + (dy / len) * ext + (dx / len) * off], 1.5);
        streaks.push({ d: `M${sx.toFixed(2)},${sy.toFixed(2)}L${ex.toFixed(2)},${ey.toFixed(2)}`, w: 0.35 + rand() * 0.35 });
      }
    }
    // The flick: the last stroke carries on as a long thin tail out past the patch.
    if (kind === "flick" && i === segs.length - 1) {
      // The one thing allowed past the patch, and only a little: the flick's tail.
      const tail = clampIn([b2[0] + (dx / len) * (L * 0.9), b2[1] + (dy / len) * (L * 0.9) - 1.5], L * 0.6);
      fills.push(...brushStroke(b2, tail, pen.width * 0.55, rand));
      runs[runs.length - 1]!.push(tail);
    }
  });
  return { fills, streaks, runs };
}

/**
 * The runs the marker draws. With the pen it is two zigzags overlapped in the same patch, as
 * when a mark is gone over twice: one with many turns and one with few, each with its own
 * seed and slant. The other pens draw one zigzag in the seed's variant.
 */
function athMarkerRuns(
  style: Exclude<ChartStyle, "plain">,
  x: number,
  y: number,
  seed: number,
  variant?: AthScribbleVariant
): [number, number][][] {
  const pen = ATH_SCRIBBLE_PEN[style];
  if (style !== "pen") return athScribble(x, y, pen, seed, variant).runs;
  const many = athScribble(x, y, pen, seed, variant, 8 + (seed % 3));
  const few = athScribble(x, y, pen, seed + 7919, variant === "hatch" ? "hatch" : "loose", 2 + (seed % 2));
  return [...many.runs, ...few.runs];
}

/**
 * The line pen the marker draws with. Watercolor's passes are deliberately weak (10–30%) and
 * screen-blended, which washes a small gold mark on a white line out to pale yellow, so its
 * mark gets more pigment: each pass at double opacity (capped at 1) and no screen blend. Same
 * soft edges and strokes; the lines themselves are untouched. Memoized per style so the pen
 * object stays stable across renders.
 */
const ATH_PEN_CACHE = new Map<ChartStyle, RoughPen | null>();
function athPenFor(style: ChartStyle): RoughPen | null {
  if (ATH_PEN_CACHE.has(style)) return ATH_PEN_CACHE.get(style)!;
  const base = roughPenFor(style);
  const pen =
    base && style === "watercolor"
      ? { ...base, blend: null, passes: base.passes.map((p) => ({ ...p, opacity: Math.min(1, p.opacity * 2) })) }
      : base;
  ATH_PEN_CACHE.set(style, pen);
  return pen;
}

function AthMarkerShape({
  cx,
  cy,
  xKey,
  opacity,
}: {
  cx?: number;
  cy?: number;
  xKey: string;
  opacity: number;
}) {
  // A new shape each time the chart mounts (a fresh page load or visit), held for the mount's
  // lifetime so hover re-renders keep it still. The peak's own hash is mixed in so two charts
  // mounted in the same tick still differ.
  const [mountSalt] = useState(() => Math.floor(Math.random() * 2147483646) + 1);
  const seed = ((seedFor(xKey) ^ mountSalt) >>> 0) % 2147483647 || 1;
  const style = useChartStyle();
  const x = cx ?? 0;
  const y = cy ?? 0;
  const pen = style === "plain" ? null : ATH_SCRIBBLE_PEN[style];
  const shape = useMemo(
    () => (pen && style !== "plain" ? { runs: athMarkerRuns(style, x, y, seed) } : null),
    [pen, style, seed, x, y]
  );

  if (!pen || !shape) {
    const w = ATH_MARKER_WIDTH;
    const h = ATH_MARKER_HEIGHT;
    return (
      <rect
        x={x - w / 2}
        y={y - h / 2}
        width={w}
        height={h}
        fill={ATH_MARKER_STROKE}
        fillOpacity={ATH_MARKER_OPACITY * opacity}
        style={{ pointerEvents: "none" }}
      />
    );
  }
  // Drawn with the chart's own pen (the same passes, soft edges and ends as the line it marks),
  // in gold, along the zigzag's centre lines.
  const linePen = athPenFor(style);
  if (!linePen) return null;
  return (
    <g className="nw-rough nw-rough--ath" style={{ pointerEvents: "none" }}>
      <RoughPolylines runs={shape.runs} color={ATH_MARKER_STROKE} pen={linePen} seed={seed} width={ATH_PEN_WIDTH} opacity={opacity} />
    </g>
  );
}

/**
 * The ATH marker: a short translucent vertical tick on the peak point (a dry-brush scribble on
 * it in the hand-drawn chart styles), nothing else — the docked tooltip already names that
 * point's date and value on hover, so the marker carries no label of its own.
 * Placement (which grid row) is `athMarkerPlacement.ts`.
 */
export function renderAthMarker({
  x,
  y,
  opacity,
}: {
  /** Category x value of the plotted row carrying the peak. */
  x: string;
  /** The peak's value (a plotted point at this grain). */
  y: number;
  /** Follows the marked line's legend-focus dimming. */
  opacity: number;
}): ReactElement {
  return (
    <ReferenceDot
      key={`ath-${x}`}
      x={x}
      y={y}
      r={ATH_SCRIBBLE_LENGTH / 2}
      zIndex={DefaultZIndexes.activeDot}
      ifOverflow="discard"
      shape={(p: { cx?: number; cy?: number }) => (
        <AthMarkerShape cx={p.cx} cy={p.cy} xKey={x} opacity={opacity} />
      )}
    />
  );
}

/**
 * Rehearsal (2026-11-03): every scribble variant, a few seeds each, in the current chart style
 * (the lab page renders this under each style's column). Drawn on a dark tile at 3× so the
 * strokes can be compared.
 */
export function AthScribbleSamples() {
  const style = useChartStyle();
  if (style === "plain") return null;
  const seeds = [11, 23, 37, 51];
  const cell = 26;
  const scale = 3;
  return (
    <div style={{ display: "grid", gap: 4 }}>
      {ATH_SCRIBBLE_VARIANTS.map((variant) => (
        <div key={variant} style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span className="muted" style={{ width: "4.5rem", fontSize: "var(--font-size-caption)" }}>
            {variant}
          </span>
          {seeds.map((seed) => {
            const sh = { runs: athMarkerRuns(style, cell / 2, cell / 2, seed, variant) };
            const linePen = athPenFor(style);
            return (
              <svg key={seed} width={cell * scale} height={cell * scale} viewBox={`0 0 ${cell} ${cell}`} style={{ background: "var(--bg)" }}>
                {linePen ? (
                  <RoughPolylines runs={sh.runs} color={ATH_MARKER_STROKE} pen={linePen} seed={seed} width={ATH_PEN_WIDTH} />
                ) : null}
              </svg>
            );
          })}
        </div>
      ))}
    </div>
  );
}
