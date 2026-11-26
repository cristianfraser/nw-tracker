import { getHeapStatistics } from "node:v8";
import { performance } from "node:perf_hooks";
import { ensureCacheFresh, setAggregationInvalidationListener } from "./cacheRegistry.js";
import { warmSlicer, whenNoApiRequestsInFlight } from "./apiRequestsInFlight.js";
import { chileCalendarAddDays, chileCalendarTodayYmd, dateAtTimeZoneWallClock } from "./chileDate.js";
import { serverConfig } from "./config.js";
import { ScheduledJob, nextAlignedMs } from "./schedulerKernel.js";
import { buildDashboardPageBundle } from "./dashboardPageBundle.js";
import { warmDashboardAccountRows } from "./dashboardAccounts.js";
import { buildFlowsOverviewPayload, cachedFlowsIncome } from "./flowsOverview.js";
import { warmFlowsExpenseLines } from "./flowsMortgageCarrying.js";
import { warmNetWorthAllTimeHigh } from "./netWorthAllTimeHigh.js";
import { getDashboardOverviewDaily } from "./dashboardOverviewDaily.js";
import { rentabilidadGroupSlugs, warmRentabilidadDailySeries } from "./rentabilidadDailyWarm.js";
import { groupDailyPctPoints } from "./dailyPctSeries.js";
import { warmVisitedPages, type VisitedWarmPlan } from "./visitedPagesWarm.js";
import { warmedDisplayUnits } from "./displayUnits.js";

/** The home net-worth chart's default Rango (3y) in days, as the client asks for it (timeRange.ts). */
const HOME_OVERVIEW_DEFAULT_DAYS = 1096;

/**
 * Proactive dashboard cache warmer: rebuilds the page-bundle aggregation caches, the pages the
 * usage log says are opened, most visited first (`visitedPagesWarm.ts`), then the full-history
 * daily series behind every Rentabilidad table (`rentabilidadDailyWarm.ts`), in the background so
 * interactive requests never pay a cold build.
 *
 * Triggers:
 * - server boot;
 * - just after Chile midnight (the aggregation cache clears on day rollover because entries
 *   bake in "today" — the warm build performs that clear + rebuild instead of the first
 *   morning request);
 * - debounced invalidations (panel edits, HTTP imports, market syncs, and another process's
 *   writes, which the change log reports — polled every minute so a CLI import is noticed without
 *   a request), so caches are warm again shortly after a write burst finishes.
 *
 * Not a live price change (2026-11-04): with Yahoo's stream a price moves every few seconds, and
 * rebuilding every page in both currencies each time built mostly what nobody was looking at.
 * A price change drops only the responses that read it (`cacheDependencies.ts`); the first
 * request that needs one rebuilds it on top of the cached history, and the stamp is published at
 * once (`liveQuotesStamp.ts`).
 *
 * Requests go first: each step starts only once no API request is in flight
 * (`apiRequestsInFlight.ts`). No step holds the event loop long (a host's health check must be
 * answered): the inputs of each payload are built first, each its own cached entry, with the loop
 * given back between them (`warmSlicer`), so the payload's own build finds them cached; a value
 * with no cached pieces is built in pieces through `warmAggregationInPieces` (`cacheRegistry.ts`).
 *
 * Env: `CACHE_WARM_ENABLED=0` disables (default on; `config.ts`).
 */

const BOOT_DELAY_MS = 2_000;
const INVALIDATION_DEBOUNCE_MS = 30_000;
const CHANGE_LOG_POLL_MS = 60_000;
/** Warm at 00:05 Chile — clear of midnight and of the 23:55 crypto-EOD sync window. */
const MIDNIGHT_WARM_MINUTE = 5;

let started = false;
let warming = false;
let rewarmQueued = false;
/** Delay for the queued rewarm: the shortest asked for while the warm ran. */
let rewarmQueuedDelayMs = INVALIDATION_DEBOUNCE_MS;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;

/** The V8 heap in use, in MB — the figure to read when a small instance dies of «heap out of memory». */
function heapMb(): number {
  return Math.round(process.memoryUsage().heapUsed / 1_048_576);
}

/** V8's heap limit for this process (`--max-old-space-size`, or what V8 chose from the machine's memory). */
function heapLimitMb(): number {
  return Math.round(getHeapStatistics().heap_size_limit / 1_048_576);
}

export type DashboardCacheWarmTimings = {
  dashboardMs: number;
  visitedPages: number;
  visitedMs: number;
  rentabilidadScopes: number;
  rentabilidadMs: number;
};

/**
 * One warm: the page bundles, the home chart's default series and the flows section in every
 * warmed unit, the visited pages, the Rentabilidad daily series. Every step waits until no API
 * request is in flight: a page being opened builds what it needs itself (each step is a cache
 * lookup, so the warm then finds it built) instead of queueing behind the rest of the warm.
 */
