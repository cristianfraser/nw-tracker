import { clearCheckingBalanceCache } from "./checkingCartolaBalances.js";
import { markJsonResponseCacheable } from "./jsonResponse.js";
import { noteAggregationCacheLookup } from "./requestCacheStats.js";
import {
  cacheDepNodeAffected,
  linkCacheDepNode,
  newCacheDepNode,
  runInCacheDepNode,
  type CacheDepNode,
  type LiveQuoteMoves,
} from "./cacheDependencies.js";
import { monthKeyFromYmd } from "./calendarMonth.js";
import { chileCalendarTodayYmd } from "./chileDate.js";
import { applyPendingMarkInputChanges, setMarkInputsChangedListener } from "./markInputChanges.js";
import { clearMarkSeries } from "./markSeriesStore.js";
import { getCreditCardGroupBySlug, listCreditCardGroupMasterAccountIds } from "./creditCardTree.js";
import { CC_ISSUER_SLUGS } from "./ccIssuers.js";
import { db, dbInTransaction } from "./db.js";
import { buildPortfolioGroupIndex } from "./portfolioGroupIndex.js";
import type { TsUnit } from "./valuationTimeseries.js";

const cache = new Map<string, unknown>();
/**
 * The live inputs each entry read while it was built (`cacheDependencies.ts`), so a live-quote
 * tick drops only the entries that read a price it moved. Overwritten on every rebuild; a stale
 * node of a deleted key is never consulted (lookups go through `cache` first).
 */
const depNodes = new Map<string, CacheDepNode>();

let rollupSlugsByAccountId: Map<number, Set<string>> | null = null;

/**
 * Chile calendar day the cached entries were built for. Aggregations bake in "today"
 * (live current-month perf row, appended today chart point, current-month cierre), so a
 * long-running process must drop them at calendar rollover — otherwise a server that built
 * the dashboard on June 30 keeps serving June-current consolidations after midnight, and the
 * new month shows zeros / missing rows until restart.
 */
let cacheDayYmd: string | null = null;

/**
 * SQLite `PRAGMA data_version` increments when *another connection* commits a write —
 * exactly the case the in-process invalidation hooks can't see (CLI import scripts run in
 * their own process against the same file). Same-connection writes don't bump it; those
 * paths call `invalidateAggregationForAccountDate` explicitly.
 */
let cacheDbDataVersion: number | null = null;

// Prepared once: every cached read checks it, and `db.pragma()` prepares a statement per call.
let dataVersionStmt: import("better-sqlite3").Statement<[], number> | null = null;

function currentDbDataVersion(): number {
  dataVersionStmt ??= db.prepare<[], number>("PRAGMA data_version").pluck();
  return dataVersionStmt.get()!;
}

function ensureCacheFreshForChileDay(): void {
  // Marks a write moved (any connection — the database logs it) are trimmed, and the daily
  // aggregations built on them dropped through the listener below, before anything is served.
  applyPendingMarkInputChanges();
  const today = chileCalendarTodayYmd();
  const dataVersion = currentDbDataVersion();
  if (cacheDayYmd !== today || cacheDbDataVersion !== dataVersion) {
    cache.clear();
    depNodes.clear();
    invalidateLiveTier();
    rollupSlugsByAccountId = null;
    cacheDayYmd = today;
    cacheDbDataVersion = dataVersion;
  }
}

function deleteKeysMatchingPrefix(prefix: string): void {
  for (const key of [...cache.keys()]) {
    if (key.startsWith(prefix)) cache.delete(key);
  }
}

/**
 * Notified after every explicit invalidation (writes). The dashboard cache warmer registers
 * here to schedule a debounced background rebuild; day-rollover / data_version clears are
 * detected by the warmer's own timers instead (they happen lazily inside reads).
 */
let invalidationListener: ((scope?: MarketDataInvalidationScope) => void) | null = null;

/**
 * Called after every invalidation; `scope` is set for market-data invalidations
 * (`"live_tail"` = a live-quote poll moved a price).
 */
