import { cachedAccountDetailBundle } from "./accountDetailBundle.js";
import { creditCardGroupLedgerResponse, resolveCcMasterAccountIds } from "./creditCardGroupLedger.js";
import { buildDashboardNavContext } from "./dashboardAccounts.js";
import { db } from "./db.js";
import { groupDailySeriesResponse } from "./groupDailySeriesResponse.js";
import {
  groupConsolidatedTablesResponse,
  groupMonthlyPlSeriesResponse,
  groupValuationTsResponse,
} from "./groupPagePayloads.js";
import { isResolvablePortfolioGroupSlug } from "./portfolioGroupTree.js";
import { cachedSidebarNavPayload } from "./sidebarNavChartBuckets.js";
import { usageDb } from "./usageDb.js";
import type { TsUnit } from "./valuationTimeseries.js";

/**
 * Warm the pages actually opened (the usage log, `usageLog.ts`), most visited first, after the
 * home bundle: each visited group page's cached responses (valuation, tables, monthly P/L, card
 * ledger) and its daily series at the Rango and unit it was asked for, each visited account page's
 * bundle, and the sidebar and nav context every non-home page loads. One page per macrotask, so requests
 * interleave with the warm; a payload already cached costs a lookup.
 */

/** How far back the ranking looks, and how many pages of each kind it warms. */
export const VISITED_WARM_WINDOW_DAYS = 30;
export const VISITED_WARM_MAX_GROUPS = 8;
export const VISITED_WARM_MAX_ACCOUNTS = 5;
/** Daily-series variants warmed per group (Rango × unit × P/L levels), most requested first. */
export const VISITED_WARM_DAILY_PER_GROUP = 2;

export type DailyVariant = { days: number; unit: TsUnit; perfLevels: boolean };

export type VisitedWarmPlan = {
  groups: { slug: string; units: TsUnit[]; daily: DailyVariant[] }[];
  accounts: { id: number; unit: TsUnit; granularity: "monthly" | "daily" }[];
  navContextUnits: TsUnit[];
};

type PageViewCount = { path: string; n: number };
type EndpointCount = { route: string; params: string; n: number };

function paramsOf(params: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const part of params.split("&")) {
    if (!part) continue;
    const i = part.indexOf("=");
    out.set(i < 0 ? part : part.slice(0, i), i < 0 ? "" : part.slice(i + 1));
  }
  return out;
}

function unitOf(p: Map<string, string>): TsUnit {
  const v = p.get("include_usd");
  return v === "1" || v === "true" ? "usd" : "clp";
}

/**
 * The pages to warm, from page views (path → group by its nav route, `/account/<id>`) and the
 * endpoint log (which group, Rango and unit each daily series was asked for; the unit of each
 * group's valuation series). Pure: the counts come in, the plan goes out.
 */
export function planVisitedWarm(
  pageViews: readonly PageViewCount[],
  endpoints: readonly EndpointCount[],
  groupSlugByRoute: ReadonlyMap<string, string>
): VisitedWarmPlan {
  const groupScore = new Map<string, number>();
  const units = new Map<string, Map<TsUnit, number>>();
  const daily = new Map<string, Map<string, { v: DailyVariant; n: number }>>();
  const accountScore = new Map<number, number>();
  const addScore = (slug: string, n: number) => groupScore.set(slug, (groupScore.get(slug) ?? 0) + n);

  for (const { path, n } of pageViews) {
    const account = /^\/account\/(\d+)$/.exec(path);
    if (account) {
      const id = Number(account[1]);
      accountScore.set(id, (accountScore.get(id) ?? 0) + n);
      continue;
    }
    const slug = groupSlugByRoute.get(path);
    if (slug != null && slug !== "dashboard") addScore(slug, n);
  }
  let granularityDaily = 0;
  let granularityMonthly = 0;
  for (const { route, params, n } of endpoints) {
    const p = paramsOf(params);
    if (route === "/api/accounts/:id/detail-bundle") {
      if (p.get("granularity") === "daily") granularityDaily += n;
      else granularityMonthly += n;
      continue;
    }
    const slug = p.get("portfolio_group");
    if (!slug) continue;
    if (route === "/api/dashboard/valuation-timeseries") {
      const byUnit = units.get(slug) ?? new Map<TsUnit, number>();
      byUnit.set(unitOf(p), (byUnit.get(unitOf(p)) ?? 0) + n);
      units.set(slug, byUnit);
    } else if (route === "/api/daily-series") {
      const days = Number(p.get("days") ?? "");
      if (!Number.isInteger(days) || days < 0) continue;
      const v: DailyVariant = { days, unit: unitOf(p), perfLevels: p.get("perf_levels") === "1" || p.get("perf_levels") === "true" };
      const key = `${v.days}|${v.unit}|${v.perfLevels}`;
      const bySlug = daily.get(slug) ?? new Map();
      const prev = bySlug.get(key);
      bySlug.set(key, { v, n: (prev?.n ?? 0) + n });
      daily.set(slug, bySlug);
    }
  }
  // A group asked for by its endpoints but never seen as a page (an older client) still counts.
  for (const [slug, byUnit] of units) {
    if (!groupScore.has(slug)) addScore(slug, [...byUnit.values()].reduce((a, b) => a + b, 0));
  }

  const byScore = <K>(m: Map<K, number>) =>
    [...m.entries()].filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])));
  const groups = byScore(groupScore)
    .slice(0, VISITED_WARM_MAX_GROUPS)
    .map(([slug]) => {
      const byUnit = units.get(slug);
      const groupUnits = byUnit ? byScore(byUnit).map(([u]) => u) : (["clp"] as TsUnit[]);
      const variants = [...(daily.get(slug)?.values() ?? [])]
        .sort((a, b) => b.n - a.n)
        .slice(0, VISITED_WARM_DAILY_PER_GROUP)
        .map((x) => x.v);
      return { slug, units: groupUnits.length ? groupUnits : (["clp"] as TsUnit[]), daily: variants };
    });
  const granularity = granularityDaily > granularityMonthly ? "daily" : "monthly";
  const accounts = byScore(accountScore)
    .slice(0, VISITED_WARM_MAX_ACCOUNTS)
    .map(([id]) => ({ id, unit: "clp" as TsUnit, granularity: granularity as "monthly" | "daily" }));
  const navContextUnits = [...new Set(groups.flatMap((g) => g.units))];
  if (navContextUnits.length === 0 && accounts.length > 0) navContextUnits.push("clp");
  return { groups, accounts, navContextUnits };
}

