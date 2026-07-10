/** Health check + nav/meta trees (sidebar, portfolio, market display series). Split verbatim from index.ts; paths unchanged. */
import express from "express";
import { getAppVersion } from "../appVersion.js";
import { listRatesInstrumentSeries, listMarketDisplaySeries } from "../marketDisplaySeries.js";
import {
  getNetWorthNavGroupNode,
  getPortfolioTreeForCharts,
  getSidebarNavPayload,
} from "../navTree.js";

export function registerMetaRoutes(app: express.Express): void {
app.get("/api/health", (_req, res) => {
  res.json({ ok: true, version: getAppVersion() });
});

/** Recursive portfolio groups (accounts + nested groups) with resolved colors. */
app.get("/api/meta/portfolio-tree", (_req, res) => {
  res.json({ roots: getPortfolioTreeForCharts() });
});

/** Sidebar navigation tree (DB-driven; matches legacy layout). */
app.get("/api/meta/sidebar-nav", (_req, res) => {
  res.json(getSidebarNavPayload());
});

/** Control panel account tree — all portfolio-linked accounts (includes chart-inactive). */
app.get("/api/meta/panel-net-worth-tree", (_req, res) => {
  res.json({ net_worth: getNetWorthNavGroupNode({ includeChartInactiveAccounts: true }) });
});

/** Market instruments for rates charts and marquee configuration. */
app.get("/api/meta/market-display-series", (_req, res) => {
  res.json({ series: listMarketDisplaySeries() });
});

app.get("/api/meta/rates-instruments", (_req, res) => {
  res.json({ instruments: listRatesInstrumentSeries() });
});

}
