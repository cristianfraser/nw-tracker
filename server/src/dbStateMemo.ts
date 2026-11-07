import { cacheDepNodeReadsLiveInput, newCacheDepNode, runInCacheDepNode } from "./cacheDependencies.js";
import { cacheEpoch, ensureCacheFresh } from "./cacheRegistry.js";
import { dbInTransaction } from "./db.js";
import { dbWriteCount } from "./dbWriteCounter.js";

/**
 * Memos of results that are a function of the database alone — an account's kind or ticker, the
 * nav tree — asked thousands of times per rebuild. An entry lives until this connection writes
 * anything (`dbWriteCount`), the change log reports another connection's write or the Chile day
 * turns (the cache registry's freshness check bumps its epoch, `cacheEpoch`). Inside a transaction
 * nothing is memoized: a rollback undoes writes without a new write to notice.
 *
 * A build may read no live input (a quote, the live dollar, or a gate deciding whether to read
 * one): it would survive the tick that moves it, so it throws. Results are shared between callers
 * and frozen, so a caller that mutates one fails instead of changing everyone's copy.
 */
const memos = new Map<string, Map<unknown, unknown>>();
let memoWriteCount = -1;
let memoEpoch = -1;

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
  if (dbInTransaction()) return build();
  ensureCacheFresh();
  const writes = dbWriteCount();
  if (writes !== memoWriteCount || cacheEpoch() !== memoEpoch) {
    memos.clear();
    memoWriteCount = writes;
    memoEpoch = cacheEpoch();
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
