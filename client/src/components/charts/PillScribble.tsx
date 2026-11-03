import { useMemo, useState } from "react";
import type { Point } from "roughjs/bin/geometry";
import { useChartStyle } from "./chartStyle";
import { RoughPolylines, roughPenFor, squigglePenFor, type RoughPen } from "./roughShapes";

/**
 * How a pill is coloured in, per pen: the zigzag's step (px between turns) and an opacity factor
 * on the pen's passes. The fine pens (pen, pencil) go denser with lighter strokes, so the fill
 * builds up from many translucent lines; the wide ones need fewer, fuller strokes.
 */
const PILL_FILL: Record<string, { step: [number, number]; ink: number }> = {
  pen: { step: [1.1, 1.4], ink: 1.05 },
  pencil: { step: [1.0, 1.3], ink: 1.05 },
  default: { step: [1.7, 2.2], ink: 1.5 },
};

/** A pill's pen: the line pen with its passes' opacity scaled by `ink` (capped). */
const PILL_PEN_CACHE = new Map<string, WeakMap<RoughPen, RoughPen>>();
function pillPenFor(pen: RoughPen, ink: number): RoughPen {
  const key = String(ink);
  let byPen = PILL_PEN_CACHE.get(key);
  if (!byPen) {
    byPen = new WeakMap();
    PILL_PEN_CACHE.set(key, byPen);
  }
  const cached = byPen.get(pen);
  if (cached) return cached;
  const base = squigglePenFor(pen);
  // A pill is a filled shape, not a line: none of the line's hand habits that throw ink outside
  // it (strays, overshoots, ink dots, dry skips) and a tight rough offset. The few deliberate
  // overshoots are placed by the scribble itself (see OVERSHOOT_PILL_CHANCE).
  const derived = {
    ...base,
    roughness: Math.min(base.roughness, 1),
    maxOffset: Math.min(base.maxOffset, 0.8),
    strayChance: 0,
    overshootPx: [0, 0.3] as const,
    overlapPx: [0.5, 1.5] as const,
    ends: { ...base.ends, dotChance: 0 },
    repair: { ...base.repair, skipChance: 0, repairChance: 0 },
    passes: base.passes.map((p) => ({ ...p, opacity: Math.min(1, p.opacity * ink) })),
  } as RoughPen;
  byPen.set(pen, derived);
  return derived;
}

/** A seeded Park–Miller generator (module-level, so the memo holds no reassigned local). */
function seededRandom(seed: number): () => number {
  const state = { s: seed };
  return () => {
    state.s = (Math.imul(state.s, 48271) % 2147483647 + 2147483647) % 2147483647;
    return state.s / 2147483647;
  };
}

/**
 * About one pill in four (between one in three and one in six) lets the hand slip: one or two of
 * its zigzag tips run 1–3 px past the outline. Every other pill stays inside.
 */
const OVERSHOOT_PILL_CHANCE = 0.24;

/** An outline-only pill paints no colour of its own: its scribble uses a muted grey. */
function visibleColor(color: string): string {
  const c = color.replace(/\s/g, "").toLowerCase();
  return c === "transparent" || c === "rgba(0,0,0,0)" || c === "none" ? "#64748b" : color;
}

/**
 * A pill coloured in by hand (the hand-drawn chart styles): a back-and-forth scribble that fills
 * the pill's rounded shape, drawn with the selected pen in the pill's colour, no border. The pill
 * keeps its text on top. Loaded lazily by `Pill` (this module pulls in the chart engine, which
 * the first page load leaves out), and only when a hand-drawn style is on.
 */
export default function PillScribble({ w, h, color }: { w: number; h: number; color: string }) {
  const style = useChartStyle();
  const pen = roughPenFor(style);
  const fill = PILL_FILL[style] ?? PILL_FILL.default!;
  // A different scribble for every pill, drawn once per mount.
  const [seed] = useState(() => Math.floor(Math.random() * 2147483646) + 1);
  const runs = useMemo(() => {
    if (w < 4 || h < 4) return [];
    const rnd = seededRandom(seed);
    const r = h / 2;
    const step = fill.step[0] + rnd() * (fill.step[1] - fill.step[0]);
    // Vertical reach inside the stadium at x: full height in the middle, a half circle at the ends.
    const reach = (x: number) => {
      const dx = x < r ? r - x : x > w - r ? x - (w - r) : 0;
      return Math.sqrt(Math.max(0, r * r - dx * dx));
    };
    const pts: Point[] = [];
    let top = rnd() < 0.5;
    for (let x = 1.2; x <= w - 1.2; x += step * (0.8 + rnd() * 0.4)) {
      const span = Math.max(0.6, reach(x) - 1.1);
      const y = r + (top ? -span : span) * (0.85 + rnd() * 0.15);
      pts.push([x + (rnd() - 0.5) * 0.6, y]);
      top = !top;
    }
    // The odd slip: on a few pills, one or two tips (not the first or last) run past the edge.
    if (pts.length > 4 && rnd() < OVERSHOOT_PILL_CHANCE) {
      const slips = rnd() < 0.6 ? 1 : 2;
      for (let k = 0; k < slips; k++) {
        const i = 1 + Math.floor(rnd() * (pts.length - 2));
        const [x, y] = pts[i]!;
        const out = 1 + rnd() * 2;
        pts[i] = [x, y < r ? y - out : y + out];
      }
    }
    return pts.length >= 2 ? [pts] : [];
  }, [seed, w, h, fill]);
  if (!pen || !runs.length) return null;
  return (
    <svg
      width={w}
      height={h}
      aria-hidden="true"
      style={{ position: "absolute", left: 0, top: 0, pointerEvents: "none", overflow: "visible" }}
    >
      <RoughPolylines runs={runs} color={visibleColor(color)} pen={pillPenFor(pen, fill.ink)} seed={seed} width={2.4} />
    </svg>
  );
}