export function setAggregationInvalidationListener(
  listener: ((scope?: MarketDataInvalidationScope) => void) | null
): void {
  invalidationListener = listener;
}

/** Drop everything cached, the per-account mark series included (a full rebuild follows). */
export function clearAggregationCache(): void {
  cache.clear();
  depNodes.clear();
  invalidateLiveTier();
  clearMarkSeries();
  rollupSlugsByAccountId = null;
  invalidationListener?.();
}

/**
 * The history tier: memos of results computed only from evidence dated strictly before Chile
 * today — a historical mark, an account's deposit events, an fx row on a past date. A live-quote
 * tick (`live_tail`) moves nothing such a result reads (no historical reader reads
 * `live_market_quotes`, see {@link invalidateDailyAggregates}), so this tier survives it and the
 * rebuild after a tick recomputes only today's marks and the current-month rows on top of it.
 * Every other invalidation drops the whole tier — writes (directly, or through the mark-input
 * log of any connection), historical market data, the day rollover, a `data_version` change —
 * so outside a live tick it behaves exactly like the rest of the cache.
 *
 * An entry may only depend on rows of the mark-input tables (`markInputChanges.ts`, whose log
 * drops the tier whichever connection wrote) or on rows its invalidation funnel covers; never on
 * a live quote, the live fx row, or the wall clock beyond the Chile day.
 */
const HISTORY_TIER_PREFIX = "hist.";

/**
 * A named memo map in the history tier (created empty on first use after a drop). Inside a
 * transaction it is a throwaway map: a report-only import reads rows it then rolls back.
 */
export function historyTierMemo<K, V>(name: string): Map<K, V> {
  if (dbInTransaction()) return new Map<K, V>();
  return getAggregationCached(`${HISTORY_TIER_PREFIX}${name}`, () => new Map<K, V>());
}

function invalidateHistoryTier(): void {
  deleteKeysMatchingPrefix(HISTORY_TIER_PREFIX);
}

/**
 * The live tier: memos of today's live figures (an account's today value) for the rest of the
 * current UTC minute, so one rebuild asks each account once instead of once per reader. Dropped
 * by every invalidation (a live-quote tick only where it read a moved price) and when the minute
 * turns, so a figure is never older than the clock reading a fresh computation would make, give
 * or take a minute. Inside a transaction nothing is memoized, like the history tier.
 */
type LiveTierEntry = { value: unknown; node: CacheDepNode };
let liveTier: { minute: number; maps: Map<string, Map<unknown, LiveTierEntry>> } = { minute: -1, maps: new Map() };

/**
 * `build()` memoized in the live tier under (`name`, `key`). The entry keeps the live inputs its
 * build read and passes them on to whatever is built around a later hit, like a cache entry.
 */