export function visitedWarmPlanFromUsageLog(now = new Date()): VisitedWarmPlan {
  const since = new Date(now.getTime() - VISITED_WARM_WINDOW_DAYS * 86_400_000).toISOString();
  const usage = usageDb();
  const pageViews = usage
    .prepare(`SELECT path, COUNT(*) AS n FROM usage_page_views WHERE viewed_at >= ? GROUP BY path`)
    .all(since) as PageViewCount[];
  const endpoints = usage
    .prepare(
      `SELECT route, params, SUM(count) AS n FROM usage_endpoint_hourly
       WHERE hour_start >= ? AND method = 'GET'
         AND route IN ('/api/daily-series', '/api/dashboard/valuation-timeseries', '/api/accounts/:id/detail-bundle')
       GROUP BY route, params`
    )
    .all(since) as EndpointCount[];
  const routes = db
    .prepare(
      `SELECT route_path, slug FROM portfolio_groups WHERE route_path IS NOT NULL
       UNION SELECT route_path, slug FROM liability_groups WHERE route_path IS NOT NULL`
    )
    .all() as { route_path: string; slug: string }[];
  const knownAccounts = new Set((db.prepare(`SELECT id FROM accounts`).all() as { id: number }[]).map((r) => r.id));
  const plan = planVisitedWarm(pageViews, endpoints, new Map(routes.map((r) => [r.route_path, r.slug])));
  return {
    ...plan,
    // Only what the routes accept (a slug the log kept from an older nav tree is skipped).
    groups: plan.groups.filter((g) => g.slug === "inversiones" || isResolvablePortfolioGroupSlug(g.slug)),
    accounts: plan.accounts.filter((a) => knownAccounts.has(a.id)),
  };
}

/** Build the plan's payloads, one page per macrotask; returns how many pages it warmed. */
export async function warmVisitedPages(plan: VisitedWarmPlan = visitedWarmPlanFromUsageLog()): Promise<number> {
  const yieldToRequests = () => new Promise<void>((resolve) => setImmediate(resolve));
  let pages = 0;
  if (plan.groups.length > 0 || plan.accounts.length > 0) {
    await yieldToRequests();
    cachedSidebarNavPayload();
  }
  for (const unit of plan.navContextUnits) {
    await yieldToRequests();
    await buildDashboardNavContext(unit === "usd", unit);
  }
  for (const g of plan.groups) {
    for (const unit of g.units) {
      await yieldToRequests();
      groupValuationTsResponse(g.slug, unit);
      await yieldToRequests();
      groupConsolidatedTablesResponse(g.slug, unit);
      await yieldToRequests();
      groupMonthlyPlSeriesResponse(g.slug, unit);
    }
    if (resolveCcMasterAccountIds(g.slug).length > 0) {
      await yieldToRequests();
      creditCardGroupLedgerResponse(g.slug);
    }
    for (const v of g.daily) {
      await yieldToRequests();
      groupDailySeriesResponse(g.slug, v.unit, v.days, v.perfLevels);
    }
    pages += 1;
  }
  for (const a of plan.accounts) {
    await yieldToRequests();
    await cachedAccountDetailBundle(a.id, a.unit, a.granularity);
    pages += 1;
  }
  return pages;
}
