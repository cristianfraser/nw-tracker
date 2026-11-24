/**
 * Layout for the property and mortgage pages' hand-drawn charts (`DeptoCharts.tsx`): day numbers,
 * scales, January-phased month ticks and end-label spacing. Pure, no figures of its own: every
 * value drawn is the server's (`depto_glance`).
 */

/** Days since the epoch of an ISO day (`YYYY-MM-DD`) or month (`YYYY-MM`, its 1st). */
export function dayNumber(iso: string): number {
  const m = /^(\d{4})-(\d{2})(?:-(\d{2}))?/.exec(iso);
  if (!m) throw new Error(`depto chart: not an ISO date: ${iso}`);
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, m[3] ? Number(m[3]) : 1) / 86_400_000;
}

/** A linear map from [d0, d1] to [r0, r1] (a flat domain maps to r0). */
export function linear(d0: number, d1: number, r0: number, r1: number): (v: number) => number {
  const span = d1 - d0;
  return (v) => (span === 0 ? r0 : r0 + ((v - d0) / span) * (r1 - r0));
}

/** The month strides an axis may take: divisors of 12, so ticks phase on January. */
const MONTH_STRIDES = [1, 2, 3, 4, 6, 12] as const;

/**
 * Which months get a tick: the smallest January-phased stride whose ticks sit at least `minPx`
 * apart, plus the first month when it is off-phase and has room before the next tick. A tick
 * carries its year on January and on the first one.
 */
export function monthTicks(
  months: readonly string[],
  pxPerMonth: number,
  minPx: number
): { index: number; month: string; withYear: boolean }[] {
  if (months.length === 0 || !(pxPerMonth > 0)) return [];
  const stride = MONTH_STRIDES.find((s) => s * pxPerMonth >= minPx) ?? 12;
  const monthOf = (ym: string) => Number(ym.slice(5, 7));
  const ticks: { index: number; month: string; withYear: boolean }[] = [];
  months.forEach((ym, index) => {
    if ((monthOf(ym) - 1) % stride === 0) ticks.push({ index, month: ym, withYear: monthOf(ym) === 1 });
  });
  const first = ticks[0];
  if (!first || (first.index !== 0 && first.index * pxPerMonth >= minPx)) {
    ticks.unshift({ index: 0, month: months[0]!, withYear: true });
  }
  ticks[0]!.withYear = true;
  return ticks;
}

/** The months from `from` to `to` (`YYYY-MM`), both included. */
export function monthsBetween(from: string, to: string): string[] {
  const out: string[] = [];
  let y = Number(from.slice(0, 4));
  let m = Number(from.slice(5, 7));
  const end = to.slice(0, 7);
  for (let guard = 0; guard < 2400; guard++) {
    const ym = `${y}-${String(m).padStart(2, "0")}`;
    out.push(ym);
    if (ym >= end) break;
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
  return out;
}

/**
 * End labels stacked beside a chart's right edge: each wants its line's height (`y`); they are
 * pushed apart to at least `gap` px, kept inside [top, bottom], in the order they want.
 */
export function spreadLabels<T extends { y: number }>(labels: readonly T[], gap: number, top: number, bottom: number): (T & { at: number })[] {
  const sorted = labels.map((l, i) => ({ l, i })).sort((a, b) => a.l.y - b.l.y);
  const at = sorted.map((s) => Math.min(Math.max(s.l.y, top), bottom));
  for (let k = 1; k < at.length; k++) at[k] = Math.max(at[k]!, at[k - 1]! + gap);
  const overflow = at.length ? at[at.length - 1]! - bottom : 0;
  if (overflow > 0) {
    at[at.length - 1] = bottom;
    for (let k = at.length - 2; k >= 0; k--) at[k] = Math.min(at[k]!, at[k + 1]! - gap);
  }
  const out: (T & { at: number })[] = new Array(labels.length);
  sorted.forEach((s, k) => {
    out[s.i] = { ...s.l, at: at[k]! };
  });
  return out;
}

/** A polyline's `points` attribute. */
export function pointsAttr(pts: readonly (readonly [number, number])[]): string {
  return pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
}

/** A step-after path through (x, y) points (horizontal first, then the drop). */
export function stepPoints(pts: readonly (readonly [number, number])[]): [number, number][] {
  const out: [number, number][] = [];
  pts.forEach(([x, y], i) => {
    if (i > 0) out.push([x, out[out.length - 1]![1]]);
    out.push([x, y]);
  });
  return out;
}
