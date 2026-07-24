import { resolveOperationalAccountId } from "./accountSource.js";
import { clearCheckingBalanceCache } from "./checkingCartolaBalances.js";
import { monthKeyFromYmd } from "./calendarMonth.js";
import { chileCalendarTodayYmd } from "./chileDate.js";
import { getCreditCardGroupBySlug, listCreditCardGroupMasterAccountIds } from "./creditCardTree.js";
import { db } from "./db.js";
import { buildPortfolioGroupIndex } from "./portfolioGroupIndex.js";
import type { TsUnit } from "./valuationTimeseries.js";

const cache = new Map<string, unknown>();

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

function currentDbDataVersion(): number {
  return db.pragma("data_version", { simple: true }) as number;
}

function ensureCacheFreshForChileDay(): void {
  const today = chileCalendarTodayYmd();
  const dataVersion = currentDbDataVersion();
  if (cacheDayYmd !== today || cacheDbDataVersion !== dataVersion) {
    cache.clear();
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
let invalidationListener: (() => void) | null = null;

export function setAggregationInvalidationListener(listener: (() => void) | null): void {
  invalidationListener = listener;
}

export function clearAggregationCache(): void {
  cache.clear();
  rollupSlugsByAccountId = null;
  invalidationListener?.();
}

export function getAggregationCached<T>(key: string, build: () => T): T {
  ensureCacheFreshForChileDay();
  if (cache.has(key)) return cache.get(key) as T;
  const value = build();
  cache.set(key, value);
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

export function cacheKeyDashboardPageBundle(unit: TsUnit): string {
  return `dashboard.page_bundle|${unit}`;
}

/**
 * The home page-bundle response bakes in every dashboard input (account rows with live marks,
 * valuation TS, CC balances, group perf, fx), so every explicit invalidation below must drop
 * it — a targeted key delete that leaves a stale bundle would serve pre-write data until the
 * next day rollover. Also the eviction hook for a build that rejected mid-flight.
 */
export function invalidateDashboardPageBundle(): void {
  deleteKeysMatchingPrefix("dashboard.page_bundle|");
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
 * stack is gated on `asOfYmd === today`, and `computeEquityMtmClp` only reaches
 * `fxForLiveMtm` when handed an explicit live price). Today's mark is never cached, so the
 * rebuilt aggregations still pick up the new quote.
 */
export function invalidateDailyAggregates(): void {
  for (const prefix of DAILY_AGGREGATE_PREFIXES) deleteKeysMatchingPrefix(prefix);
}

/**
 * Drop every cached daily entry — aggregations **and** per-account mark series. The default
 * for anything that touches stored evidence (movements, valuations, statements) or historical
 * market data (EOD closes, fx/UF rows), since those move historical marks.
 *
 * Mark series are dropped for **all** accounts, not just the written one: an account's marks
 * can depend on another account's rows (the depto property and mortgage accounts share one
 * ledger; deposit-carry flows follow transfer legs), and there is no dependency map to make
 * a narrower drop provably correct. Writes are rare next to live-quote ticks, which keep
 * their marks via {@link invalidateDailyAggregates}.
 */
export function invalidateDailySeries(): void {
  deleteKeysMatchingPrefix("daily.");
}

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
    // the delimiter keeps account 16 from clobbering 1617.
    for (const id of new Set([accountId, resolveOperationalAccountId(accountId)])) {
      cache.delete(cacheKeyCcBillingDetail(id));
      deleteKeysMatchingPrefix(`${cacheKeyCcBillingDetail(id)}|`);
    }
  }
  // Every account/CC write funnels through here (invalidateAggregationForAccountDate and
  // invalidateLinkedCreditCardAggregationCache both call this) — the bundle, the daily
  // series (whose historical legs read movements/valuations/CC valuations), and the depto
  // ledger memo go with it.
  invalidateDashboardPageBundle();
  invalidateDailySeries();
  deleteKeysMatchingPrefix("depto.ledger|");
  invalidationListener?.();
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

  for (const issuer of ["santander", "bci"] as const) {
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
  const operational = resolveOperationalAccountId(accountId);
  const slugs = new Set<string>();
  for (const id of [accountId, operational]) {
    for (const s of rollupSlugsByAccountId.get(id) ?? []) slugs.add(s);
  }
  return slugs;
}

/** Invalidate derived aggregations when movements or valuations change for an account/date. */
export function invalidateAggregationForAccountDate(
  accountId: number,
  occurredOrAsOfYmd: string
): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(occurredOrAsOfYmd)) {
    throw new Error(`invalidateAggregationForAccountDate: invalid date ${occurredOrAsOfYmd}`);
  }
  const operationalId = resolveOperationalAccountId(accountId);
  clearCheckingBalanceCache(operationalId);
  if (operationalId !== accountId) clearCheckingBalanceCache(accountId);
  invalidateCcBillingDetail(accountId);

  const monthKeysToInvalidate = forwardMonthKeysFrom(occurredOrAsOfYmd);
  for (const unit of ["clp", "usd", "uf"] as const) {
    deleteKeysMatchingPrefix(`account.monthly_perf|${operationalId}|${unit}`);
    if (operationalId !== accountId) {
      deleteKeysMatchingPrefix(`account.monthly_perf|${accountId}|${unit}`);
    }
    for (const mk of monthKeysToInvalidate) {
      cache.delete(`account.month_close|${operationalId}|${unit}|${mk}`);
      if (operationalId !== accountId) {
        cache.delete(`account.month_close|${accountId}|${unit}|${mk}`);
      }
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
 *   series stay; today's mark is recomputed on the next read because it is never cached.
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
  scope: MarketDataInvalidationScope = "historical"
): void {
  deleteKeysMatchingPrefix("account.monthly_perf|");
  deleteKeysMatchingPrefix("group.consolidated_monthly|");
  deleteKeysMatchingPrefix("group.valuation_closing_by_date|");
  invalidateDashboardPageBundle();
  if (scope === "live_tail") {
    invalidateDailyAggregates();
  } else {
    invalidateDailySeries();
  }
  invalidationListener?.();
}

const LINKED_CC_AGGREGATION_GROUP_SLUGS = [
  "cash_eqs",
  "net_worth",
  "liabilities",
  "liabilities_credit_card",
  "santander",
  "bci",
] as const;

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
