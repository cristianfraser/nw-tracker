/** Home dashboard bundles, valuation timeseries, group tables/flows/performance. Split verbatim from index.ts; paths unchanged. */
import express from "express";
import { isResolvablePortfolioGroupSlug } from "../portfolioGroupTree.js";
import { attachColorsToValuationPayload } from "../chartColorRgb.js";
import {
  groupConsolidatedTablesResponse,
  groupMonthlyPlSeriesResponse,
  groupPeriodReturnsResponse,
  groupValuationTsResponse,
} from "../groupPagePayloads.js";
import { accountDailySeriesResponse, groupDailySeriesResponse } from "../groupDailySeriesResponse.js";
import { attachNetWorthAth } from "../netWorthAllTimeHigh.js";
import {
  getDashboardValuationTimeseries,
} from "../valuationTimeseries.js";
import { buildInversionesPerfDaily } from "../inversionesPerfSeries.js";
import { buildDashboardNavContext, buildDashboardNavSnapshot } from "../dashboardAccounts.js";
import { buildDashboardPageBundle } from "../dashboardPageBundle.js";
import { DAILY_SERIES_MAX_DAYS } from "../dailySeries.js";
import { db } from "../db.js";
import {
  getDashboardOverviewDaily,
  OVERVIEW_DAILY_DEFAULT_DAYS,
} from "../dashboardOverviewDaily.js";
import {
  getGroupConsolidatedMonthlyPage,
} from "../groupConsolidatedTables.js";
import {
  buildLatestMovements,
  LATEST_MOVEMENTS_DEFAULT_LIMIT,
  LATEST_MOVEMENTS_MAX_LIMIT,
} from "../latestMovements.js";
import {
  buildGroupFlows,
  parseExtraFlowsFilterParams,
  buildAccountFlows,
  type FlowsFilters,
} from "../flowsApi.js";
import { parsePageParams } from "../pagination.js";
import {
  createRecurringPayment,
  deleteRecurringPayment,
  listRecurringPayments,
  RecurringPaymentInputError,
} from "../upcomingPayments.js";
import {
  asyncHandler,
  isKnownClassTabGroup,
  accountIdFromReq,
} from "./shared.js";
import { requestDisplayUnit } from "../displayUnits.js";

export function registerDashboardRoutes(app: express.Express): void {
app.get("/api/dashboard/nav-snapshot", asyncHandler(async (req, res) => {
  const unit = requestDisplayUnit(req.query, { surface: "/api/dashboard/nav-snapshot" });
  res.json(await buildDashboardNavSnapshot(unit));
}));

/** Group, Pasivos and account nav strip: account rows, card metrics, the value map. */
app.get("/api/dashboard/nav-context", asyncHandler(async (req, res) => {
  const unit = requestDisplayUnit(req.query, { surface: "/api/dashboard/nav-context" });
  const root = typeof req.query.root === "string" ? req.query.root.trim() : "";
  if (!root) {
    res.status(400).json({ error: "root (the page's nav node slug) is required" });
    return;
  }
  res.json(await buildDashboardNavContext(unit, root));
}));

/** Home dashboard: one response (dash + valuation TS + FX + group perf). */
app.get("/api/dashboard/page-bundle", asyncHandler(async (req, res) => {
  const unit = requestDisplayUnit(req.query, { surface: "/api/dashboard/page-bundle" });
  res.json(await buildDashboardPageBundle(unit));
}));

/**
 * Daily series for one group page (`portfolio_group`, incl. liabilities/CC issuer tabs) or
 * one account (`account_id`): per-session bucket points + per-account chart lines for the
 * day period view (chart + detalle por día). Fetched lazily while the D toggle is active.
 */
app.get("/api/daily-series", asyncHandler(async (req, res) => {
  const unit = requestDisplayUnit(req.query, { surface: "/api/daily-series" });
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
  res.json(accountDailySeriesResponse(row, unit, days, wantPerfLevels));
}));

/** Daily net-worth series (one point per NYSE session) for the day period view. */
app.get("/api/dashboard/overview-daily", asyncHandler(async (req, res) => {
  const unit = requestDisplayUnit(req.query, { surface: "/api/dashboard/overview-daily" });
  const days = req.query.days != null ? Number(req.query.days) : OVERVIEW_DAILY_DEFAULT_DAYS;
  if (!Number.isInteger(days) || days < 0 || days > DAILY_SERIES_MAX_DAYS) {
    res.status(400).json({ error: `days must be 0..${DAILY_SERIES_MAX_DAYS}` });
    return;
  }
  res.json(getDashboardOverviewDaily(unit, days));
}));

/**
 * Home «Δ mensual y depósitos por clase» in day mode: retirement + brokerage day bars, deposits
 * and the YTD / accumulated levels anchored on the monthly inversiones consolidation.
 */
app.get("/api/dashboard/inversiones-perf-daily", asyncHandler(async (req, res) => {
  const unit = requestDisplayUnit(req.query, { surface: "/api/dashboard/inversiones-perf-daily" });
  const days = req.query.days != null ? Number(req.query.days) : OVERVIEW_DAILY_DEFAULT_DAYS;
  if (!Number.isInteger(days) || days < 0 || days > DAILY_SERIES_MAX_DAYS) {
    res.status(400).json({ error: `days must be 0..${DAILY_SERIES_MAX_DAYS}` });
    return;
  }
  res.json(buildInversionesPerfDaily(unit, days));
}));

/**
 * Valuation time series: main dashboard (no `portfolio_group`) or a group page (`portfolio_group=<slug>`).
 * Query: `unit` (any core currency, or `uf`).
 */
app.get("/api/dashboard/valuation-timeseries", (req, res) => {
  const unit = requestDisplayUnit(req.query, { surface: "/api/dashboard/valuation-timeseries", allowUf: true });

  const portfolioGroup =
    typeof req.query.portfolio_group === "string" ? req.query.portfolio_group.trim() : "";
  if (portfolioGroup) {
    if (!isKnownClassTabGroup(portfolioGroup)) {
      res.status(400).json({ error: "unknown group slug" });
      return;
    }
    res.json(groupValuationTsResponse(portfolioGroup, unit));
    return;
  }

  res.json(attachNetWorthAth(attachColorsToValuationPayload(getDashboardValuationTimeseries(unit)), unit));
});

/** Group consolidated tables: per-account monthly perf + movements in one response. */
app.get("/api/groups/:slug/consolidated-tables", (req, res) => {
  const slug = typeof req.params.slug === "string" ? req.params.slug.trim() : "";
  if (!isResolvablePortfolioGroupSlug(slug)) {
    res.status(400).json({ error: "unknown group slug" });
    return;
  }
  const tabSlug = slug;
  const unit = requestDisplayUnit(req.query, { surface: "/api/groups/:slug/consolidated-tables" });
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
  const unit = requestDisplayUnit(req.query, { surface: "/api/groups/:slug/period-returns" });
  res.json(groupPeriodReturnsResponse(slug, unit));
});

/** Home «Últimos gastos»: `?limit=` (default 15) newest expense lines, `?unit=clp|usd`. */
/** Declared yearly payments for «Próximos pagos» (WIP: no screen yet). */
app.get("/api/upcoming-payments/recurring", (_req, res) => {
  res.json({ rows: listRecurringPayments() });
});

app.post("/api/upcoming-payments/recurring", (req, res) => {
  try {
    res.status(201).json(createRecurringPayment((req.body ?? {}) as Record<string, unknown>));
  } catch (e) {
    if (e instanceof RecurringPaymentInputError) {
      res.status(400).json({ error: e.message });
      return;
    }
    throw e;
  }
});

app.delete("/api/upcoming-payments/recurring/:id", (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: "invalid id" });
    return;
  }
  if (!deleteRecurringPayment(id)) {
    res.status(404).json({ error: "not found" });
    return;
  }
  res.status(204).end();
});

