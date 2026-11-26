/** The motion of the home «Últimos movimientos» list: a new row fades in, the rows below slide down (desktop only). */

export type ArrivalAction = "add" | "remain" | "remove";

export type ArrivalCoords = { top: number; left: number; width: number; height: number };

export type ArrivalMotion = {
  keyframes: Keyframe[];
  /** Milliseconds; 0 = the change is instant. */
  duration: number;
  /** A highlight tint to run beside the fade (a new row, even under reduced motion). */
  tint: boolean;
};

export const ARRIVAL_FADE_MS = 200;
export const ARRIVAL_SLIDE_MS = 220;
export const ARRIVAL_TINT_MS = 1500;

const INSTANT: ArrivalMotion = { keyframes: [{ opacity: 1 }, { opacity: 1 }], duration: 0, tint: false };

/**
 * What one row does when the list changes. `arrived` = its key was not shown before (an add of a
 * row that is only back after a re-mount is no arrival). Pure; narrow / reduced-motion are read by
 * the caller when the animation runs.
 */
export function arrivalMotion(input: {
  action: ArrivalAction;
  arrived: boolean;
  narrow: boolean;
  reducedMotion: boolean;
  from?: ArrivalCoords;
  to?: ArrivalCoords;
}): ArrivalMotion {
  const { action, arrived, narrow, reducedMotion, from, to } = input;
  if (action === "remove") return INSTANT;
  if (action === "add") {
    if (!arrived) return INSTANT;
    if (reducedMotion) return { ...INSTANT, tint: true };
    return { keyframes: [{ opacity: 0 }, { opacity: 1 }], duration: ARRIVAL_FADE_MS, tint: true };
  }
  if (narrow || reducedMotion || !from || !to) return INSTANT;
  const dx = from.left - to.left;
  const dy = from.top - to.top;
  if (dx === 0 && dy === 0) return INSTANT;
  return {
    keyframes: [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "translate(0, 0)" }],
    duration: ARRIVAL_SLIDE_MS,
    tint: false,
  };
}

/** The keys of a list the first time it has rows are the baseline, never arrivals; later keys not yet seen are. */
export function nextSeenKeys(
  seen: ReadonlySet<string> | null,
  keys: readonly string[]
): { seen: ReadonlySet<string> | null; arrived: ReadonlySet<string> } {
  if (seen == null) return { seen: keys.length > 0 ? new Set(keys) : null, arrived: new Set() };
  const arrived = new Set(keys.filter((k) => !seen.has(k)));
  return { seen: arrived.size > 0 ? new Set([...seen, ...keys]) : seen, arrived };
}
