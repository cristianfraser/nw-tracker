import { useLayoutEffect, useRef, type RefObject } from "react";
import { NARROW_VIEWPORT_MEDIA_QUERY } from "../../useIsNarrowViewport";

/** On `.table-wrap` while the table's desktop rendering is wider than the wrap (tables.css). */
export const TABLE_WRAP_CARDS_CLASS = "table-wrap--cards";

/**
 * Shows a parallel-rendering table (desktop columns + mobile card cell, «UI tables — desktop/mobile
 * sync» in AGENTS.md) as its cards whenever its desktop rendering does not fit the width it is
 * given — not only below the 880 viewport line. A table's columns are as wide as its data (a
 * peso balance in the hundreds of millions, a «$X → US$Y» conversion), so no fixed breakpoint is
 * right for every table: between 880 and ~1100 the content column is narrower than several of
 * them, and the overflow scrolled the page sideways.
 *
 * After every render and on every size change of the wrap, the desktop rendering is measured
 * with the class removed (synchronously, before paint, so nothing flashes), and the class is
 * set when the table is wider than the wrap. The class is written to the DOM directly, not kept
 * in React state, so a measurement never re-renders the table. Below 880 the stylesheet shows
 * the cards whatever this says, so nothing is measured there.
 */
export function useTableFit(
  enabled: boolean
): { wrapRef: RefObject<HTMLDivElement>; tableRef: RefObject<HTMLTableElement> } {
  const wrapRef = useRef<HTMLDivElement>(null);
  const tableRef = useRef<HTMLTableElement>(null);

  // No deps: the rows (and so the desktop width) can change on any render.
  useLayoutEffect(() => {
    if (enabled) fitTable(wrapRef.current, tableRef.current);
  });

  useLayoutEffect(() => {
    const wrap = wrapRef.current;
    if (!enabled || !wrap || typeof ResizeObserver === "undefined") return;
    let lastWidth = wrap.clientWidth;
    const ro = new ResizeObserver(() => {
      // Height changes (a page of rows loading) do not change the fit.
      if (wrap.clientWidth === lastWidth) return;
      lastWidth = wrap.clientWidth;
      fitTable(wrap, tableRef.current);
    });
    ro.observe(wrap);
    return () => ro.disconnect();
  }, [enabled]);

  return { wrapRef, tableRef };
}

function fitTable(wrap: HTMLDivElement | null, table: HTMLTableElement | null): void {
  if (!wrap || !table) return;
  if (typeof window.matchMedia === "function" && window.matchMedia(NARROW_VIEWPORT_MEDIA_QUERY).matches) {
    wrap.classList.remove(TABLE_WRAP_CARDS_CLASS);
    return;
  }
  wrap.classList.remove(TABLE_WRAP_CARDS_CLASS);
  const available = wrap.clientWidth;
  // A table never shrinks below its columns' minimum: wider than the wrap = it does not fit.
  const needed = table.getBoundingClientRect().width;
  if (available > 0 && needed > available + 0.5) wrap.classList.add(TABLE_WRAP_CARDS_CLASS);
}
