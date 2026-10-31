import type { NextFunction, Request, RequestHandler, Response } from "express";
import { USAGE_PAGE_VIEW_PATH } from "./usagePagePath.js";

/**
 * Counts the `/api` requests in flight, so background work (the cache warmer) can step aside:
 * {@link whenNoApiRequestsInFlight} resolves once no request has been in flight for a short settle
 * window. A page requested while the warmer waits is built by its own request, and the warmer's
 * next step is then a cache hit — the request never waits behind the rest of the warm.
 *
 * Only the gaps between the warmer's steps wait. A step itself never does: a request may be
 * awaiting the very promise the step is building (the page bundle, the nav context), and waiting
 * there would hold that request until it turned stale.
 */

/**
 * After the last request finishes, how long the counter must stay at zero. A page fires its
 * queries in a burst, then the ones that depend on the first answers, and a live-quotes stamp
 * change makes the client refetch everything one round trip after the stamp answers: 250 ms covers
 * a phone's round trip over Tailscale (50-150 ms) plus the browser's render-to-fetch gap, and costs
 * the warmer at most that per step while someone is browsing.
 */
export const API_IN_FLIGHT_SETTLE_MS = 250;
/**
 * A request in flight longer than this stops counting. Cold builds are synchronous and hold the
 * event loop (and the warmer) anyway, so only a request awaiting something counts for long: a
 * statement handed to the ingest service to parse, a Yahoo symbol search — seconds. Past 20 s it is
 * hung or a client that never reads its answer, and the warmer goes on.
 */
export const API_IN_FLIGHT_STALE_MS = 20_000;
/**
 * One wait never lasts longer than this: requests arriving back to back (each fresh, each followed
 * by another within the settle window) would otherwise hold the warmer for as long as they keep
 * coming. The warm is ahead-of-time work; a minute of yielding is plenty.
 */
export const API_IN_FLIGHT_MAX_WAIT_MS = 60_000;

/**
 * Requests that never hold the warmer back: the health check (the deploy agent and the host poll
 * it), the page-view beacon (sent once a page has settled, nobody waits for its answer) and the
 * machine traffic of the ingest service and the deploy agent (`/api/ingest/`, `/api/jobs/`:
 * heartbeats every minute, run reports, document applies — no person waits on those, and a write
 * among them makes the warmer rebuild afterwards anyway). The live-quotes stamp poll DOES count:
 * a changed stamp makes the client refetch every query one round trip later, and the settle window
 * after the stamp's answer is what keeps the warmer from starting a step under that burst.
 */
export function apiRequestCountsAsInFlight(path: string): boolean {
  if (!path.startsWith("/api/")) return false;
  if (path === "/api/health" || path === USAGE_PAGE_VIEW_PATH) return false;
  if (path.startsWith("/api/ingest/") || path.startsWith("/api/jobs/")) return false;
  return true;
}

const startedAt = new Map<number, number>();
let nextRequestId = 1;
let lastFinishedAt = Number.NEGATIVE_INFINITY;
const onRequestDone = new Set<() => void>();

const nowMs = (): number => performance.now();

function requestStarted(): () => void {
  const id = nextRequestId++;
  startedAt.set(id, nowMs());
  let done = false;
  return () => {
    // `close` follows `finish` on a completed response, and fires alone on an aborted one.
    if (done) return;
    done = true;
    startedAt.delete(id);
    lastFinishedAt = nowMs();
    for (const wake of [...onRequestDone]) wake();
  };
}

/** Counts each `/api` request from arrival until its response finishes or its connection closes. */
export function apiInFlightMiddleware(): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    if (apiRequestCountsAsInFlight(req.path)) {
      const done = requestStarted();
      res.on("finish", done);
      res.on("close", done);
    }
    next();
  };
}

/** Requests in flight, not counting those older than `staleMs`. */
export function inFlightApiRequests(staleMs: number = API_IN_FLIGHT_STALE_MS): number {
  const t = nowMs();
  let n = 0;
  for (const s of startedAt.values()) if (t - s < staleMs) n += 1;
  return n;
}

export type WhenNoApiRequestsInFlightOptions = {
  settleMs?: number;
  staleMs?: number;
  maxWaitMs?: number;
};

function waitForRequestDoneOr(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const wake = () => {
      clearTimeout(timer);
      onRequestDone.delete(wake);
      resolve();
    };
    const timer = setTimeout(wake, Math.max(0, ms));
    timer.unref?.();
    onRequestDone.add(wake);
  });
}

/**
 * Resolves once no (fresh) request is in flight and none finished within the settle window; at
 * once when nothing has been requested lately. Always yields one macrotask first, so a request
 * already queued on a socket is accepted and counted before the check.
 */
export async function whenNoApiRequestsInFlight(opts: WhenNoApiRequestsInFlightOptions = {}): Promise<void> {
  const settleMs = opts.settleMs ?? API_IN_FLIGHT_SETTLE_MS;
  const staleMs = opts.staleMs ?? API_IN_FLIGHT_STALE_MS;
  const maxWaitMs = opts.maxWaitMs ?? API_IN_FLIGHT_MAX_WAIT_MS;
  const begin = nowMs();
  await new Promise<void>((resolve) => setImmediate(resolve));
  for (;;) {
    const t = nowMs();
    const leftOfMax = begin + maxWaitMs - t;
    if (leftOfMax <= 0) return;
    let oldestFresh = Number.POSITIVE_INFINITY;
    for (const s of startedAt.values()) if (t - s < staleMs) oldestFresh = Math.min(oldestFresh, s);
    let wakeIn: number;
    if (oldestFresh === Number.POSITIVE_INFINITY) {
      const quietFor = t - lastFinishedAt;
      if (quietFor >= settleMs) return;
      wakeIn = settleMs - quietFor;
    } else {
      // Woken by a request finishing, or when the oldest one turns stale.
      wakeIn = oldestFresh + staleMs - t;
    }
    await waitForRequestDoneOr(Math.min(wakeIn, leftOfMax));
  }
}

/** Forgets every counted request (tests). */
export function resetApiRequestsInFlightForTest(): void {
  startedAt.clear();
  lastFinishedAt = Number.NEGATIVE_INFINITY;
  for (const wake of [...onRequestDone]) wake();
}
