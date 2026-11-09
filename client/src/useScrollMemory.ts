import { useEffect, useLayoutEffect, useRef } from "react";
import { useLocation } from "react-router-dom";

/**
 * Where each URL (path + query) was left, for this page load only: a reload starts every page
 * at the top again. A route never visited opens at the top; one visited earlier opens where it
 * was left. The document is the scroll container (`.layout-main` grows with its content).
 */
const savedScrollByUrl = new Map<string, number>();

/** How long a restore keeps trying while the page's content grows tall enough to reach it. */
const RESTORE_WAIT_MS = 3000;

/** A URL whose next arrival leaves the scroll alone (its page scrolls itself; see {@link skipNextScrollRestore}). */
let skipRestoreFor: string | null = null;

/**
 * The next arrival at `pathname` (+ `search`) does not restore or reset the scroll: the caller
 * scrolls itself. The demo's About page smooth-scrolls to the top before the dashboard moves in.
 * Must be called before the route change's layout effects reach this hook (a descendant's layout
 * effect, which runs first, qualifies).
 */
export function skipNextScrollRestore(pathname: string, search = ""): void {
  skipRestoreFor = scrollMemoryKey(pathname, search);
}

function scrollMemoryKey(pathname: string, search: string): string {
  return `${pathname}${search}`;
}

export function useScrollMemory(): void {
  const { pathname, search } = useLocation();
  const key = scrollMemoryKey(pathname, search);
  const currentKey = useRef(key);

  // The browser's own restoration would fight this one on back/forward, and on reload.
  useEffect(() => {
    if (!("scrollRestoration" in history)) return;
    const previous = history.scrollRestoration;
    history.scrollRestoration = "manual";
    return () => {
      history.scrollRestoration = previous;
    };
  }, []);

  // Record the position as the user scrolls, so leaving a page needs no last read (by the time a
  // route change commits, the new content may already have clamped the old position).
  useEffect(() => {
    const onScroll = () => {
      savedScrollByUrl.set(currentKey.current, window.scrollY);
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  useLayoutEffect(() => {
    if (currentKey.current === key) return;
    currentKey.current = key;
    if (skipRestoreFor === key) {
      skipRestoreFor = null;
      return;
    }
    const target = savedScrollByUrl.get(key) ?? 0;
    window.scrollTo({ top: target });
    if (target === 0) return;

    // The page may still be loading: keep trying until it is tall enough, unless the user
    // starts scrolling first.
    let frame = 0;
    const started = performance.now();
    const stop = () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("wheel", stop);
      window.removeEventListener("touchstart", stop);
      window.removeEventListener("keydown", stop);
    };
    const retry = () => {
      if (Math.abs(window.scrollY - target) < 2) return stop();
      window.scrollTo({ top: target });
      if (performance.now() - started < RESTORE_WAIT_MS) frame = requestAnimationFrame(retry);
      else stop();
    };
    window.addEventListener("wheel", stop, { passive: true });
    window.addEventListener("touchstart", stop, { passive: true });
    window.addEventListener("keydown", stop);
    frame = requestAnimationFrame(retry);
    return stop;
  }, [key]);
}
