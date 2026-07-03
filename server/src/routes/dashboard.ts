/** Home dashboard bundles, valuation timeseries, group tables/flows/performance. Split verbatim from index.ts; paths unchanged. */
import express from "express";
import {
  isResolvablePortfolioGroupSlug,
  normalizeLegacyTabSubgroup,
  portfolioGroupBySlug,
  resolvePortfolioGroupSlugForLegacyTab,
} from "../portfolioGroupTree.js";
import { attachColorsToValuationPayload } from "../chartColorRgb.js";
import {
  getDashboardValuationTimeseries,
  getGroupValuationTimeseries,
  type TsUnit,
} from "../valuationTimeseries.js";
import {
  getGroupMonthlyPerformanceSeries,
  getStocksLifetimeEarningsSeries,
} from "../accountPerformance.js";
import { buildDashboardNavContext, buildDashboardNavSnapshot } from "../dashboardAccounts.js";
import { buildDashboardPageBundle } from "../dashboardPageBundle.js";
import { buildDashboardPagePayload } from "../dashboardPagePayload.js";
import { getGroupConsolidatedMonthlyPage, getGroupConsolidatedTables } from "../groupConsolidatedTables.js";
import {
  buildGroupFlows,
  buildAccountFlows,
  type FlowsFilters,
} from "../flowsApi.js";
import { parsePageParams } from "../pagination.js";
import {
  asyncHandler,
  isKnownClassTabGroup,
  operationalAccountIdFromReq,
} from "./shared.js";

