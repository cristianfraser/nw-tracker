import { AsyncLocalStorage } from "node:async_hooks";
import type { TsUnit } from "./valuationTimeseries.js";

type CachedAccountValuationTs = {
  granularity: string;
  accounts: { points: Record<string, string | number | null>[] };
} | null;

const store = new AsyncLocalStorage<Map<string, CachedAccountValuationTs>>();

/** Dedupes {@link getAccountValuationTimeseries} within one group/dashboard build. */
export function withAccountValuationTsCache<T>(fn: () => T): T {
  if (store.getStore()) return fn();
  return store.run(new Map(), fn);
}

export function getAccountValuationTimeseriesForPerf(
  accountId: number,
  unit: TsUnit,
  fetch: () => CachedAccountValuationTs
): CachedAccountValuationTs {
  const cache = store.getStore();
  if (!cache) return fetch();
  const key = `${accountId}:${unit}`;
  if (!cache.has(key)) cache.set(key, fetch());
  return cache.get(key) ?? null;
}
