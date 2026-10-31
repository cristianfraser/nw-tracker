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
  groupConsolidatedTablesResponse,
  groupMonthlyPlSeriesResponse,
  groupPeriodReturnsResponse,
  groupValuationTsResponse,
} from "../groupPagePayloads.js";
import { groupDailySeriesResponse } from "../groupDailySeriesResponse.js";
import { attachNetWorthAth } from "../netWorthAllTimeHigh.js";
import {
  getDashboardValuationTimeseries,
  type TsUnit,
} from "../valuationTimeseries.js";
import { buildInversionesPerfDaily } from "../inversionesPerfSeries.js";
import { dailyPerfLevelsForAccount } from "../dailyPerfLevels.js";
import { buildDashboardNavContext, buildDashboardNavSnapshot } from "../dashboardAccounts.js";
import { buildDashboardPageBundle } from "../dashboardPageBundle.js";
import { accountBucketKindSlug } from "../accountBucket.js";
import { ccDailyHistorialBlockForMasters } from "../ccDailyHistorialBlock.js";
import { deptoPropertyChartOverlayDailyLines } from "../dailyReferenceLines.js";
import { DAILY_SERIES_MAX_DAYS } from "../dailySeries.js";
import { resolveAccountDailySeries } from "../groupDailySeries.js";
import { db } from "../db.js";
import {
  getDashboardOverviewDaily,
  OVERVIEW_DAILY_DEFAULT_DAYS,
} from "../dashboardOverviewDaily.js";
import {
  getGroupConsolidatedMonthlyPage,
} from "../groupConsolidatedTables.js";
import {
  buildLatestExpenses,
  LATEST_EXPENSES_DEFAULT_LIMIT,
  LATEST_EXPENSES_MAX_LIMIT,
} from "../latestExpenses.js";
import {
  buildGroupFlows,
  parseExtraFlowsFilterParams,
  buildAccountFlows,
  type FlowsFilters,
} from "../flowsApi.js";
import { parsePageParams } from "../pagination.js";
import {
  asyncHandler,
  isKnownClassTabGroup,
  accountIdFromReq,
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

/**
 * Daily series for one group page (`portfolio_group`, incl. liabilities/CC issuer tabs) or
 * one account (`account_id`): per-session bucket points + per-account chart lines for the
 * day period view (chart + detalle por día). Fetched lazily while the D toggle is active.
 */
app.get("/api/daily-series", asyncHandler(async (req, res) => {
  const includeUsd = req.query.include_usd === "1" || req.query.include_usd === "true";
  const unit: TsUnit = includeUsd ? "usd" : "clp";
  // Calendar days back from today; 0 = since portfolio start ("total" range).
  const days = req.query.days != null ? Number(req.query.days) : OVERVIEW_DAILY_DEFAULT_DAYS;
  if (!Number.isInteger(days) || days < 0 || days > DAILY_SERIES_MAX_DAYS) {
    res.status(400).json({ error: `days must be 0..${DAILY_SERIES_MAX_DAYS}` });
    return;
  }
  const portfolioGroup = String(req.query.portfolio_group ?? "").trim();
  const accountIdRaw = req.query.account_id != null ? Number(req.query.account_id) : null;
  // Day-mode P/L combos: the scope's day P/L with its YTD / all-time levels anchored on the
  // scope's own monthly rows (`dailyPerfLevels.ts`), so the client only picks.
  const wantPerfLevels = req.query.perf_levels === "1" || req.query.perf_levels === "true";
  if ((portfolioGroup !== "") === (accountIdRaw != null)) {
    res.status(400).json({ error: "pass exactly one of portfolio_group or account_id" });
    return;
  }
  if (portfolioGroup !== "") {
    const payload = groupDailySeriesResponse(portfolioGroup, unit, days, wantPerfLevels);
    if (!payload) {
      res.status(404).json({ error: `no accounts for group ${portfolioGroup}` });
      return;
    }
    res.json(payload);
    return;
  }
  const accountId = Number(accountIdRaw);
  const row = db
    .prepare(
      `SELECT a.id AS account_id, a.name, g.slug AS bucket_slug, a.import_key
       FROM accounts a JOIN asset_groups g ON g.id = a.asset_group_id WHERE a.id = ?`
    )
    .get(accountId) as
    | { account_id: number; name: string; bucket_slug: string; import_key: string | null }
    | undefined;
  if (!row) {
    res.status(404).json({ error: `account ${accountId} not found` });
    return;
  }
  // Excluded-from-totals accounts still get their own daily series on their page.
  const series = resolveAccountDailySeries(row, unit, days);
  const { deposit_cums_raw: _rawDepsAcct, ...accountSeriesBase } = series;
  const accountSeriesPayload = wantPerfLevels
    ? {
        ...accountSeriesBase,
        perf_levels: dailyPerfLevelsForAccount(accountId, row.bucket_slug, unit, series),
      }
    : accountSeriesBase;
  // Property account page: the monthly block carries synthetic «hipoteca»/«valor» reference
  // lines beside the property line — emit their daily twins (matched by account id in the
  // client's metadata borrow) or the overlays vanish in day mode.
  if (
    accountBucketKindSlug(row.bucket_slug) === "property" &&
    accountSeriesPayload.accounts?.length
  ) {
    const overlays = deptoPropertyChartOverlayDailyLines(
      series.points.map((p) => p.as_of_date),
      unit
    );
    if (overlays.length) {
      accountSeriesPayload.accounts = [...accountSeriesPayload.accounts, ...overlays];
    }
  }
  // CC masters: attach the day-period historial series — owed, plan debt («deuda en cuotas»),
  // the future plan tail (today+1 .. plan end) and the facturación bars on their close dates —
  // so the account page's daily historial has both lines and the bars and covers the same
  // window as its monthly/yearly forms. CLP-native like the chart, so CLP requests only (the
  // client asks for clp explicitly).
  if (accountBucketKindSlug(row.bucket_slug) === "credit_card" && unit === "clp") {
    const ccDaily = ccDailyHistorialBlockForMasters([accountId], series);
    if (ccDaily) {
      res.json({ ...accountSeriesPayload, ...ccDaily });
      return;
    }
  }
  res.json(accountSeriesPayload);
}));

/** Daily net-worth series (one point per NYSE session) for the day period view. */
app.get("/api/dashboard/overview-daily", asyncHandler(async (req, res) => {
  const includeUsd = req.query.include_usd === "1" || req.query.include_usd === "true";
  const days = req.query.days != null ? Number(req.query.days) : OVERVIEW_DAILY_DEFAULT_DAYS;
  if (!Number.isInteger(days) || days < 0 || days > DAILY_SERIES_MAX_DAYS) {
    res.status(400).json({ error: `days must be 0..${DAILY_SERIES_MAX_DAYS}` });
    return;
  }
  res.json(getDashboardOverviewDaily(includeUsd ? "usd" : "clp", days));
}));

/**
 * Home «Δ mensual y depósitos por clase» in day mode: retirement + brokerage day bars, deposits
 * and the YTD / accumulated levels anchored on the monthly inversiones consolidation.
 */
app.get("/api/dashboard/inversiones-perf-daily", asyncHandler(async (req, res) => {
  const includeUsd = req.query.include_usd === "1" || req.query.include_usd === "true";
  const days = req.query.days != null ? Number(req.query.days) : OVERVIEW_DAILY_DEFAULT_DAYS;
  if (!Number.isInteger(days) || days < 0 || days > DAILY_SERIES_MAX_DAYS) {
    res.status(400).json({ error: `days must be 0..${DAILY_SERIES_MAX_DAYS}` });
    return;
  }
  res.json(buildInversionesPerfDaily(includeUsd ? "usd" : "clp", days));
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
    res.json(groupValuationTsResponse(tabSlug, unit));
    return;
  }

  res.json(attachNetWorthAth(attachColorsToValuationPayload(getDashboardValuationTimeseries(unit)), unit));
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
  res.json(groupConsolidatedTablesResponse(tabSlug, unit));
});

/**
 * The Rentabilidad table alone (`{unit, group_slug, period_returns}`; null period_returns for a
 * group without one) — the home dashboard, which does not load the consolidated-tables payload.
 */
app.get("/api/groups/:slug/period-returns", (req, res) => {
  const slug = typeof req.params.slug === "string" ? req.params.slug.trim() : "";
  if (!isKnownClassTabGroup(slug) || !isResolvablePortfolioGroupSlug(slug)) {
    res.status(400).json({ error: "unknown group slug" });
    return;
  }
  const includeUsd = req.query.include_usd === "1" || req.query.include_usd === "true";
  const unit: TsUnit = includeUsd ? "usd" : "clp";
  res.json(groupPeriodReturnsResponse(slug, unit));
});

/** Home «Últimos gastos»: `?limit=` (default 15) newest expense lines, `?unit=clp|usd`. */
app.get("/api/dashboard/latest-expenses", (req, res) => {
  const unitRaw = String(req.query.unit ?? "clp");
  if (unitRaw !== "clp" && unitRaw !== "usd") {
    res.status(400).json({ error: `unit must be clp or usd, got ${unitRaw}` });
    return;
  }
  const limitRaw = req.query.limit == null ? LATEST_EXPENSES_DEFAULT_LIMIT : Number(req.query.limit);
  if (!Number.isInteger(limitRaw) || limitRaw <= 0 || limitRaw > LATEST_EXPENSES_MAX_LIMIT) {
    res.status(400).json({ error: `limit must be an integer 1..${LATEST_EXPENSES_MAX_LIMIT}` });
    return;
  }
  res.json(buildLatestExpenses(unitRaw, limitRaw));
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
  if (typeof req.query.bucket === "string" && req.query.bucket.trim()) filters.bucket = req.query.bucket.trim();
  if (typeof req.query.q === "string" && req.query.q.trim()) filters.q = req.query.q.trim();
  const extra = parseExtraFlowsFilterParams(req.query as Record<string, unknown>);
  if (!extra.ok) {
    res.status(400).json({ error: extra.error });
    return;
  }
  Object.assign(filters, extra.filters);
  const excludeSpending = req.query.exclude_spending === "1" || req.query.exclude_spending === "true";
  res.json(buildGroupFlows(tabSlug, filters, page, pageSize, { excludeSpending }));
});

/** Paginated + filtered flows for a single account (server-side). */
app.get("/api/accounts/:id/flows", (req, res) => {
  const id = accountIdFromReq(req);
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
  const extra = parseExtraFlowsFilterParams(req.query as Record<string, unknown>);
  if (!extra.ok) {
    res.status(400).json({ error: extra.error });
    return;
  }
  Object.assign(filters, extra.filters);
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
  res.json(groupMonthlyPlSeriesResponse(tabSlug, unit));
});

}
