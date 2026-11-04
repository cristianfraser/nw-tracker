import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { useLocation } from "react-router-dom";

/**
 * Page-view beacon of the usage log (server: `usageLog.ts`, `POST /api/usage/page-view`): one
 * report per route change, with how long the page's queries took to settle.
 *
 * Settled = no query fetching for {@link QUIET_MS}; the time reported is the moment the last
 * fetch ended (or, when nothing had to be fetched, the first check), measured from the route
 * change — from page start for the first page of a load, so it includes loading the app. A view
 * left, hidden in a background tab or still fetching after {@link TIMEOUT_MS} is reported without
 * a time. The server ignores the beacon when its usage log is off (secondary dev servers).
 *
 * On the hosted demo this is also its anonymous pageview record: the server tags each view with
 * the visitor's daily hash, and the beacon carries the landing URL's `?src=` campaign tag
 * (linkedin / cv / homepage), kept for the whole visit.
 */

const BEACON_PATH = "/api/usage/page-view";
const SRC_STORAGE_KEY = "nw:demo-src";
/** Long enough for a lazy chunk to load and its queries to start before calling a page settled. */
const QUIET_MS = 400;
const TIMEOUT_MS = 60_000;

type Outcome = "settled" | "left" | "hidden" | "timeout";

/** The pathname whose page said it found nothing to show (`useMarkUsagePageNotFound`). */
let notFoundPathname: string | null = null;

/**
 * Called by a page that renders «not found» (the catch-all route, an unknown group): its view is
 * recorded under `/404`, with the path that led there. Set while rendering, not in an effect: a
 * view can be reported in the commit's own effects (a hidden tab finishes at once), and a child
 * renders before any effect of that commit runs. Idempotent, so a repeated render is harmless.
 */
export function useMarkUsagePageNotFound(): void {
  notFoundPathname = useLocation().pathname;
}

function captureSrcTag(): string | null {
  try {
    const fromUrl = new URLSearchParams(window.location.search).get("src");
    if (fromUrl) sessionStorage.setItem(SRC_STORAGE_KEY, fromUrl);
    return sessionStorage.getItem(SRC_STORAGE_KEY);
  } catch {
    // Private-mode sessionStorage can throw; the tag is a nice-to-have, the view isn't.
    return null;
  }
}

function sendPageView(body: {
  path: string;
  initial: boolean;
  outcome: Outcome;
  settle_ms: number | null;
  fetched_queries: number;
  not_found: boolean;
}): void {
  const payload = JSON.stringify({ ...body, src: captureSrcTag() });
  const blob = new Blob([payload], { type: "application/json" });
  if (navigator.sendBeacon?.(BEACON_PATH, blob)) return;
  void fetch(BEACON_PATH, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: payload,
    keepalive: true,
  }).catch(() => {
    /* telemetry must never surface an error to the user */
  });
}

export function useUsagePageTiming(): void {
  const { pathname } = useLocation();
  const queryClient = useQueryClient();
  const firstView = useRef(true);

  useEffect(() => {
    const initial = firstView.current;
    firstView.current = false;
    const t0 = initial ? 0 : performance.now();
    // The page's own queries start in its effects, which run before this one (a parent's).
    const fetched = new Set<string>(
      queryClient.getQueryCache().findAll({ fetchStatus: "fetching" }).map((q) => q.queryHash)
    );
    let lastIdleAt = performance.now();
    let done = false;
    let quietTimer: ReturnType<typeof setTimeout> | undefined;
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;

    const stop = () => {
      done = true;
      clearTimeout(quietTimer);
      clearTimeout(timeoutTimer);
      unsubscribe();
      document.removeEventListener("visibilitychange", onVisibility);
    };
    const finish = (outcome: Outcome) => {
      if (done) return;
      stop();
      const notFound = notFoundPathname === pathname;
      if (notFound) notFoundPathname = null;
      sendPageView({
        path: pathname,
        initial,
        outcome,
        settle_ms: outcome === "settled" ? Math.max(0, lastIdleAt - t0) : null,
        fetched_queries: fetched.size,
        not_found: notFound,
      });
    };
    const armQuiet = () => {
      clearTimeout(quietTimer);
      if (queryClient.isFetching() > 0) return;
      quietTimer = setTimeout(() => {
        if (queryClient.isFetching() === 0) finish("settled");
      }, QUIET_MS);
    };
    const unsubscribe = queryClient.getQueryCache().subscribe((event) => {
      if (event.type !== "updated") return;
      if (event.action.type === "fetch") {
        fetched.add(event.query.queryHash);
        clearTimeout(quietTimer);
      } else if (queryClient.isFetching() === 0) {
        lastIdleAt = performance.now();
        armQuiet();
      }
    });
    const onVisibility = () => {
      if (document.visibilityState === "hidden") finish("hidden");
    };
    document.addEventListener("visibilitychange", onVisibility);
    timeoutTimer = setTimeout(() => finish("timeout"), TIMEOUT_MS);
    armQuiet();
    // StrictMode (dev) mounts every effect twice in the same commit: a cleanup before this
    // microtask is that rehearsal, not a page left — drop it and keep the view for the re-run.
    let rehearsal = true;
    queueMicrotask(() => {
      rehearsal = false;
      if (document.visibilityState === "hidden") finish("hidden");
    });

    return () => {
      if (rehearsal) {
        stop();
        firstView.current = initial;
        return;
      }
      finish("left");
    };
  }, [pathname, queryClient]);
}
