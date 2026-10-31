/**
 * Random streams keyed by (seed, label): each month and each purpose draws from its own stream,
 * so adding a month (the demo is regenerated at every deploy and always ends today) never changes
 * a past month's numbers, and changing one purpose's draws never moves another's.
 */

function hash32(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

/** mulberry32. */
function mulberry(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type Rng = {
  /** Uniform [0, 1). */
  next(): number;
  /** Uniform [a, b). */
  range(a: number, b: number): number;
  /** Integer in [a, b]. */
  int(a: number, b: number): number;
  /** base × (1 ± pct), uniform. */
  jitter(base: number, pct: number): number;
  /** Roughly normal (sum of three uniforms), mean 0, sd ≈ 1. */
  gauss(): number;
  pick<T>(items: readonly T[]): T;
  chance(p: number): boolean;
};

export function stream(seed: number, label: string): Rng {
  const r = mulberry(hash32(`${seed}|${label}`));
  const next = () => r();
  return {
    next,
    range: (a, b) => a + (b - a) * next(),
    int: (a, b) => a + Math.floor(next() * (b - a + 1)),
    jitter: (base, pct) => base * (1 + (next() * 2 - 1) * pct),
    gauss: () => (next() + next() + next() - 1.5) * 2,
    pick: (items) => items[Math.floor(next() * items.length)]!,
    chance: (p) => next() < p,
  };
}
