import { useLayoutEffect, type RefObject } from "react";

/**
 * A row list drawn on one line while its columns fit and wrapped otherwise: adds `wrappedClass`
 * to the list when its one-line columns are wider than the list. Measured after every render (the
 * widest value can change on any) and on every width change; never a breakpoint, since the
 * columns are as wide as their data.
 */
export function useWrapWhenOverflowing(listRef: RefObject<HTMLElement | null>, wrappedClass: string): void {
  // No deps: the rows can change on any render.
  useLayoutEffect(() => {
    fit(listRef.current, wrappedClass);
  });

  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list || typeof ResizeObserver === "undefined") return;
    let lastWidth = list.clientWidth;
    const ro = new ResizeObserver(() => {
      if (list.clientWidth === lastWidth) return;
      lastWidth = list.clientWidth;
      fit(list, wrappedClass);
    });
    ro.observe(list);
    return () => ro.disconnect();
  }, [listRef, wrappedClass]);
}

function fit(list: HTMLElement | null, wrappedClass: string): void {
  if (!list) return;
  list.classList.remove(wrappedClass);
  if (list.scrollWidth > list.clientWidth + 0.5) list.classList.add(wrappedClass);
}