export function liveTierCached<K, V>(name: string, key: K, build: () => V): V {
  if (dbInTransaction()) return build();
  ensureCacheFreshForChileDay();
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

function invalidateLiveTier(): void {
  liveTier.maps.clear();
}

export function getAggregationCached<T>(key: string, build: () => T): T {
  ensureCacheFreshForChileDay();
  // History-tier maps read no live input by contract (and are asked very often): no node.
  const tracked = !key.startsWith(HISTORY_TIER_PREFIX);
  if (cache.has(key)) {
    noteAggregationCacheLookup(true);
    if (tracked) {
      const node = depNodes.get(key);
      if (node) linkCacheDepNode(node);
    }
    return cache.get(key) as T;
  }
  noteAggregationCacheLookup(false);
  if (!tracked) {
    const value = build();
    cache.set(key, value);
    return value;
  }
  const node = newCacheDepNode();
  const value = runInCacheDepNode(node, build);
  cache.set(key, value);
  depNodes.set(key, node);
  linkCacheDepNode(node);
  return value;
}

/**
 * Overwrite a cached entry. Only for read-modify-write caches — entries a reader **extends**
 * rather than rebuilds (`accountMarkDailyCache.ts` grows one account's mark series when a
 * later request asks for a wider date range). Everything else builds once and must use
 * {@link getAggregationCached}, whose miss-path build is the single writer.
 */
export function setAggregationCached<T>(key: string, value: T): void {
  ensureCacheFreshForChileDay();
  cache.set(key, value);
  // Inputs unknown: a scoped live tick treats the entry as affected.
  depNodes.delete(key);
}

export function cacheKeyAccountMonthlyPerf(accountId: number, unit: TsUnit): string {
  return `account.monthly_perf|${accountId}|${unit}`;
}

export function cacheKeyGroupConsolidatedMonthly(groupSlug: string, unit: TsUnit): string {
  return `group.consolidated_monthly|${groupSlug}|${unit}`;
}

export function cacheKeyGroupClosingByDate(slug: string, unit: TsUnit): string {
  return `group.valuation_closing_by_date|${slug}|${unit}`;
}

export function cacheKeyCcBillingDetail(accountId: number): string {
  return `cc.billing_detail|${accountId}`;
}

/**
 * Card ledger payloads (`creditCardInstallmentsResponse`, `creditCardGroupLedgerResponse`). They
 * merge cards, read card config, labels and plan edits as well as the billing detail, so any
 * card write, any API write and any historical market data drop them all
 * ({@link invalidateCcLedgerResponses}); a live tick only where they read a moved price.
 */
const CC_LEDGER_PREFIX = "cc.ledger|";

export function cacheKeyCcLedgerAccount(accountId: number): string {
  return `${CC_LEDGER_PREFIX}account|${accountId}`;
}

export function cacheKeyCcLedgerGroup(slug: string): string {
  return `${CC_LEDGER_PREFIX}group|${slug}`;
}

export function invalidateCcLedgerResponses(): void {
  deleteKeysMatchingPrefix(CC_LEDGER_PREFIX);
}

/**
 * Every key under this prefix lives as long as the home page bundle: the bundle itself
 * (`<prefix><unit>`) and the payloads built from the same inputs (the nav snapshot / context, the
 * overview chart block).
 */
export const DASHBOARD_PAGE_BUNDLE_PREFIX = "dashboard.page_bundle|";

export function cacheKeyDashboardPageBundle(unit: TsUnit): string {
  return `${DASHBOARD_PAGE_BUNDLE_PREFIX}${unit}`;
}

/**
 * An account page's bundle (`cachedAccountDetailBundle`), under the page bundle's prefix so every
 * invalidation that drops the bundle drops it too; API writes drop it as well (labels, notes and
 * card config are not in any aggregation funnel).
 */
export function cacheKeyAccountDetailBundle(accountId: number, unit: TsUnit, granularity: string): string {
  return `${DASHBOARD_PAGE_BUNDLE_PREFIX}account_detail|${accountId}|${unit}|${granularity}`;
}

/**
 * A group page's responses (valuation series, consolidated tables, monthly P/L series, Rentabilidad),
 * under the page bundle's prefix like the account bundles: every invalidation that drops the
 * bundle drops them, a live tick only where they read a moved price, and API writes drop them too
 * (account names and notes are in the payloads). Inside a transaction they are built afresh.
 */
export function cachedGroupResponse<T>(kind: string, slug: string, unit: TsUnit, build: () => T): T {
  if (dbInTransaction()) return build();
  return getAggregationCached(`${DASHBOARD_PAGE_BUNDLE_PREFIX}group|${kind}|${slug}|${unit}`, () =>
    markJsonResponseCacheable(build())
  );
}

export function invalidateGroupResponses(): void {
  deleteKeysMatchingPrefix(`${DASHBOARD_PAGE_BUNDLE_PREFIX}group|`);
}

/** Drop the entries under one response prefix (an API write; see `index.ts`). */
export function invalidateKeysWithPrefix(prefix: string): void {
  deleteKeysMatchingPrefix(prefix);
}

export function invalidateAccountDetailBundles(): void {
  deleteKeysMatchingPrefix(`${DASHBOARD_PAGE_BUNDLE_PREFIX}account_detail|`);
}

/**
 * The home page-bundle response bakes in every dashboard input (account rows with live marks,
 * valuation TS, CC balances, group perf, fx), so every explicit invalidation below must drop
 * it — a targeted key delete that leaves a stale bundle would serve pre-write data until the
 * next day rollover. Also the eviction hook for a build that rejected mid-flight.
 */
export function invalidateDashboardPageBundle(): void {
  deleteKeysMatchingPrefix(DASHBOARD_PAGE_BUNDLE_PREFIX);
}

/**
 * The flows overview (`flowsOverview.ts`): its payloads (`flows.overview|`) bake in the P/L leg,
 * so every invalidation drops them; its non-market inputs (`flows.overview.inputs|`: income,
 * expense lines, deposits) go with writes and historical market data (fx) — not with a
 * live-quote tick, which moves only the P/L.
 */
export function invalidateFlowsOverview(opts: { inputs: boolean }): void {
  deleteKeysMatchingPrefix("flows.overview|");
  if (opts.inputs) deleteKeysMatchingPrefix("flows.overview.inputs|");
}

/**
 * Daily-view aggregations: bucket series, the overview-daily payload, and the reference-line
 * source totals. Each bakes per-day marks across many accounts, so per-account precision
 * isn't worth the mapping — they rebuild lazily on the next daily-view request, now on top
 * of the cached per-account marks rather than re-walking evidence.
 */
const DAILY_AGGREGATE_PREFIXES = ["daily.series|", "daily.overview|", "daily.refsrc|"] as const;

/**
 * Drop the daily aggregations but KEEP the per-account mark series (`daily.marks|`).
 *
 * Only valid when the write cannot have moved a **historical** mark, which is exactly the
 * live-quote case: `daily.marks|` entries hold days strictly before Chile today, and a
 * historical mark reads `equity_daily` / `fx_daily` EOD only (`accountMarkClpAtYmd`'s live
 * stack is gated on `asOfYmd === today`, and `fxForLiveMtm`, the live-fx reader the equity
 * and crypto MTM helpers use, returns the live CLP=X row only for a date on or after that
 * row's session — Chile today — so an earlier date reads the stored close). Today's mark is
 * never cached, so the rebuilt aggregations still pick up the new quote.
 */
export function invalidateDailyAggregates(): void {
  for (const prefix of DAILY_AGGREGATE_PREFIXES) deleteKeysMatchingPrefix(prefix);
}

/**
 * Drop every cached daily aggregation after a write. The per-account mark series are NOT
 * dropped here: they live in `markSeriesStore.ts`, and the database itself logs which account
 * (or every account) a write moved and from which date (`markInputChanges.ts`, applied on the
 * next read), so each series loses only the days the write can have changed.
 */
export function invalidateDailySeries(): void {
  applyPendingMarkInputChanges();
  deleteKeysMatchingPrefix("daily.");
}

// Marks were trimmed: drop what was built on them, and the input memos a mark rebuild reads
// (the depto ledger, a card's normalized line streams, the checking balance memo) so the
// rebuilt days read the new rows even when the writer did not invalidate them itself.
setMarkInputsChangedListener((change) => {
  invalidateHistoryTier();
  invalidateLiveTier();
  deleteKeysMatchingPrefix("daily.");
  deleteKeysMatchingPrefix("depto.ledger|");
  if (change.all) {
    deleteKeysMatchingPrefix("cc.billing_detail|");
    clearCheckingBalanceCache();
  } else {
    for (const id of change.accountIds) {
      cache.delete(cacheKeyCcBillingDetail(id));
      deleteKeysMatchingPrefix(`${cacheKeyCcBillingDetail(id)}|`);
      clearCheckingBalanceCache(id);
    }
  }
  invalidateDashboardPageBundle();
  invalidateCcLedgerResponses();
  // The expense lines (and the payloads cached on them) read movements and card lines too.
  invalidateFlowsOverview({ inputs: true });
  invalidationListener?.();
});

/**
 * Drop the cached CC billing detail (ledger months + detalle por mes) for one account, or for
 * all accounts when omitted. Same-connection CC writes must call this (directly or via
 * `invalidateAggregationForAccountDate` / `recomputeCcBillingMonthBalances` /
 * `upsertCreditCardValuationsFromLedger`); cross-process writes and day rollover are covered
 * by `ensureCacheFreshForChileDay`.
 */
export function invalidateCcBillingDetail(accountId?: number): void {
  if (accountId == null) {
    deleteKeysMatchingPrefix("cc.billing_detail|");
  } else {
    // Exact key + `<key>|`-prefixed satellites (e.g. the normalized post-close line memo);
    // the delimiter keeps account 16 from clobbering 0161.
    cache.delete(cacheKeyCcBillingDetail(accountId));
    deleteKeysMatchingPrefix(`${cacheKeyCcBillingDetail(accountId)}|`);
  }
  invalidateHistoryTier();
  invalidateLiveTier();
  invalidateCcLedgerResponses();
  // Every account/CC write funnels through here (invalidateAggregationForAccountDate and
  // invalidateLinkedCreditCardAggregationCache both call this) — the bundle, the daily
  // series (whose historical legs read movements/valuations/CC valuations), and the depto
  // ledger memo go with it.
  invalidateDashboardPageBundle();
  invalidateFlowsOverview({ inputs: true });
  invalidateDailySeries();
  deleteKeysMatchingPrefix("depto.ledger|");
  invalidationListener?.();
}

/**
 * A card's open facturación prices its dollars at today's live rate while unpaid
 * (`ccFacturacionUsdRate.ts`, `usd_rate_source: live`), and its expense lines read that rate, so
 * a live-quote tick drops the cached billing detail bundles (`cc.billing_detail|<id>`, not their
 * evidence satellites) and the flows-overview inputs built on them. They rebuilt on top of the
 * history tier, which the tick keeps.
 */
function invalidateCcBillingDetailLiveRates(): void {
  for (const key of [...cache.keys()]) {
    if (/^cc\.billing_detail\|\d+$/.test(key)) cache.delete(key);
  }
}

function ancestorGroupSlugsForGroupId(
  groupId: number,
  groupById: Map<number, { slug: string; parent_id: number | null }>
): string[] {
  const slugs: string[] = [];
  let id: number | null = groupId;
  const seen = new Set<number>();
  while (id != null && !seen.has(id)) {
    seen.add(id);
    const g = groupById.get(id);
    if (!g) break;
    slugs.push(g.slug);
    id = g.parent_id;
  }
  return slugs;
}

function buildRollupSlugsByAccountId(): Map<number, Set<string>> {
  const index = buildPortfolioGroupIndex();
  const groupById = index.groupById;
  const out = new Map<number, Set<string>>();

  const addSlugs = (accountId: number, slugs: Iterable<string>) => {
    const set = out.get(accountId) ?? new Set<string>();
    for (const s of slugs) set.add(s);
    out.set(accountId, set);
  };

  for (const item of index.items) {
    if (item.item_kind === "account" && item.account_id != null) {
      addSlugs(item.account_id, ancestorGroupSlugsForGroupId(item.group_id, groupById));
    }
  }

  for (const issuer of CC_ISSUER_SLUGS) {
    if (!getCreditCardGroupBySlug(issuer)) continue;
    const masterIds = listCreditCardGroupMasterAccountIds(issuer);
    for (const masterId of masterIds) {
      addSlugs(masterId, [issuer, "liabilities_credit_card", "liabilities"]);
    }
  }

  return out;
}

function rollupSlugsForAccount(accountId: number): Set<string> {
  if (!rollupSlugsByAccountId) rollupSlugsByAccountId = buildRollupSlugsByAccountId();
  return new Set(rollupSlugsByAccountId.get(accountId) ?? []);
}

/** Invalidate derived aggregations when movements or valuations change for an account/date. */
export function invalidateAggregationForAccountDate(
  accountId: number,
  occurredOrAsOfYmd: string
): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(occurredOrAsOfYmd)) {
    throw new Error(`invalidateAggregationForAccountDate: invalid date ${occurredOrAsOfYmd}`);
  }
  clearCheckingBalanceCache(accountId);
  invalidateCcBillingDetail(accountId); // drops the history tier too

  const monthKeysToInvalidate = forwardMonthKeysFrom(occurredOrAsOfYmd);
  for (const unit of ["clp", "usd", "uf"] as const) {
    deleteKeysMatchingPrefix(`account.monthly_perf|${accountId}|${unit}`);
    for (const mk of monthKeysToInvalidate) {
      cache.delete(`account.month_close|${accountId}|${unit}|${mk}`);
    }
  }

  for (const slug of rollupSlugsForAccount(accountId)) {
    for (const unit of ["clp", "usd", "uf"] as const) {
      // Stored keys carry a `|{rowsKey}` account-fingerprint suffix, so an exact-key delete
      // never matches. The exact key ends with `|{unit}`, so the prefix can't bleed into a
      // sibling slug (e.g. `bci` won't wipe `bci_other|clp`).
      deleteKeysMatchingPrefix(cacheKeyGroupConsolidatedMonthly(slug, unit));
      cache.delete(cacheKeyGroupClosingByDate(slug, unit));
    }
  }
  cache.delete("dashboard.portfolio_totals|clp");
  cache.delete("dashboard.portfolio_totals|usd");
  cache.delete("dashboard.portfolio_totals|uf");
  invalidationListener?.();
}