export async function runDashboardCacheWarmSteps(
  opts: { visitedPlan?: VisitedWarmPlan } = {}
): Promise<DashboardCacheWarmTimings> {
  await whenNoApiRequestsInFlight();
  const t0 = performance.now();
  const units = warmedDisplayUnits();
  for (const unit of units) {
    // The bundle's inputs first, each its own entry, so its build finds them cached: the account
    // rows step by step, the groups' daily returns the nav cards compound their period % from,
    // and the net worth's all-time high.
    await whenNoApiRequestsInFlight();
    await warmDashboardAccountRows(unit, warmSlicer());
    for (const slug of rentabilidadGroupSlugs()) await warmPiece(() => groupDailyPctPoints(slug, unit));
    await whenNoApiRequestsInFlight();
    await warmNetWorthAllTimeHigh(unit, warmSlicer());
    await warmPiece(() => buildDashboardPageBundle(unit));
  }
  // The net-worth chart's default view (Diario, Rango 3y = 1096 days): a first visit's chart
  // waits on it, and its first build takes seconds.
  for (const unit of units) await warmPiece(() => getDashboardOverviewDaily(unit, HOME_OVERVIEW_DEFAULT_DAYS));
  const tBundles = performance.now();
  // The home dashboard's flows section (Por cuota, month rows): its inputs first, the expense
  // lines in pieces.
  await warmFlowsExpenseLines(warmSlicer());
  await warmPiece(() => cachedFlowsIncome());
  for (const unit of units) await warmPiece(() => buildFlowsOverviewPayload(unit, "split", null));
  // The pages actually opened, most visited first (usage log).
  const tVisited = performance.now();
  const visitedPages = await warmVisitedPages(opts.visitedPlan);
  const tRentabilidad = performance.now();
  const rentabilidadScopes = await warmRentabilidadDailySeries();
  return {
    dashboardMs: tBundles - t0,
    visitedPages,
    visitedMs: tRentabilidad - tVisited,
    rentabilidadScopes,
    rentabilidadMs: performance.now() - tRentabilidad,
  };
}

/** One piece of the warm: once no API request is in flight (after one macrotask at least), `fn`. */
async function warmPiece<T>(fn: () => T): Promise<Awaited<T>> {
  await whenNoApiRequestsInFlight();
  return await fn();
}

async function runWarm(reason: string, delayMs = INVALIDATION_DEBOUNCE_MS): Promise<void> {
  if (warming) {
    rewarmQueued = true;
    rewarmQueuedDelayMs = Math.min(rewarmQueuedDelayMs, delayMs);
    return;
  }
  warming = true;
  try {
    const r = await runDashboardCacheWarmSteps();
    console.log(
      `cache-warm: dashboard caches warmed (${reason}) in ${r.dashboardMs.toFixed(0)}ms; ` +
        `${r.visitedPages} visited page(s) in ${r.visitedMs.toFixed(0)}ms; ` +
        `${r.rentabilidadScopes} Rentabilidad daily series in ${r.rentabilidadMs.toFixed(0)}ms; ` +
        `heap ${heapMb()} MB used of ${heapLimitMb()} MB`
    );
  } catch (e) {
    console.error(`cache-warm: failed (${reason}) — ${e instanceof Error ? e.message : e}`);
  } finally {
    warming = false;
    if (rewarmQueued) {
      rewarmQueued = false;
      const delay = rewarmQueuedDelayMs;
      rewarmQueuedDelayMs = INVALIDATION_DEBOUNCE_MS;
      scheduleWarm("rewarm-after-queued-invalidation", delay);
    }
  }
}

/** Debounced: repeated invalidations (e.g. a merge import) coalesce into one rebuild. */
function scheduleWarm(reason: string, delayMs = INVALIDATION_DEBOUNCE_MS): void {
  if (debounceTimer != null) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    void runWarm(reason, delayMs);
  }, delayMs);
  debounceTimer.unref?.();
}

/** The next 00:05 Chile, at least a minute ahead. */
function nextMidnightWarmAtMs(nowMs: number): number {
  const tomorrow = chileCalendarAddDays(chileCalendarTodayYmd(), 1);
  const at = dateAtTimeZoneWallClock(tomorrow, 0, MIDNIGHT_WARM_MINUTE, "America/Santiago");
  return Math.max(nowMs + 60_000, at.getTime());
}

const midnightJob = new ScheduledJob({
  name: "cache-warm:midnight",
  enabled: () => serverConfig().cacheWarm,
  next: nextMidnightWarmAtMs,
  run: async () => {
    await runWarm("chile-day-rollover");
    return "ok";
  },
});

/**
 * Another process wrote the DB (a CLI import): applying the change log drops what its writes
 * reached and notifies the listener below, which schedules the rebuild.
 */
const changeLogJob = new ScheduledJob({
  name: "cache-warm:change-log",
  enabled: () => serverConfig().cacheWarm,
  next: (nowMs) => nextAlignedMs(nowMs, CHANGE_LOG_POLL_MS),
  run: async () => {
    ensureCacheFresh();
    return "ok";
  },
});

export function startDashboardCacheWarmer(): void {
  if (!serverConfig().cacheWarm) {
    console.log("cache-warm: disabled (CACHE_WARM_ENABLED=0)");
    return;
  }
  if (started) return;
  started = true;

  setAggregationInvalidationListener((scope) => {
    // A live price change is rebuilt on demand (see the header).
    if (scope === "live_tail") return;
    scheduleWarm("invalidation");
  });
  midnightJob.start();
  changeLogJob.start();

  scheduleWarm("boot", BOOT_DELAY_MS);
}

