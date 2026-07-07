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
    cache.delete(cacheKeyCcBillingDetail(accountId));
    const operationalId = resolveOperationalAccountId(accountId);
    if (operationalId !== accountId) cache.delete(cacheKeyCcBillingDetail(operationalId));
  }
  // Every account/CC write funnels through here (invalidateAggregationForAccountDate and
  // invalidateLinkedCreditCardAggregationCache both call this) — the bundle goes with it.
  invalidateDashboardPageBundle();
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
      cache.delete(cacheKeyGroupConsolidatedMonthly(slug, unit));
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

/**
 * Market-data writes from this process (live-quote poll, global sync applying EOD closes,
 * fund units, fx/UF rows) don't bump `data_version` and carry no account/date, but they move
 * the live "today" marks baked into monthly-perf and consolidated aggregations. Drop those
 * namespaces — `cc.billing_detail|` stays, CC ledgers don't read market quotes — and notify
 * the warmer so the bucket totals track intraday marks instead of the price at cache-build time.
 */
export function invalidateMarketDataAggregations(): void {
  deleteKeysMatchingPrefix("account.monthly_perf|");
  deleteKeysMatchingPrefix("group.consolidated_monthly|");
  deleteKeysMatchingPrefix("group.valuation_closing_by_date|");
  invalidateDashboardPageBundle();
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
      cache.delete(cacheKeyGroupConsolidatedMonthly(slug, unit));
      cache.delete(cacheKeyGroupClosingByDate(slug, unit));
    }
    cache.delete(`dashboard.portfolio_totals|${unit}`);
  }
}
