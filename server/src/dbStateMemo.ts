import { cacheDepNodeReadsLiveInput, newCacheDepNode, runInCacheDepNode } from "./cacheDependencies.js";
import { dbInTransaction } from "./db.js";
import { dbWriteCount } from "./dbWriteCounter.js";

/**
 * Memos of results that are a function of the database alone — an account's kind or ticker, the
 * nav tree — asked thousands of times per rebuild. An entry lives until this connection writes
 * anything (`dbWriteCount`), another connection commits or the Chile day turns (the aggregation
 * cache's freshness check, which clears these with its own entries). Inside a transaction
 * nothing is memoized: a rollback undoes writes without a new write to notice.
 *
 * A build may read no live input (a quote, the live dollar, or a gate deciding whether to read
 * one): it would survive the tick that moves it, so it throws. Results are shared between callers
 * and frozen, so a caller that mutates one fails instead of changing everyone's copy.
 */
const memos = new Map<string, Map<unknown, unknown>>();
let memoWriteCount = -1;
let freshnessCheck: (() => void) | null = null;

/** Set once by aggregationCache.ts: runs its freshness check (which clears these on a change). */
export function setDbStateMemoFreshnessCheck(check: () => void): void {
  freshnessCheck = check;
}

export function clearDbStateMemos(): void {
  memos.clear();
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  if (value instanceof Map || value instanceof Set) {
    for (const v of value.values()) deepFreeze(v);
    if (value instanceof Map) for (const k of value.keys()) deepFreeze(k);
  } else {
    for (const v of Object.values(value as object)) deepFreeze(v);
  }
  return Object.freeze(value);
}

export function dbStateMemo<K, V>(name: string, key: K, build: () => V): V {
  if (freshnessCheck == null || dbInTransaction()) return build();
  freshnessCheck();
  const writes = dbWriteCount();
  if (writes !== memoWriteCount) {
    memos.clear();
    memoWriteCount = writes;
  }
  let map = memos.get(name);
  if (!map) {
    map = new Map();
    memos.set(name, map);
  }
  if (map.has(key)) return map.get(key) as V;
  const node = newCacheDepNode();
  const value = runInCacheDepNode(node, build);
  if (cacheDepNodeReadsLiveInput(node)) {
    throw new Error(`dbStateMemo: ${name} read a live input; it may only read the database's stored state`);
  }
  // A build that wrote (none should) would leave the entry keyed on a stale count: keep it out.
  if (dbWriteCount() !== writes) return value;
  map.set(key, deepFreeze(value));
  return value;
}