function forwardMonthKeysFrom(startYmd: string): string[] {
  const startMk = monthKeyFromYmd(startYmd);
  const endMk = monthKeyFromYmd(chileCalendarTodayYmd());
  if (!startMk || !endMk || startMk > endMk) return startMk ? [startMk] : [];

  const keys: string[] = [];
  let [y, m] = startMk.split("-").map(Number);
  const [ey, em] = endMk.split("-").map(Number);
  while (y < ey || (y === ey && m <= em)) {
    keys.push(`${y}-${String(m).padStart(2, "0")}`);
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
  return keys;
}

/** @internal Test hook: month keys invalidated from a change date (includes YTD-forward months). */
export function forwardMonthKeysForInvalidationTest(startYmd: string): string[] {
  return forwardMonthKeysFrom(startYmd);
}

/** @internal Test hook: portfolio-group rollup slugs an account belongs to. */
export function rollupSlugsForAccountTest(accountId: number): string[] {
  return [...rollupSlugsForAccount(accountId)];
}

/**
 * What a market-data write touched, which decides whether cached per-account mark series
 * survive it:
 * - `historical` (default): rows dated in the past — EOD closes, fx/UF, fund units. Every
 *   mark from that date forward can move, so the whole daily namespace goes.
 * - `live_tail`: `live_market_quotes` only, which no historical mark reads. The cached mark
 *   series and the history tier stay; today's mark is recomputed on the next read because it
 *   is never cached (the live tier goes with every invalidation).
 *
 * Unknown callers get the conservative default — only pass `live_tail` from the live-quotes
 * poll, whose writes are confined to that table.
 */
export type MarketDataInvalidationScope = "historical" | "live_tail";

/**
 * Market-data writes from this process (live-quote poll, global sync applying EOD closes,
 * fund units, fx/UF rows) don't bump `data_version` and carry no account/date, but they move
 * the live "today" marks baked into monthly-perf and consolidated aggregations. Drop those
 * namespaces — `cc.billing_detail|` stays, CC ledgers don't read market quotes — and notify
 * the warmer so the bucket totals track intraday marks instead of the price at cache-build time.
 */
export function invalidateMarketDataAggregations(
  scope: MarketDataInvalidationScope = "historical",
  moves?: LiveQuoteMoves
): void {
  if (scope === "live_tail" && moves) {
    invalidateLiveTickAffected(moves);
    invalidationListener?.(scope);
    return;
  }
  invalidateLiveTier();
  deleteKeysMatchingPrefix("account.monthly_perf|");
  deleteKeysMatchingPrefix("group.consolidated_monthly|");
  deleteKeysMatchingPrefix("group.valuation_closing_by_date|");
  invalidateDashboardPageBundle();
  invalidateCcLedgerResponses();
  invalidateFlowsOverview({ inputs: scope === "historical" });
  if (scope === "live_tail") {
    invalidateDailyAggregates();
    invalidateCcBillingDetailLiveRates();
  } else {
    invalidateHistoryTier();
    invalidateDailySeries();
  }
  invalidationListener?.(scope);
}

/** The entries an unscoped `live_tail` invalidation drops (see above); a scoped one never drops more. */
const LIVE_TAIL_PREFIXES = [
  "account.monthly_perf|",
  "group.consolidated_monthly|",
  "group.valuation_closing_by_date|",
  DASHBOARD_PAGE_BUNDLE_PREFIX,
  CC_LEDGER_PREFIX,
  "flows.overview|",
  ...DAILY_AGGREGATE_PREFIXES,
];

function droppedByLiveTail(key: string): boolean {
  return LIVE_TAIL_PREFIXES.some((p) => key.startsWith(p)) || /^cc\.billing_detail\|\d+$/.test(key);
}

/**
 * A live-quote poll moved `moves`: drop, among the entries an unscoped tick would drop, those
 * that read a moved price (`cacheDependencies.ts`) or whose inputs are unknown, and the live-tier
 * memos that read one. Everything else — the card ledger, the mortgage, the liabilities'
 * consolidation, a crypto move at 3 a.m. — stays. What is dropped rebuilds on top of the history
 * tier, so only today's marks and the current-month rows are recomputed.
 */
function invalidateLiveTickAffected(moves: LiveQuoteMoves): void {
  const memo = new Map<CacheDepNode, boolean>();
  for (const map of liveTier.maps.values()) {
    for (const [k, entry] of [...map]) {
      if (cacheDepNodeAffected(entry.node, moves, memo)) map.delete(k);
    }
  }
  for (const key of [...cache.keys()]) {
    if (!droppedByLiveTail(key)) continue;
    const node = depNodes.get(key);
    if (!node || cacheDepNodeAffected(node, moves, memo)) cache.delete(key);
  }
}

/** @internal Test hook: whether `key` is cached. */
export function aggregationCacheHasForTest(key: string): boolean {
  return cache.has(key);
}

/** @internal Test hook: every cached key. */
export function aggregationCacheKeysForTest(): string[] {
  return [...cache.keys()];
}

const LINKED_CC_AGGREGATION_GROUP_SLUGS = [
  "cash_eqs",
  "net_worth",
  "liabilities",
  "liabilities_credit_card",
  ...CC_ISSUER_SLUGS,
];

/**
 * EFECTIVO header uses consolidated `cash_eqs`; footer uses live linked CC math.
 * Call when CC link membership changes (exclude flag, group items, nav_retired).
 */
export function invalidateLinkedCreditCardAggregationCache(): void {
  rollupSlugsByAccountId = null;
  invalidateCcBillingDetail(); // also notifies the invalidation listener
  for (const unit of ["clp", "usd", "uf"] as const) {
    for (const slug of LINKED_CC_AGGREGATION_GROUP_SLUGS) {
      // Consolidated-monthly keys carry a `|{rowsKey}` suffix; use a prefix delete (the exact
      // key ends with `|{unit}`, so it stays within the slug boundary).
      deleteKeysMatchingPrefix(cacheKeyGroupConsolidatedMonthly(slug, unit));
      cache.delete(cacheKeyGroupClosingByDate(slug, unit));
    }
    cache.delete(`dashboard.portfolio_totals|${unit}`);
  }
}
