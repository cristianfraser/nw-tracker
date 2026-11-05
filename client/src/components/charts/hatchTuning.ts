import { useSyncExternalStore } from "react";

/**
 * The hand-drawn hatch's two tunable angles, tried live from {@link HatchTuningControl}:
 * `range` — the degrees a chart's bar series spread over, centred on 45°; `noise` — how far each
 * bar, map tile and area run tilts off its base, either way. Kept per browser.
 */
export type HatchTuning = { range: number; noise: number };

export const HATCH_TUNING_DEFAULT: HatchTuning = { range: 11, noise: 14 };
export const HATCH_TUNING_LIMITS = { range: [0, 60], noise: [0, 20] } as const;

const LS_KEY = "nw-tracker.hatchTuning";

function clamp(v: unknown, [lo, hi]: readonly [number, number], fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback;
}

function readStored(): HatchTuning {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return HATCH_TUNING_DEFAULT;
    const v = JSON.parse(raw) as Partial<HatchTuning>;
    return {
      range: clamp(v.range, HATCH_TUNING_LIMITS.range, HATCH_TUNING_DEFAULT.range),
      noise: clamp(v.noise, HATCH_TUNING_LIMITS.noise, HATCH_TUNING_DEFAULT.noise),
    };
  } catch {
    return HATCH_TUNING_DEFAULT;
  }
}

let current: HatchTuning = typeof window === "undefined" ? HATCH_TUNING_DEFAULT : readStored();
const listeners = new Set<() => void>();

export function setHatchTuning(next: Partial<HatchTuning>): void {
  current = {
    range: clamp(next.range ?? current.range, HATCH_TUNING_LIMITS.range, current.range),
    noise: clamp(next.noise ?? current.noise, HATCH_TUNING_LIMITS.noise, current.noise),
  };
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(current));
  } catch {
    // A blocked storage only loses the setting on reload.
  }
  for (const l of listeners) l();
}

export function useHatchTuning(): HatchTuning {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => current,
    () => HATCH_TUNING_DEFAULT
  );
}