app.get("/api/dashboard/latest-movements", (req, res) => {
  const limitRaw = req.query.limit == null ? LATEST_MOVEMENTS_DEFAULT_LIMIT : Number(req.query.limit);
  if (!Number.isInteger(limitRaw) || limitRaw <= 0 || limitRaw > LATEST_MOVEMENTS_MAX_LIMIT) {
    res.status(400).json({ error: `limit must be an integer 1..${LATEST_MOVEMENTS_MAX_LIMIT}` });
    return;
  }
  res.json(buildLatestMovements(limitRaw, requestDisplayUnit(req.query, { surface: "/api/dashboard/latest-movements" })));
});

/** Server-paginated consolidated detalle-por-mes rows (dashboard net_worth table). */
app.get("/api/groups/:slug/consolidated-monthly", (req, res) => {
  const slug = typeof req.params.slug === "string" ? req.params.slug.trim() : "";
  if (!isResolvablePortfolioGroupSlug(slug)) {
    res.status(400).json({ error: "unknown group slug" });
    return;
  }
  const tabSlug = slug;
  const periodRaw = typeof req.query.period === "string" ? req.query.period : "month";
  if (periodRaw !== "month" && periodRaw !== "year") {
    res.status(400).json({ error: "invalid period" });
    return;
  }
  const unit = requestDisplayUnit(req.query, { surface: "/api/groups/:slug/consolidated-monthly" });
  const modeRaw = req.query.installment_mode;
  if (modeRaw != null && modeRaw !== "split" && modeRaw !== "total") {
    res.status(400).json({ error: "installment_mode must be split or total" });
    return;
  }
  const { page, pageSize } = parsePageParams(req.query as Record<string, unknown>, 12);
  res.json(getGroupConsolidatedMonthlyPage(tabSlug, unit, periodRaw, page, pageSize, undefined, modeRaw ?? undefined));
});

/** Paginated + filtered flows for a group (server-side). */
app.get("/api/groups/:slug/flows", (req, res) => {
  const slug = typeof req.params.slug === "string" ? req.params.slug.trim() : "";
  if (!isResolvablePortfolioGroupSlug(slug)) {
    res.status(400).json({ error: "unknown group slug" });
    return;
  }
  const tabSlug = slug;
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
  if (!isResolvablePortfolioGroupSlug(slug)) {
    res.status(400).json({ error: "unknown group slug" });
    return;
  }
  const tabSlug = slug;
  const unit = requestDisplayUnit(req.query, { surface: "/api/groups/:slug/performance-monthly" });
  res.json(groupMonthlyPlSeriesResponse(tabSlug, unit));
});

}
