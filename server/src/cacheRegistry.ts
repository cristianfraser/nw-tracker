import { markJsonResponseCacheable } from "./jsonResponse.js";
import { noteAggregationCacheLookup } from "./requestCacheStats.js";
import {
  cacheDepNodeAffected,
  cacheDepNodeLiveInputs,
  cacheDepNodeReadsLiveInput,
  linkCacheDepNode,
  newCacheDepNode,
  runInCacheDepNode,
  type CacheDepNode,
  type LiveQuoteMoves,
} from "./cacheDependencies.js";
import {
  CACHE_FAMILIES,
  EXPENSE_METADATA_TABLES,
  HISTORY_TIER_PREFIX,
  type CacheFamily,
  type CacheFamilyName,
} from "./cacheFamilies.js";
import { chileCalendarTodayYmd } from "./chileDate.js";
import { dbWriteCount } from "./dbWriteCounter.js";
import { db, dbInTransaction } from "./db.js";
import { noteLiveQuotesChanged } from "./liveQuotesStamp.js";
import { applyChangeLog, endTransactionChanges, type ChangeLogSummary } from "./markInputChanges.js";
import { clearMarkSeries } from "./markSeriesStore.js";

/**
 * The cache registry (docs/untangle-plan.md F2): one store for every cached aggregation and API
 * payload, each key belonging to a family declared in `cacheFamilies.ts`, and one walk over that
 * table for every invalidation. It imports no domain module: domain modules build their keys from
 * `cacheFamilies.ts` and call {@link getAggregationCached}.
 *
 * The write signal is the change log (`markInputChanges.ts`): triggers in whichever connection
 * wrote name the table, and for a mark input the account and the date. The log is applied before
 * any cached read (when this connection wrote, or `data_version` says another one did), after
 * every API write (`index.ts`) and by the warmer's minute poll; each applied change drops the
 * families that read what changed and notifies the warmer. Market writers of this process add
 * their own notices ({@link invalidateMarketDataAggregations}), and the live-quote poll publishes
 * its moves through {@link publishLiveInputChange}.
 */

type Entry = {
  value: unknown;
  family: CacheFamilyName;
  /** The account an account-scoped family's key names. */
  accountId: number | null;
  /** The live inputs the build read (none for an untracked family). */
  node: CacheDepNode | null;
  /** Built inside a transaction: it may hold rows a rollback takes back (dropped when it ends). */
  builtInTransaction: boolean;
};

const cache = new Map<string, Entry>();

const FAMILIES_LONGEST_PREFIX_FIRST = (Object.entries(CACHE_FAMILIES) as [CacheFamilyName, CacheFamily][]).sort(
  (a, b) => b[1].prefix.length - a[1].prefix.length
);

function familyOfKey(key: string): [CacheFamilyName, CacheFamily] {
  for (const entry of FAMILIES_LONGEST_PREFIX_FIRST) if (key.startsWith(entry[1].prefix)) return entry;
  throw new Error(`cache: key ${key} belongs to no registered family (cacheFamilies.ts)`);
}

function accountIdOfKey(key: string, family: CacheFamily): number | null {
  if (!family.accountScoped) return null;
  const m = /^(\d+)(?:\||$)/.exec(key.slice(family.prefix.length));
  if (!m) throw new Error(`cache: account-scoped key ${key} names no account after ${family.prefix}`);
  return Number(m[1]);
}

/**
 * Chile calendar day the cached entries were built for. Aggregations bake in "today" (live
 * current-month perf row, appended today chart point, current-month cierre), so a long-running
 * process drops them at calendar rollover.
 */
let cacheDayYmd: string | null = null;

// Prepared once: every cached read checks it, and `db.pragma()` prepares a statement per call.
let dataVersionStmt: import("better-sqlite3").Statement<[], number> | null = null;

/**
 * SQLite `PRAGMA data_version` increments when *another connection* commits a write (a CLI import
 * running in its own process): the cross-process signal that the change log has rows to apply.
 */
function currentDbDataVersion(): number {
  dataVersionStmt ??= db.prepare<[], number>("PRAGMA data_version").pluck();
  return dataVersionStmt.get()!;
}

/**
 * The freshness check costs a statement or two, and one rebuild looks things up thousands of
 * times. Within one synchronous stretch (until the next microtask) it runs once, again only after
 * this connection wrote. Another connection's commit inside that stretch is seen at the next one,
 * as it would be had it landed a moment later.
 */
let checkedInStretch = false;
let checkedAtWriteCount = -1;
let appliedAtWriteCount = -1;
let appliedAtDataVersion: number | null = null;

