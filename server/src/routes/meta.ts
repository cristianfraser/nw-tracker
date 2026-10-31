/** Health check + nav/meta trees (sidebar nav, rates instruments). Split verbatim from index.ts; paths unchanged. */
import express from "express";
import { DASHBOARD_PAGE_BUNDLE_PREFIX, getAggregationCached } from "../aggregationCache.js";
import { getAppVersion } from "../appVersion.js";
import { demoModeEnabled } from "../demoMode.js";
import { listRatesInstrumentSeries } from "../marketDisplaySeries.js";
import { getNetWorthNavGroupNode, getSidebarNavPayload } from "../navTree.js";
import { annotateSidebarNavChartBuckets } from "../sidebarNavChartBuckets.js";

export function registerMetaRoutes(app: express.Express): void {
app.get("/api/health", (_req, res) => {
  res.json({ ok: true, version: getAppVersion() });
});

/** Recursive portfolio groups (accounts + nested groups) with resolved colors. */
/** Sidebar navigation tree (DB-driven; matches legacy layout). `main` nodes carry `chart_buckets`.
 * The hosted demo hides the wealth-percentile link (personal-context page; its API 404s there too). */
app.get("/api/meta/sidebar-nav", (_req, res) => {
  // Cached with the page bundle's lifetime: its chart-inactive flags read the accounts' month
  // series, and a nav-tree edit clears the whole cache (`seedNavTree`).
  const payload = getAggregationCached(`${DASHBOARD_PAGE_BUNDLE_PREFIX}sidebar_nav`, () => {
    const built = getSidebarNavPayload();
    return { ...built, main: annotateSidebarNavChartBuckets(built.main) };
  });
  res.json({
    ...payload,
    wealth_percentile: demoModeEnabled() ? null : payload.wealth_percentile,
    tax_return: demoModeEnabled() ? null : payload.tax_return,
  });
});

/** Control panel account tree — all portfolio-linked accounts (includes chart-inactive). */
app.get("/api/meta/panel-net-worth-tree", (_req, res) => {
  res.json({ net_worth: getNetWorthNavGroupNode({ includeChartInactiveAccounts: true }) });
});

/** Market instruments for rates charts and marquee configuration. */
app.get("/api/meta/rates-instruments", (_req, res) => {
  res.json({ instruments: listRatesInstrumentSeries() });
});

}
