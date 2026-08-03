import { useSyncExternalStore } from "react";

/**
 * The one narrow-viewport breakpoint, shared with CSS. Anything that swaps layout by width
 * uses `@media (max-width: 879px)` (shell.css, tables.css `.mobile-only`); this constant is
 * the JS half of that same line so the two can never drift.
 */
export const NARROW_VIEWPORT_MEDIA_QUERY = "(max-width: 879px)";

function mediaQueryList(): MediaQueryList | null {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return null;
  return window.matchMedia(NARROW_VIEWPORT_MEDIA_QUERY);
}

let cachedList: MediaQueryList | null | undefined;

function list(): MediaQueryList | null {
  if (cachedList === undefined) cachedList = mediaQueryList();
  return cachedList;
}

function subscribe(onChange: () => void): () => void {
  const mql = list();
  if (!mql) return () => {};
  mql.addEventListener("change", onChange);
  return () => mql.removeEventListener("change", onChange);
}

function getSnapshot(): boolean {
  return list()?.matches ?? false;
}

/**
 * True on phone-width viewports. Used where a layout decision cannot be expressed in CSS —
 * chart axis tick TEXT, which is a string a Recharts `tickFormatter` produces (see
 * `moneyYAxisProps` in components/charts/chartLayout.ts).
 *
 * Non-browser contexts (vitest, SSR) report `false`, so tests and any server render see the
 * desktop presentation. Prefer plain CSS whenever the change is purely visual.
 */
export function useIsNarrowViewport(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, () => false);
}
