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

function deleteKeysMatchingPrefix(prefix: string): void {
  for (const key of [...cache.keys()]) {
    if (key.startsWith(prefix)) cache.delete(key);
  }
}

export function clearAggregationCache(): void {
  cache.clear();
  rollupSlugsByAccountId = null;
}

export function getAggregationCached<T>(key: string, build: () => T): T {
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
    if (masterIds.length) {
      const ph = masterIds.map(() => "?").join(",");
      const views = db
        .prepare(
          `SELECT id FROM accounts
           WHERE account_kind = 'liability_view' AND source_account_id IN (${ph})`
        )
        .all(...masterIds) as { id: number }[];
      for (const v of views) {
        addSlugs(v.id, [issuer, "liabilities_credit_card", "liabilities"]);
      }
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
