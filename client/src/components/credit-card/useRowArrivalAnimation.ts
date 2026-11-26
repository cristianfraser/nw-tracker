import { useEffect, useRef } from "react";
import autoAnimate from "@formkit/auto-animate";
import { NARROW_VIEWPORT_MEDIA_QUERY } from "../../useIsNarrowViewport";
import { ARRIVAL_TINT_MS, arrivalMotion, type ArrivalAction } from "../../rowArrivalAnimation";

/** Attribute a row wrapper carries while its key is new to the list (read by the animation, not by CSS). */
export const ROW_ARRIVED_ATTR = "data-row-arrived";

function matches(query: string): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(query).matches;
}

/**
 * Animates the rows of `listRef` (direct children carrying `data-row-arrived` when new) with
 * auto-animate's keyframe plugin. Phone width and reduced motion are read when the animation runs.
 */
export function useRowArrivalAnimation(enabled: boolean) {
  const listRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = listRef.current;
    if (!enabled || !el) return;
    const controller = autoAnimate(el, (row, action, oldCoords, newCoords) => {
      const motion = arrivalMotion({
        action: action as ArrivalAction,
        arrived: row.hasAttribute(ROW_ARRIVED_ATTR),
        narrow: matches(NARROW_VIEWPORT_MEDIA_QUERY),
        reducedMotion: matches("(prefers-reduced-motion: reduce)"),
        from: oldCoords ?? undefined,
        to: newCoords ?? undefined,
      });
      // The tint is read from the stylesheet (theme-aware) and handed to the animation as a colour:
      // keyframes do not resolve custom properties everywhere.
      const tint = getComputedStyle(row).getPropertyValue("--row-arrival-tint").trim();
      if (motion.tint && tint && typeof row.animate === "function") {
        row.animate([{ backgroundColor: tint }, { backgroundColor: "transparent" }], {
          duration: ARRIVAL_TINT_MS,
          easing: "ease-out",
        });
      }
      return new KeyframeEffect(row, motion.keyframes, { duration: motion.duration, easing: "ease-out" });
    });
    return () => controller.disable();
  }, [enabled]);
  return listRef;
}