/**
 * Bumped whenever the database may hold something a memo did not see (an applied change, a day
 * rollover, a full clear): `dbStateMemo.ts` clears its memos when it changes.
 */
let epoch = 0;

export function cacheEpoch(): number {
  return epoch;
}

/** Whether a lookup happened inside a transaction that has not been seen to end yet. */
let transactionSeen = false;

/**
 * A transaction that cached lookups saw has ended: drop what was built inside it (it may hold rows a
 * rollback took back) and replay the mark trims its rows caused (`endTransactionChanges`).
 */
function noteTransactionState(): void {
  if (mutedSavepoints > 0) return;
  if (dbInTransaction()) {
    transactionSeen = true;
    return;
  }
  if (transactionSeen) {
    transactionSeen = false;
    endTransactionChanges();
    dropWhere((entry) => entry.builtInTransaction);
  }
}

/**
 * Inside {@link withChangeLogMuted}: a savepoint whose writes are either rolled back or kept whole,
 * and leave what is read inside it valid either way (`rederivation.ts`).
 */
let mutedSavepoints = 0;
let mutedOuterTransaction = false;

/**
 * Run `fn` without applying the change log or treating its savepoint as a transaction: the caller
 * guarantees that what is read inside it is what the database holds after it, whether the
 * savepoint is rolled back (nothing changed) or released (its rows are applied by the next lookup).
 */
export function withChangeLogMuted<T>(fn: () => T): T {
  if (mutedSavepoints === 0) mutedOuterTransaction = dbInTransaction();
  mutedSavepoints += 1;
  try {
    return fn();
  } finally {
    mutedSavepoints -= 1;
  }
}

function lookupInTransaction(): boolean {
  return mutedSavepoints > 0 ? mutedOuterTransaction : dbInTransaction();
}

/** Drop what the day rollover and any change the log reports have made stale; run before every cached read. */
export function ensureCacheFresh(): void {
  noteTransactionState();
  const today = chileCalendarTodayYmd();
  const writeCount = dbWriteCount();
  if (checkedInStretch && writeCount === checkedAtWriteCount && cacheDayYmd === today) return;
  if (!checkedInStretch) {
    checkedInStretch = true;
    queueMicrotask(() => {
      checkedInStretch = false;
    });
  }
  checkedAtWriteCount = -1;
  if (cacheDayYmd !== today) {
    dropForDayRollover(cacheDayYmd);
    cacheDayYmd = today;
  }
  const dataVersion = currentDbDataVersion();
  if (mutedSavepoints === 0 && (writeCount !== appliedAtWriteCount || dataVersion !== appliedAtDataVersion)) {
    const summary = applyChangeLog(today);
    appliedAtWriteCount = dbWriteCount();
    appliedAtDataVersion = dataVersion;
    if (summary) dropForChanges(summary);
  }
  checkedAtWriteCount = dbWriteCount();
}

function dropAllButMarkSeries(): void {
  cache.clear();
  liveTier.maps.clear();
  declaredInputs.clear();
  epoch += 1;
}

/**
 * The Chile day changed: everything that bakes in «today» goes. Nothing dated before the day that
 * just ended changed with it, so a history memo with a trim rule keeps its entries, trimmed from
 * that day (it was «today» while they were built: nothing of it may be in them, and a rule that
 * bakes in the build day drops from it). The first rollover of a process has no ended day and
 * nothing cached.
 */
function dropForDayRollover(endedDay: string | null): void {
  if (endedDay == null) return dropAllButMarkSeries();
  for (const [key, entry] of cache) {
    const policy = entry.family === "history" ? historyTierPolicies.get(key) : undefined;
    if (!policy) cache.delete(key);
    else policy.trim(entry.value as Map<unknown, unknown>, endedDay, "rollover");
  }
  liveTier.maps.clear();
  declaredInputs.clear();
  epoch += 1;
}

/**
 * How a history memo answers a change (`historyTierMemo`'s second argument). A memo with no
 * policy is dropped whole by every change, which is always right.
 *
 * `trim(map, from, why)` removes every entry that evidence dated `from` or later can change and
 * keeps the rest. `from` is an ISO day (`0000-01-01` = the whole history): for `"change"` the
 * earliest day the applied change-log rows reach, their tables' reach rules applied
 * (`markInputChanges.ts`); for `"rollover"` the Chile day that just ended. A rule must be right
 * for both: an entry is kept only when nothing dated `from` or later is in it.
 *
 * `readsUndatedState`: the value also depends on something no dated row holds (sync state, a
 * setting): it is dropped whole by a market-data notice, which covers what no table holds.
 */
