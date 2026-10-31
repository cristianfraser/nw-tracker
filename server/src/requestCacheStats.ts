import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Per-request count of aggregation-cache lookups, so the usage log can say whether a response
 * came from warm caches. A leaf module: `aggregationCache.ts` reports into it, the usage
 * middleware (`usageLog.ts`) opens one store per request. Lookups outside a request (the
 * cache warmer, schedulers) have no store and are not counted.
 */
export type RequestCacheStats = { hits: number; misses: number };

const storage = new AsyncLocalStorage<RequestCacheStats>();

export function runWithRequestCacheStats<T>(stats: RequestCacheStats, fn: () => T): T {
  return storage.run(stats, fn);
}

export function noteAggregationCacheLookup(hit: boolean): void {
  const stats = storage.getStore();
  if (!stats) return;
  if (hit) stats.hits += 1;
  else stats.misses += 1;
}

/** warm = every lookup hit; cold = at least one miss; none = the request made no lookup. */
export function requestCacheOutcome(stats: RequestCacheStats): "warm" | "cold" | "none" {
  if (stats.misses > 0) return "cold";
  return stats.hits > 0 ? "warm" : "none";
}
