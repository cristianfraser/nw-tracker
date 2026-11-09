import { cacheDepNodeReadsLiveInput, newCacheDepNode, runInCacheDepNode } from "./cacheDependencies.js";
import { cacheEpoch, ensureCacheFresh } from "./cacheRegistry.js";
import { db, dbInTransaction, dbTransactionEpoch } from "./db.js";
import { dbWriteCount } from "./dbWriteCounter.js";

/**
 * Memos of results that are a function of the database alone — an account's kind or ticker, the
 * nav tree — asked thousands of times per rebuild. An entry lives until this connection writes
 * anything (`dbWriteCount`), the change log reports another connection's write or the Chile day
 * turns (the cache registry's freshness check bumps its epoch, `cacheEpoch`). Inside a transaction
 * the memo is the transaction's own (`txMemos`): an entry lives while the transaction does
 * (`dbTransactionEpoch` moves when one begins, ends or rolls back, so a rolled-back write can
 * never be served to the next transaction) and until the change log records a write of this
 * connection (`mark_input_changes`, which the triggers fill inside the transaction too). Before
 * 2026-11-09 nothing was memoized inside a transaction, and an ingest document that rebuilt the
 * expense lines reloaded the nav tree thousands of times — two minutes per hourly bank run.
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

const txMemos = new Map<string, Map<unknown, unknown>>();
let txMemoEpoch = -1;
let txMemoWriteCount = -1;
let txMemoChangeLogMax = -1;

function changeLogMaxId(): number {
  return (db.prepare(`SELECT COALESCE(MAX(id), 0) AS m FROM mark_input_changes`).get() as { m: number }).m;
}

/** The transaction's own memo map for `name`, dropped with the transaction or on a logged write. */
function transactionMemoMap(name: string): Map<unknown, unknown> {
  const epoch = dbTransactionEpoch();
  const writes = dbWriteCount();
  if (epoch !== txMemoEpoch) {
    txMemos.clear();
    txMemoEpoch = epoch;
    txMemoWriteCount = writes;
    txMemoChangeLogMax = changeLogMaxId();
  } else if (writes !== txMemoWriteCount) {
    // Something ran a writing statement: the change log says whether a logged table changed.
    const max = changeLogMaxId();
    if (max !== txMemoChangeLogMax) txMemos.clear();
    txMemoWriteCount = writes;
    txMemoChangeLogMax = max;
  }
  let map = txMemos.get(name);
  if (!map) {
    map = new Map();
    txMemos.set(name, map);
  }
  return map;
}

function buildChecked<V>(name: string, build: () => V): V {
  const node = newCacheDepNode();
  const value = runInCacheDepNode(node, build);
  if (cacheDepNodeReadsLiveInput(node)) {
    throw new Error(`dbStateMemo: ${name} read a live input; it may only read the database's stored state`);
  }
  return value;
}

export function dbStateMemo<K, V>(name: string, key: K, build: () => V): V {
  if (dbInTransaction()) {
    const map = transactionMemoMap(name);
    if (map.has(key)) return map.get(key) as V;
    const writes = dbWriteCount();
    const value = buildChecked(name, build);
    if (dbWriteCount() === writes) map.set(key, deepFreeze(value));
    return value;
  }
  if (txMemos.size > 0) txMemos.clear();
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
  const value = buildChecked(name, build);
  // A build that wrote (none should) would leave the entry keyed on a stale count: keep it out.
  if (dbWriteCount() !== writes) return value;
  map.set(key, deepFreeze(value));
  return value;
}