export type HistoryTierPolicy<K, V> = {
  trim: (map: Map<K, V>, from: string, why: "change" | "rollover") => void;
  readsUndatedState?: boolean;
};

const historyTierPolicies = new Map<string, HistoryTierPolicy<unknown, unknown>>();

/**
 * The rule of a memo whose every entry is one day's figure, computed from evidence dated on or
 * before that day: an entry goes when its day is `from` or later. `widenDays` drops that many
 * earlier days too, for a figure that can read evidence dated after its own day (a card's dollar
 * lines valued at a later pay-by rate).
 */
export function historyTrimByDay<K, V>(dayOf: (key: K, value: V) => string, widenDays = 0): HistoryTierPolicy<K, V> {
  return {
    trim(map, from) {
      const cutoff = widenDays > 0 && from > "0001-01-01" ? isoDayMinus(from, widenDays) : from;
      for (const [key, value] of map) if (dayOf(key, value) >= cutoff) map.delete(key);
    },
  };
}

function isoDayMinus(ymd: string, days: number): string {
  return new Date(Date.parse(`${ymd}T00:00:00Z`) - days * 86_400_000).toISOString().slice(0, 10);
}

/** Trim the history memos that have a rule from `from`; drop the others. */
function trimHistoryTier(from: string): void {
  for (const [key, entry] of cache) {
    if (entry.family !== "history") continue;
    const policy = historyTierPolicies.get(key);
    if (!policy) cache.delete(key);
    else policy.trim(entry.value as Map<unknown, unknown>, from, "change");
  }
}

function dropWhere(drop: (entry: Entry, family: CacheFamily, key: string) => boolean): void {
  for (const [key, entry] of cache) {
    if (drop(entry, CACHE_FAMILIES[entry.family]!, key)) cache.delete(key);
  }
}

/** What the change log reported: drop the families that read it, then tell the warmer. */
function dropForChanges(s: ChangeLogSummary): void {
  liveTier.maps.clear();
  epoch += 1;
  const accounts = new Set(s.markAccountIds);
  let writesAny = s.writtenTables.size > 0;
  let writesValuation = false;
  for (const t of s.writtenTables) if (!EXPENSE_METADATA_TABLES.has(t)) writesValuation = true;
  // Dated mark rows alone: the history tier is trimmed from the earliest day they reach. A write
  // row of a valuation table names no date, so it still drops the tier whole.
  const trimHistory = !writesValuation && s.markFrom != null;
  if (trimHistory) trimHistoryTier(s.markFrom!);
  if (s.marksAll) writesAny = writesValuation = true;
  dropWhere((entry, family) => {
    if (trimHistory && entry.family === "history") return false;
    if (family.reads === "any" ? writesAny : writesValuation) return true;
    if (accounts.size === 0) return false;
    return !family.accountScoped || accounts.has(entry.accountId!);
  });
  invalidationListener?.();
}

/**
 * Notified after every invalidation that drops what a rebuild should restore (an applied change,
 * a market-data notice, a full clear). The dashboard cache warmer registers here (from its start,
 * at boot) to schedule a debounced background rebuild; `scope` is set for market-data notices
 * (`"live_tail"` = a live-quote poll moved a price).
 */
let invalidationListener: ((scope?: MarketDataInvalidationScope) => void) | null = null;

export function setAggregationInvalidationListener(
  listener: ((scope?: MarketDataInvalidationScope) => void) | null
): void {
  invalidationListener = listener;
}

/** Drop everything cached, the per-account mark series included (a full rebuild follows). */
export function clearAggregationCache(): void {
  dropAllButMarkSeries();
  clearMarkSeries();
  invalidationListener?.();
}

/**
 * The cached value under `key`, built by `build` on a miss. The key's family decides the rest:
 * inside a transaction a `bypassInTransaction` family builds without caching; the build runs in
 * its own dependency node (the live inputs it reads, `cacheDependencies.ts`) unless the family is
 * untracked; a `response` family's value is marked for one-time serialization; a promise that
 * rejects evicts its own entry, so the next lookup retries instead of replaying the error. A
 * build that throws caches nothing.
 */