export function registerDashboardRoutes(app: express.Express): void {
app.get("/api/dashboard/nav-snapshot", asyncHandler(async (req, res) => {
  const includeUsd = req.query.include_usd === "1" || req.query.include_usd === "true";
  res.json(await buildDashboardNavSnapshot(includeUsd));
}));

/** Group/account nav strip: accounts + liabilities links + overview (one round-trip). */
app.get("/api/dashboard/nav-context", asyncHandler(async (req, res) => {
  const includeUsd = req.query.include_usd === "1" || req.query.include_usd === "true";
  const unit: TsUnit = includeUsd ? "usd" : "clp";
  res.json(await buildDashboardNavContext(includeUsd, unit));
}));

/** Home dashboard: one response (dash + valuation TS + FX + group perf). */
app.get("/api/dashboard/page-bundle", asyncHandler(async (req, res) => {
  const includeUsd = req.query.include_usd === "1" || req.query.include_usd === "true";
  const unit: TsUnit = includeUsd ? "usd" : "clp";
  res.json(await buildDashboardPageBundle(unit));
}));

app.get("/api/dashboard", asyncHandler(async (req, res) => {
  const includeUsd = req.query.include_usd === "1" || req.query.include_usd === "true";
  res.json(await buildDashboardPagePayload(includeUsd));
}));

/**
 * Valuation time series: main dashboard (no `group`) or per-class tab (`group=retirement|brokerage|…`).
 * Query: include_usd / include_uf → unit (main dashboard UI only uses CLP+USD; UF kept for other consumers).
 */
app.get("/api/dashboard/valuation-timeseries", (req, res) => {
  const includeUsd = req.query.include_usd === "1" || req.query.include_usd === "true";
  const includeUf = req.query.include_uf === "1" || req.query.include_uf === "true";
  const unit: TsUnit = includeUsd ? "usd" : includeUf ? "uf" : "clp";

  const portfolioGroup =
    typeof req.query.portfolio_group === "string" ? req.query.portfolio_group.trim() : "";
  const group = typeof req.query.group === "string" ? req.query.group.trim() : "";
  if (portfolioGroup || group) {
    const subRaw = group ? normalizeLegacyTabSubgroup(req.query.subgroup) : undefined;
    if (subRaw === null) {
      res.status(400).json({ error: "invalid subgroup" });
      return;
    }
    const tabSlug = portfolioGroup
      ? portfolioGroup
      : resolvePortfolioGroupSlugForLegacyTab(group, subRaw) ??
        (portfolioGroupBySlug(group) ? group : null);
    if (!tabSlug || !isKnownClassTabGroup(tabSlug)) {
      res.status(400).json({ error: "unknown group slug" });
      return;
    }
    res.json(
      attachColorsToValuationPayload(getGroupValuationTimeseries(tabSlug, unit, undefined))
    );
    return;
  }

  res.json(attachColorsToValuationPayload(getDashboardValuationTimeseries(unit)));
});

/** SPY+VEA merged: monthly Δ (sum) and cumulative earnings since first month (derived). */
app.get("/api/dashboard/stocks-earnings-monthly", (req, res) => {
  const includeUsd = req.query.include_usd === "1" || req.query.include_usd === "true";
  const unit: TsUnit = includeUsd ? "usd" : "clp";
  res.json(getStocksLifetimeEarningsSeries(unit));
});

/** Group consolidated tables: per-account monthly perf + movements in one response. */
app.get("/api/groups/:slug/consolidated-tables", (req, res) => {
  const slug = typeof req.params.slug === "string" ? req.params.slug.trim() : "";
  if (!isKnownClassTabGroup(slug)) {
    res.status(400).json({ error: "unknown group slug" });
    return;
  }
  const subRaw = normalizeLegacyTabSubgroup(req.query.subgroup);
  if (subRaw === null) {
    res.status(400).json({ error: "invalid subgroup" });
    return;
  }
  const tabSlug =
    resolvePortfolioGroupSlugForLegacyTab(slug, subRaw) ??
    (isResolvablePortfolioGroupSlug(slug) ? slug : null);
  if (!tabSlug || !isKnownClassTabGroup(tabSlug)) {
    res.status(400).json({ error: "unknown group slug" });
    return;
  }
  const includeUsd = req.query.include_usd === "1" || req.query.include_usd === "true";
  const unit: TsUnit = includeUsd ? "usd" : "clp";
  res.json(getGroupConsolidatedTables(tabSlug, unit, undefined));
});

/** Server-paginated consolidated detalle-por-mes rows (dashboard net_worth table). */
app.get("/api/groups/:slug/consolidated-monthly", (req, res) => {
  const slug = typeof req.params.slug === "string" ? req.params.slug.trim() : "";
  if (!isKnownClassTabGroup(slug)) {
    res.status(400).json({ error: "unknown group slug" });
    return;
  }
  const subRaw = normalizeLegacyTabSubgroup(req.query.subgroup);
  if (subRaw === null) {
    res.status(400).json({ error: "invalid subgroup" });
    return;
  }
  const tabSlug =
    resolvePortfolioGroupSlugForLegacyTab(slug, subRaw) ??
    (isResolvablePortfolioGroupSlug(slug) ? slug : null);
  if (!tabSlug || !isKnownClassTabGroup(tabSlug)) {
    res.status(400).json({ error: "unknown group slug" });
    return;
  }
  const periodRaw = typeof req.query.period === "string" ? req.query.period : "month";
  if (periodRaw !== "month" && periodRaw !== "year") {
    res.status(400).json({ error: "invalid period" });
    return;
  }
  const includeUsd = req.query.include_usd === "1" || req.query.include_usd === "true";
  const unit: TsUnit = includeUsd ? "usd" : "clp";
  const { page, pageSize } = parsePageParams(req.query as Record<string, unknown>, 12);
  res.json(getGroupConsolidatedMonthlyPage(tabSlug, unit, periodRaw, page, pageSize));
});

/** Paginated + filtered flows for a group (server-side). */
app.get("/api/groups/:slug/flows", (req, res) => {
  const slug = typeof req.params.slug === "string" ? req.params.slug.trim() : "";
  if (!isKnownClassTabGroup(slug)) {
    res.status(400).json({ error: "unknown group slug" });
    return;
  }
  const subRaw = normalizeLegacyTabSubgroup(req.query.subgroup);
  if (subRaw === null) {
    res.status(400).json({ error: "invalid subgroup" });
    return;
  }
  const tabSlug =
    resolvePortfolioGroupSlugForLegacyTab(slug, subRaw) ??
    (isResolvablePortfolioGroupSlug(slug) ? slug : null);
  if (!tabSlug || !isKnownClassTabGroup(tabSlug)) {
    res.status(400).json({ error: "unknown group slug" });
    return;
  }
  const { page, pageSize } = parsePageParams(req.query as Record<string, unknown>, 20);
  const filters: FlowsFilters = {};
  if (typeof req.query.year === "string" && req.query.year.trim()) filters.year = req.query.year.trim();
  if (typeof req.query.type === "string" && req.query.type.trim()) filters.type = req.query.type.trim();
  if (req.query.account_id) {
    const aid = Number(req.query.account_id);
    if (Number.isFinite(aid) && aid > 0) filters.account_id = aid;
  }
  if (typeof req.query.category === "string" && req.query.category.trim()) filters.category = req.query.category.trim();
  if (typeof req.query.q === "string" && req.query.q.trim()) filters.q = req.query.q.trim();
  res.json(buildGroupFlows(tabSlug, filters, page, pageSize));
});

/** Paginated + filtered flows for a single account (server-side). */
app.get("/api/accounts/:id/flows", (req, res) => {
  const id = operationalAccountIdFromReq(req);
  if (!Number.isFinite(id) || id <= 0) {
    res.status(400).json({ error: "invalid account id" });
    return;
  }
  const { page, pageSize } = parsePageParams(req.query as Record<string, unknown>, 20);
  const filters: FlowsFilters = {};
  if (typeof req.query.year === "string" && req.query.year.trim()) filters.year = req.query.year.trim();
  if (typeof req.query.type === "string" && req.query.type.trim()) filters.type = req.query.type.trim();
  if (typeof req.query.q === "string" && req.query.q.trim()) filters.q = req.query.q.trim();
  if (req.query.personal_only === "1" || req.query.personal_only === "true") filters.personal_only = true;
  const result = buildAccountFlows(id, filters, page, pageSize);
  if (!result) {
    res.status(404).json({ error: "account not found" });
    return;
  }
  res.json(result);
});

/** Per-class tab: month P/L bars per account + combined YTD area + ΣΔ line (derived, not stored). */
app.get("/api/groups/:slug/performance-monthly", (req, res) => {
  const slug = typeof req.params.slug === "string" ? req.params.slug.trim() : "";
  if (!isKnownClassTabGroup(slug)) {
    res.status(400).json({ error: "unknown group slug" });
    return;
  }
  const subRaw = normalizeLegacyTabSubgroup(req.query.subgroup);
  if (subRaw === null) {
    res.status(400).json({ error: "invalid subgroup" });
    return;
  }
  const tabSlug =
    resolvePortfolioGroupSlugForLegacyTab(slug, subRaw) ??
    (isResolvablePortfolioGroupSlug(slug) ? slug : null);
  if (!tabSlug || !isKnownClassTabGroup(tabSlug)) {
    res.status(400).json({ error: "unknown group slug" });
    return;
  }
  const includeUsd = req.query.include_usd === "1" || req.query.include_usd === "true";
  const unit: TsUnit = includeUsd ? "usd" : "clp";
  res.json(getGroupMonthlyPerformanceSeries(tabSlug, unit, undefined));
});

}