export function getAggregationCached<T>(key: string, build: () => T): T {
  const [name, family] = familyOfKey(key);
  if (family.bypassInTransaction && lookupInTransaction()) return build();
  ensureCacheFresh();
  const hit = cache.get(key);
  if (hit) {
    noteAggregationCacheLookup(true);
    if (hit.node) linkCacheDepNode(hit.node);
    return hit.value as T;
  }
  noteAggregationCacheLookup(false);
  const node = family.untracked ? null : newCacheDepNode();
  let value: unknown = node ? runInCacheDepNode(node, build) : build();
  if (value instanceof Promise) {
    const promise = family.response ? value.then(markJsonResponseCacheable) : value;
    promise.then(undefined, () => {
      if (cache.get(key)?.value === promise) cache.delete(key);
    });
    value = promise;
  } else if (family.response) {
    value = markJsonResponseCacheable(value);
  }
  cache.set(key, {
    value,
    family: name,
    accountId: accountIdOfKey(key, family),
    node,
    builtInTransaction: lookupInTransaction(),
  });
  if (node) linkCacheDepNode(node);
  return value as T;
}

/**
 * A named memo map in the history tier: results computed only from evidence dated strictly before
 * Chile today — a historical mark, an account's deposit events, an fx row on a past date. A
 * live-quote tick moves nothing such a result reads (no historical reader reads
 * `live_market_quotes`), so this tier survives it and the rebuild after a tick recomputes only
 * today's marks and the current-month rows on top of it. Every other invalidation drops it.
 *
 * An entry may only depend on the database's rows (whose writes the change log reports); never on
 * a live quote, the live fx row, or the wall clock beyond the Chile day. Inside a transaction it
 * is a throwaway map: a report-only import reads rows it then rolls back.
 */
export function historyTierMemo<K, V>(name: string, policy?: HistoryTierPolicy<K, V>): Map<K, V> {
  const key = `${HISTORY_TIER_PREFIX}${name}`;
  if (policy && !historyTierPolicies.has(key)) historyTierPolicies.set(key, policy as unknown as HistoryTierPolicy<unknown, unknown>);
  return getAggregationCached(key, () => new Map<K, V>());
}

/**
 * Run `build` for a history-tier entry, enforcing the tier's contract: it must read no live input
 * (a live quote, the live dollar, or a gate deciding whether to read one). Throws when it did — a
 * history-tier result that read a live price would survive the tick that moves it.
 */
export function buildHistoryTierValue<T>(what: string, build: () => T): T {
  const node = newCacheDepNode();
  const value = runInCacheDepNode(node, build);
  if (cacheDepNodeReadsLiveInput(node)) {
    const read = cacheDepNodeLiveInputs(node);
    const named = [...read.tickers, ...[...read.fx].map((p) => `fx ${p}`), ...(read.syncDimming ? ["sync dimming"] : [])];
    throw new Error(
      `history tier: ${what} read a live input (${named.join(", ")}); it may only read evidence dated before today`
    );
  }
  return value;
}

/**
 * The live tier: memos of today's live figures (an account's today value) for the rest of the
 * current UTC minute, so one rebuild asks each account once instead of once per reader. Dropped
 * by every invalidation (a live-quote tick only where it read a moved price) and when the minute
 * turns. Inside a transaction nothing is memoized.
 */
type LiveTierEntry = { value: unknown; node: CacheDepNode };
let liveTier: { minute: number; maps: Map<string, Map<unknown, LiveTierEntry>> } = { minute: -1, maps: new Map() };

/**
 * `build()` memoized in the live tier under (`name`, `key`). The entry keeps the live inputs its
 * build read and passes them on to whatever is built around a later hit, like a cache entry.
 */
export function liveTierCached<K, V>(name: string, key: K, build: () => V): V {
  if (dbInTransaction()) return build();
  ensureCacheFresh();
  const minute = Math.floor(Date.now() / 60_000);
  if (liveTier.minute !== minute) liveTier = { minute, maps: new Map() };
  let map = liveTier.maps.get(name);
  if (!map) {
    map = new Map();
    liveTier.maps.set(name, map);
  }
  const hit = map.get(key);
  if (hit) {
    linkCacheDepNode(hit.node);
    return hit.value as V;
  }
  const node = newCacheDepNode();
  const value = runInCacheDepNode(node, build);
  map.set(key, { value, node });
  linkCacheDepNode(node);
  return value;
}

/**
 * Inputs a family reads that no table holds (`dropFamiliesWhenInputChanged`): the last value seen
 * per family set and input name.
 */
const declaredInputs = new Map<string, string>();

/**
 * A value `families` read that no table write reports (the live dollar rate the expense lines
 * priced unpaid dollars at): when it differs from the one seen last, the families are dropped.
 * Called by the reader before it reads them.
 */
export function dropFamiliesWhenInputChanged(families: readonly CacheFamilyName[], input: string, value: string): void {
  ensureCacheFresh();
  const id = `${families.join(",")}|${input}`;
  const prev = declaredInputs.get(id);
  declaredInputs.set(id, value);
  if (prev === undefined || prev === value) return;
  const names = new Set(families);
  dropWhere((entry) => names.has(entry.family));
}

/**
 * What a market-data notice from this process covers, which decides whether the history tier and
 * the mark series survive it:
 * - `historical` (default): rows dated in the past — EOD closes, fx/UF, fund units, or a state
 *   no table holds (the global sync's Fintual state). Every mark from that date forward can move.
 * - `live_tail`: `live_market_quotes` only, which no historical mark reads. The mark series and the
 *   history tier stay; today's mark is recomputed on the next read because it is never cached.
 *
 * Unknown callers get the conservative default — only pass `live_tail` from the live-quotes poll
 * (through {@link publishLiveInputChange}), whose writes are confined to that table.
 */
export type MarketDataInvalidationScope = "historical" | "live_tail";

/**
 * Market-data writes from this process carry no account/date and may write no logged table: drop
 * the families that read market data (`historicalMarket`, or for a live tick the `liveTick:
 * "affected"` entries — those that read a moved price when `moves` says what moved) and notify the
 * warmer.
 */
export function invalidateMarketDataAggregations(
  scope: MarketDataInvalidationScope = "historical",
  moves?: LiveQuoteMoves
): void {
  if (scope === "live_tail" && moves) {
    dropLiveTickAffected(moves);
    invalidationListener?.(scope);
    return;
  }
  liveTier.maps.clear();
  if (scope === "historical") {
    // The rows the sync wrote are in the log too: apply them first (marks trimmed from their dates).
    ensureCacheFresh();
    // A history memo with a trim rule was already trimmed from the rows' dates; it goes whole only
    // when it reads state no row holds.
    dropWhere((entry, family, key) => {
      if (entry.family !== "history") return family.historicalMarket;
      const policy = historyTierPolicies.get(key);
      return !policy || policy.readsUndatedState === true;
    });
  } else {
    dropWhere((_entry, family) => family.liveTick === "affected");
  }
  invalidationListener?.(scope);
}

/**
 * A live-quote poll moved `moves`: drop, among the `liveTick: "affected"` entries, those that read
 * a moved price or whose inputs are unknown, and the live-tier memos that read one. Everything
 * else stays; what is dropped rebuilds on top of the history tier.
 */
function dropLiveTickAffected(moves: LiveQuoteMoves): void {
  const memo = new Map<CacheDepNode, boolean>();
  for (const map of liveTier.maps.values()) {
    for (const [k, entry] of [...map]) {
      if (cacheDepNodeAffected(entry.node, moves, memo)) map.delete(k);
    }
  }
  dropWhere(
    (entry, family) => family.liveTick === "affected" && (!entry.node || cacheDepNodeAffected(entry.node, moves, memo))
  );
}

/** What moved, as the client's stamp and the live-tick drop both need it. */
export type LiveInputChange =
  | { all: true }
  | { tickers: readonly string[]; fx: readonly string[] }
  | { dimming: true };

/**
 * A live input moved at `at` (ISO): publish it for the client's stamp (`liveQuotesStamp.ts`) and
 * drop what read it. `all`: the move cannot be scoped (the day's `fx_daily` close was written).
 */
export function publishLiveInputChange(at: string, change: LiveInputChange): void {
  if ("all" in change) {
    noteLiveQuotesChanged(at, { all: true });
    invalidateMarketDataAggregations("live_tail");
  } else if ("dimming" in change) {
    noteLiveQuotesChanged(at, { dimming: true });
    invalidateMarketDataAggregations("live_tail", { tickers: new Set(), fx: new Set(), syncDimming: true });
  } else {
    const tickers = change.tickers.map((t) => t.toUpperCase());
    noteLiveQuotesChanged(at, { tickers, fx: change.fx });
    invalidateMarketDataAggregations("live_tail", { tickers: new Set(tickers), fx: new Set(change.fx) });
  }
}

/** @internal Test hook: whether `key` is cached (after applying what the log reports). */
export function aggregationCacheHasForTest(key: string): boolean {
  ensureCacheFresh();
  return cache.has(key);
}

/** @internal Test hook: every cached key (after applying what the log reports). */
/** Entries held across every history memo (tests: what a trim kept). */
export function historyTierEntryCountForTest(): number {
  let n = 0;
  for (const entry of cache.values()) if (entry.family === "history") n += (entry.value as Map<unknown, unknown>).size;
  return n;
}

export function aggregationCacheKeysForTest(): string[] {
  ensureCacheFresh();
  return [...cache.keys()];
}

/** @internal Test hook: the family a key belongs to. */
export function cacheFamilyOfKeyForTest(key: string): CacheFamilyName {
  return familyOfKey(key)[0];
}
