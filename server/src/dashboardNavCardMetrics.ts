/**
 * Server-side card metrics for the portfolio nav strip (home + group pages).
 *
 * One entry per group node of the net_worth nav tree, keyed by portfolio-group slug, with
 * BOTH consumer variants precomputed:
 *   - `child`:  what `mainValueAndMetricsForNavChild` / `titleBalanceDeltaForNavChild`
 *               showed for the node as a detail card (home second row, group-page children).
 *   - `parent`: what `portfolioNavParentMetrics` / `parentTitleBalanceDelta` showed for the
 *               node as the compact parent card of its own page (incl. the home Patrimonio
 *               neto card = net_worth root).
 *
 * This is a faithful port of the client Σ logic (client/src/dashboardCardBreakdown.ts +
 * portfolioNavDashboardCards.ts as of 2026-07-15) so the client can render precomputed
 * numbers instead of summing server rows — same rationale as groupChartBuckets.ts. The
 * client keeps only single-account projections (compact account cards, account detail).
 */
import type { DashboardAccountStats } from "./brokerageAcciones.js";
import {
  chartBucketGroupChildren as portfolioStripGroupChildren,
  isNavBucketNode,
  resolveDashboardBucketFromNavNode as resolveDashboardBucketSlugFromNavNode,
} from "./groupChartBuckets.js";
import type { NavTreeNodeDto } from "./navTree.js";
import { endChargedFlow, flowAdjustedPct, groupStartFrameFlow, ZERO_CLOSE_EPS } from "./periodReturns.js";
import type { TsUnit } from "./valuationTimeseries.js";

export type CardMetricsPeriod = "day" | "month" | "year";

/** Mirror of the client `CardGroupMetrics` (null-vs-0 semantics preserved exactly). */
export type CardPeriodMetricsDto = {
  deposits_clp: number;
  deposits_usd: number | null;
  delta_total_clp: number | null;
  delta_total_usd: number | null;
  deposits_period_clp: number;
  deposits_period_usd: number | null;
  delta_period_clp: number | null;
  delta_period_usd: number | null;
};

export type NavCardMetricsVariantDto = {
  day: CardPeriodMetricsDto;
  month: CardPeriodMetricsDto;
  year: CardPeriodMetricsDto;
};

/** A flow-adjusted % in both units (null = no capital base, or the unit's legs are missing). */
export type NavCardPctDto = { clp: number | null; usd: number | null };

export type NavCardMetricsDto = {
  child: NavCardMetricsVariantDto;
  parent: NavCardMetricsVariantDto;
  /**
   * The node's return as ONE row of its parent's accounts table (a bucket listed beside
   * accounts — Portafolio IPSA among Acciones' stocks): over the child-variant scope, with
   * each emptied member's withdrawal charged at the period end (`groupStartFrameFlow`).
   */
  row_pct: Record<CardMetricsPeriod | "total", NavCardPctDto>;
  /** The node's own return over the `parent` variant's scope (its page's «Total» row). */
  parent_pct: Record<CardMetricsPeriod | "total", NavCardPctDto>;
  /**
   * The liquidated rows of the node's accounts table, shown as one row: chart-inactive
   * accounts the table lists by themselves and, beside accounts, chart-inactive sub-buckets.
   * Every one that ever held money, whatever the period (the Total column stays complete).
   * Absent when there is none.
   */
  liquidated?: NavLiquidatedRowsDto;
};

export type NavLiquidatedRowsDto = {
  /** Chart-inactive member accounts listed on their own (not under a sub-bucket). */
  account_ids: number[];
  /** Chart-inactive sub-buckets listed beside the node's accounts. */
  group_slugs: string[];
  /** Σ over the rows' accounts (counts-toward-totals only). */
  metrics: NavCardMetricsVariantDto;
  row_pct: Record<CardMetricsPeriod | "total", NavCardPctDto>;
};

/** Narrow row view — the fields card metrics read from `DashboardAccountStats`. */
export type CardMetricsAccountRow = Pick<
  DashboardAccountStats,
  | "account_id"
  | "group_slug"
  | "bucket_slug"
  | "dashboard_bucket_slug"
  | "chart_inactive"
  | "exclude_from_group_totals"
  | "deposits_clp"
  | "deposits_usd"
  | "delta_total_clp"
  | "delta_total_usd"
  | "deposits_month_clp"
  | "deposits_month_usd"
  | "deposits_year_clp"
  | "deposits_year_usd"
  | "deposits_day_clp"
  | "deposits_day_usd"
  | "delta_month_clp"
  | "delta_month_usd"
  | "delta_year_clp"
  | "delta_year_usd"
  | "delta_day_clp"
  | "delta_day_usd"
  | "current_value_clp"
  | "current_value_usd"
  | "prior_day_close_clp"
  | "prior_day_close_usd"
  | "prior_month_close_clp"
  | "prior_month_close_usd"
  | "prior_year_close_clp"
  | "prior_year_close_usd"
>;

const DASHBOARD_NW_BUCKET_SLUGS = ["real_estate", "retirement", "brokerage", "cash_eqs"] as const;
type DashboardNwBucketSlug = (typeof DASHBOARD_NW_BUCKET_SLUGS)[number];

function isDashboardNwBucketSlug(slug: string): slug is DashboardNwBucketSlug {
  return (DASHBOARD_NW_BUCKET_SLUGS as readonly string[]).includes(slug);
}

/* ------------------------------- row predicates ---------------------------------- */

export function accountCountsTowardGroupTotals(row: CardMetricsAccountRow): boolean {
  return row.exclude_from_group_totals !== 1;
}

function accountBelongsToDashboardBucket(row: CardMetricsAccountRow, bucket: string): boolean {
  if (row.dashboard_bucket_slug != null && row.dashboard_bucket_slug !== "") {
    return row.dashboard_bucket_slug === bucket;
  }
  const placement = row.bucket_slug ?? row.group_slug;
  return placement === bucket;
}

/** Bucket-card scope: counts-toward-totals rows in the bucket, or `filter` REPLACING membership. */
function accountInDashboardGroupScope(
  row: CardMetricsAccountRow,
  bucket: DashboardNwBucketSlug,
  filter?: (row: CardMetricsAccountRow) => boolean
): boolean {
  if (!accountCountsTowardGroupTotals(row)) return false;
  if (filter) return filter(row);
  return accountBelongsToDashboardBucket(row, bucket);
}

/* --------------------------------- metric sums ----------------------------------- */

function emptyPeriodMetrics(): CardPeriodMetricsDto {
  return {
    deposits_clp: 0,
    deposits_usd: null,
    delta_total_clp: null,
    delta_total_usd: null,
    deposits_period_clp: 0,
    deposits_period_usd: null,
    delta_period_clp: null,
    delta_period_usd: null,
  };
}

/** Port of client `cardGroupMetricsFromAccounts`. */
export function cardMetricsFromRows(
  rows: readonly CardMetricsAccountRow[],
  period: CardMetricsPeriod
): CardPeriodMetricsDto {
  let deposits_clp = 0;
  let deposits_usd = 0;
  let delta_total_clp = 0;
  let delta_total_usd = 0;
  let deposits_period_clp = 0;
  let deposits_period_usd = 0;
  let delta_period_clp = 0;
  let delta_period_usd = 0;
  let anyUsdDep = false;
  let anyUsdTotalDelta = false;
  let anyUsdPeriodDep = false;
  let anyTotalDelta = false;
  let anyPeriodDeltaClp = false;
  let anyPeriodDeltaUsd = false;

  for (const r of rows) {
    deposits_clp += r.deposits_clp;
    if (r.deposits_usd != null && Number.isFinite(r.deposits_usd)) {
      deposits_usd += r.deposits_usd;
      anyUsdDep = true;
    }
    if (r.delta_total_clp != null && Number.isFinite(r.delta_total_clp)) {
      delta_total_clp += r.delta_total_clp;
      anyTotalDelta = true;
    }
    if (r.delta_total_usd != null && Number.isFinite(r.delta_total_usd)) {
      delta_total_usd += r.delta_total_usd;
      anyUsdTotalDelta = true;
    }

    const periodDepClp =
      period === "month"
        ? r.deposits_month_clp
        : period === "day"
          ? r.deposits_day_clp
          : r.deposits_year_clp;
    if (periodDepClp != null && Number.isFinite(periodDepClp)) {
      deposits_period_clp += periodDepClp;
    }

    const periodDepUsd =
      period === "month"
        ? r.deposits_month_usd
        : period === "day"
          ? r.deposits_day_usd
          : r.deposits_year_usd;
    if (periodDepUsd != null && Number.isFinite(periodDepUsd)) {
      deposits_period_usd += periodDepUsd;
      anyUsdPeriodDep = true;
    }

    const periodDeltaClp =
      period === "month" ? r.delta_month_clp : period === "day" ? r.delta_day_clp : r.delta_year_clp;
    if (periodDeltaClp != null && Number.isFinite(periodDeltaClp)) {
      delta_period_clp += periodDeltaClp;
      anyPeriodDeltaClp = true;
    }
    const periodDeltaUsd =
      period === "month" ? r.delta_month_usd : period === "day" ? r.delta_day_usd : r.delta_year_usd;
    if (periodDeltaUsd != null && Number.isFinite(periodDeltaUsd)) {
      delta_period_usd += periodDeltaUsd;
      anyPeriodDeltaUsd = true;
    }
  }

  return {
    deposits_clp,
    deposits_usd: anyUsdDep ? deposits_usd : null,
    delta_total_clp: anyTotalDelta ? delta_total_clp : null,
    delta_total_usd: anyUsdTotalDelta ? delta_total_usd : null,
    deposits_period_clp,
    deposits_period_usd: anyUsdPeriodDep ? deposits_period_usd : null,
    delta_period_clp: anyPeriodDeltaClp ? delta_period_clp : null,
    delta_period_usd: anyPeriodDeltaUsd ? delta_period_usd : null,
  };
}

/** Port of client `sumCardGroupMetrics`. */
export function sumCardMetrics(parts: readonly CardPeriodMetricsDto[]): CardPeriodMetricsDto {
  if (parts.length === 0) return emptyPeriodMetrics();
  let deposits_clp = 0;
  let deposits_usd = 0;
  let delta_total_clp = 0;
  let delta_total_usd = 0;
  let deposits_period_clp = 0;
  let deposits_period_usd = 0;
  let delta_period_clp = 0;
  let delta_period_usd = 0;
  let anyUsdDep = false;
  let anyUsdTotalDelta = false;
  let anyUsdPeriodDep = false;
  let anyPeriodDelta = false;
  let anyUsdPeriodDelta = false;
  let anyTotalDelta = false;

  for (const m of parts) {
    deposits_clp += m.deposits_clp;
    if (m.deposits_usd != null && Number.isFinite(m.deposits_usd)) {
      deposits_usd += m.deposits_usd;
      anyUsdDep = true;
    }
    if (m.delta_total_clp != null && Number.isFinite(m.delta_total_clp)) {
      delta_total_clp += m.delta_total_clp;
      anyTotalDelta = true;
    }
    if (m.delta_total_usd != null && Number.isFinite(m.delta_total_usd)) {
      delta_total_usd += m.delta_total_usd;
      anyUsdTotalDelta = true;
    }
    deposits_period_clp += m.deposits_period_clp;
    if (m.deposits_period_usd != null && Number.isFinite(m.deposits_period_usd)) {
      deposits_period_usd += m.deposits_period_usd;
      anyUsdPeriodDep = true;
    }
    if (m.delta_period_clp != null && Number.isFinite(m.delta_period_clp)) {
      delta_period_clp += m.delta_period_clp;
      anyPeriodDelta = true;
    }
    if (m.delta_period_usd != null && Number.isFinite(m.delta_period_usd)) {
      delta_period_usd += m.delta_period_usd;
      anyUsdPeriodDelta = true;
    }
  }

  return {
    deposits_clp,
    deposits_usd: anyUsdDep ? deposits_usd : null,
    delta_total_clp: anyTotalDelta ? delta_total_clp : null,
    delta_total_usd: anyUsdTotalDelta ? delta_total_usd : null,
    deposits_period_clp,
    deposits_period_usd: anyUsdPeriodDep ? deposits_period_usd : null,
    delta_period_clp: anyPeriodDelta ? delta_period_clp : null,
    delta_period_usd: anyUsdPeriodDelta ? delta_period_usd : null,
  };
}

/* -------------------------------- bucket metrics ---------------------------------- */


/** Port of client `cardGroupMetricsForDashboardBucket`. */
function bucketCardMetrics(
  rows: readonly CardMetricsAccountRow[],
  bucket: DashboardNwBucketSlug,
  period: CardMetricsPeriod,
  filter?: (row: CardMetricsAccountRow) => boolean
): CardPeriodMetricsDto {
  return cardMetricsFromRows(
    rows.filter((a) => accountInDashboardGroupScope(a, bucket, filter)),
    period
  );
}

/* ------------------------------------ row % ------------------------------------- */

type PctLegs = {
  delta: number | null | undefined;
  prior: number | null | undefined;
  flow: number | null | undefined;
  close: number | null | undefined;
};

/** Group flow-adjusted % over member legs (the account rule, zero closes carried per member). */
function groupPctFromLegs(legs: readonly PctLegs[], withPrior: boolean, unit: TsUnit): number | null {
  if (legs.length === 0) return null;
  let nominal = 0;
  let prior = 0;
  let flow = 0;
  let close = 0;
  let endCharged = 0;
  let anyPrior = false;
  for (const l of legs) {
    // An empty member (no value, no prior value, no flow) has no return to report and no
    // weight in the group's: its missing delta must not blank the whole group's %.
    if (
      l.delta == null &&
      l.close === 0 &&
      (l.prior == null || l.prior === 0) &&
      (l.flow == null || l.flow === 0)
    ) {
      continue;
    }
    if (l.delta == null || !Number.isFinite(l.delta)) return null;
    if (l.close == null || !Number.isFinite(l.close)) return null;
    const f = l.flow != null && Number.isFinite(l.flow) ? l.flow : 0;
    nominal += l.delta;
    close += l.close;
    flow += f;
    endCharged += endChargedFlow(f, l.close, unit);
    if (withPrior && l.prior != null && Number.isFinite(l.prior)) {
      prior += l.prior;
      anyPrior = true;
    }
  }
  return flowAdjustedPct(nominal, anyPrior ? prior : null, groupStartFrameFlow(flow, endCharged), close, unit);
}

export function rowPctForRows(rows: readonly CardMetricsAccountRow[]): NavCardMetricsDto["row_pct"] {
  const both = (clp: PctLegs[], usd: PctLegs[], withPrior: boolean): NavCardPctDto => ({
    clp: groupPctFromLegs(clp, withPrior, "clp"),
    usd: groupPctFromLegs(usd, withPrior, "usd"),
  });
  return {
    day: both(
      rows.map((r) => ({ delta: r.delta_day_clp, prior: r.prior_day_close_clp, flow: r.deposits_day_clp, close: r.current_value_clp })),
      rows.map((r) => ({ delta: r.delta_day_usd, prior: r.prior_day_close_usd, flow: r.deposits_day_usd, close: r.current_value_usd })),
      true
    ),
    month: both(
      rows.map((r) => ({ delta: r.delta_month_clp, prior: r.prior_month_close_clp, flow: r.deposits_month_clp, close: r.current_value_clp })),
      rows.map((r) => ({ delta: r.delta_month_usd, prior: r.prior_month_close_usd, flow: r.deposits_month_usd, close: r.current_value_usd })),
      true
    ),
    year: both(
      rows.map((r) => ({ delta: r.delta_year_clp, prior: r.prior_year_close_clp, flow: r.deposits_year_clp, close: r.current_value_clp })),
      rows.map((r) => ({ delta: r.delta_year_usd, prior: r.prior_year_close_usd, flow: r.deposits_year_usd, close: r.current_value_usd })),
      true
    ),
    total: both(
      rows.map((r) => ({ delta: r.delta_total_clp, prior: null, flow: r.deposits_clp, close: r.current_value_clp })),
      rows.map((r) => ({ delta: r.delta_total_usd, prior: null, flow: r.deposits_usd, close: r.current_value_usd })),
      false
    ),
  };
}

/* ------------------------------- nav-node helpers --------------------------------- */

function isNetWorthPortfolioRoot(node: NavTreeNodeDto): boolean {
  return node.slug === "net_worth" || node.asset_group_slug === "net_worth";
}

/** Shared walk's resolver, narrowed to the typed bucket slugs this module works with. */
function resolveDashboardBucketFromNavNode(node: NavTreeNodeDto): DashboardNwBucketSlug | null {
  const slug = resolveDashboardBucketSlugFromNavNode(node);
  return slug != null && isDashboardNwBucketSlug(slug) ? slug : null;
}

/** Port of client `usesFullDashboardBucketTotals`. */
function usesFullDashboardBucketTotals(node: NavTreeNodeDto): DashboardNwBucketSlug | null {
  const bucket = resolveDashboardBucketFromNavNode(node);
  if (!bucket) return null;
  if (bucket === "cash_eqs") return "cash_eqs";
  if (node.slug === bucket) return bucket;
  return null;
}

/** Port of client `isCashSavingsNavNode`. */
export function isCashSavingsNavNode(node: NavTreeNodeDto): boolean {
  if (node.slug === "cash_savings") return true;
  const dash = node.dashboard_bucket_slug?.trim();
  if (dash === "cash_eqs" && node.slug !== "cash_eqs") return true;
  return node.asset_group_slug === "cash_eqs__cash_savings";
}

/** Port of client `dashboardBucketGroupsUnderNavHub`. */
function dashboardBucketGroupsUnderNavHub(node: NavTreeNodeDto): DashboardNwBucketSlug[] {
  const out: DashboardNwBucketSlug[] = [];
  for (const child of portfolioStripGroupChildren(node)) {
    const g = resolveDashboardBucketFromNavNode(child);
    if (g) out.push(g);
  }
  return out;
}

export function navLeafAccountIdSet(node: NavTreeNodeDto): Set<number> {
  const idSet = new Set<number>();
  const visit = (n: NavTreeNodeDto) => {
    if (n.account_id != null && n.account_id > 0) idSet.add(n.account_id);
    for (const c of n.children ?? []) visit(c);
  };
  visit(node);
  return idSet;
}

/**
 * Port of client `navMetricsAccountIdSet`: the accounts a group node's metrics cover — its nav
 * leaves plus every `member_account_ids` entry in its subtree (the chart-inactive members the
 * sidebar tree omits, which an all-inactive sub-bucket keeps only there).
 */
export function navMetricsAccountIdSet(node: NavTreeNodeDto): Set<number> {
  const ids = navLeafAccountIdSet(node);
  const visit = (n: NavTreeNodeDto) => {
    for (const id of n.member_account_ids ?? []) ids.add(id);
    for (const c of n.children ?? []) visit(c);
  };
  visit(node);
  return ids;
}

type ParentTitleDeltaMode =
  | { kind: "dashboard_group"; group: DashboardNwBucketSlug }
  | { kind: "sum_dashboard_groups"; groups: readonly DashboardNwBucketSlug[] }
  | { kind: "subset_only" };

/** Port of client `portfolioNavParentTitleModeForNavNode`. */
function parentTitleModeForNavNode(node: NavTreeNodeDto): ParentTitleDeltaMode {
  if (isNetWorthPortfolioRoot(node)) {
    return { kind: "sum_dashboard_groups", groups: DASHBOARD_NW_BUCKET_SLUGS };
  }
  const bucket = resolveDashboardBucketFromNavNode(node);
  if (bucket) {
    const stripKids = portfolioStripGroupChildren(node);
    const childBuckets = stripKids
      .map((c) => resolveDashboardBucketFromNavNode(c))
      .filter((g): g is DashboardNwBucketSlug => g != null);
    if (childBuckets.some((g) => g !== bucket)) {
      return { kind: "subset_only" };
    }
    return { kind: "dashboard_group", group: bucket };
  }
  if (isNavBucketNode(node)) {
    const groups = dashboardBucketGroupsUnderNavHub(node);
    if (groups.length > 0) return { kind: "sum_dashboard_groups", groups };
  }
  return { kind: "subset_only" };
}

/* ------------------------------- table row sets ----------------------------------- */

function material(v: number | null | undefined): boolean {
  return v != null && Number.isFinite(v) && Math.abs(v) >= 0.5;
}

/** A chart-inactive account that once held money (never-funded accounts are not liquidated). */
function accountWasLiquidated(row: CardMetricsAccountRow): boolean {
  return (
    row.chart_inactive === true &&
    (material(row.deposits_clp) || material(row.delta_total_clp) || material(row.current_value_clp))
  );
}

/**
 * The rows the client's accounts table groups as «Liquidadas» for `node`: the chart-inactive
 * member accounts no nav leaf or sub-bucket of the node lists, plus — when the table lists
 * sub-buckets beside accounts — its chart-inactive sub-buckets.
 */
export function liquidatedRowsForNode(
  node: NavTreeNodeDto,
  rows: readonly CardMetricsAccountRow[],
  chainedGroupPct?: ChainedGroupPct
): NavLiquidatedRowsDto | null {
  const children = node.children ?? [];
  const accountChildren = children.filter(
    (c) => c.account_id != null && c.account_id > 0 && Boolean(c.route_path?.trim())
  );
  const groupChildren = children.filter(
    (c) => c.account_id == null && c.expense_account_id == null
  );
  const groupsAsRows = accountChildren.length > 0 && groupChildren.length > 0;
  const inactiveGroups = groupsAsRows
    ? groupChildren.filter((c) => c.chart_inactive === true && Boolean(c.route_path?.trim()))
    : [];

  const leafIds = navLeafAccountIdSet(node);
  const memberIds = navMetricsAccountIdSet(node);
  const covered = new Set<number>();
  for (const g of groupChildren) for (const id of navMetricsAccountIdSet(g)) covered.add(id);

  const accountRows = rows
    .filter(
      (r) =>
        memberIds.has(r.account_id) &&
        !leafIds.has(r.account_id) &&
        !covered.has(r.account_id) &&
        accountWasLiquidated(r)
    )
    .sort((a, b) => a.account_id - b.account_id);

  if (accountRows.length === 0 && inactiveGroups.length === 0) return null;

  const byId = new Map<number, CardMetricsAccountRow>();
  for (const r of accountRows) {
    if (accountCountsTowardGroupTotals(r)) byId.set(r.account_id, r);
  }
  for (const g of inactiveGroups) {
    for (const r of stripMetricsRows(g, rows)) byId.set(r.account_id, r);
  }
  const metricsRows = [...byId.values()];
  const metrics: NavCardMetricsVariantDto = {
    day: cardMetricsFromRows(metricsRows, "day"),
    month: cardMetricsFromRows(metricsRows, "month"),
    year: cardMetricsFromRows(metricsRows, "year"),
  };
  const accountIds = metricsRows.map((r) => r.account_id).sort((a, b) => a - b);
  return {
    account_ids: accountRows.map((r) => r.account_id),
    group_slugs: inactiveGroups.map((g) => g.slug),
    metrics,
    row_pct: fillBlankGroupPct(
      rowPctForRows(metricsRows),
      metrics,
      metricsRows,
      { kind: "liquidated", parentSlug: node.slug, accountIds },
      chainedGroupPct
    ),
  };
}

/** The rows the `parent` variant sums, for its % (a hub's: every counted member). */
function parentScopeRows(
  node: NavTreeNodeDto,
  rows: readonly CardMetricsAccountRow[]
): CardMetricsAccountRow[] {
  const mode = parentTitleModeForNavNode(node);
  const subtreeIds = navMetricsAccountIdSet(node);
  if (mode.kind === "dashboard_group") {
    return rows.filter((a) =>
      accountInDashboardGroupScope(a, mode.group, (r) => subtreeIds.has(r.account_id))
    );
  }
  if (mode.kind === "sum_dashboard_groups") {
    return rows.filter((a) => subtreeIds.has(a.account_id) && accountCountsTowardGroupTotals(a));
  }
  return rows.filter((a) => subtreeIds.has(a.account_id));
}

/* ----------------------------------- builder -------------------------------------- */

export type NavCardMetricsBuildInput = {
  /**
   * Nav roots whose group nodes get entries — the net_worth portfolio tree plus the Pasivos
   * root (whose DB-driven `liability_groups` children are NOT part of the net_worth tree).
   * Later roots override earlier ones on slug collision: both trees carry a `liabilities`
   * node, and the Pasivos-root version (with liability children) is the one its page renders.
   */
  navRoots: readonly NavTreeNodeDto[];
  rows: readonly CardMetricsAccountRow[];
  /**
   * Daily-chained % for a group cell the one-step rule leaves blank (a position bought and
   * sold inside the period: see `blankPctDailyChain.ts`) — the group's own daily series, or
   * the series over a page's liquidated rows. Absent (tests, pure callers): left blank.
   */
  chainedGroupPct?: ChainedGroupPct;
};

export type ChainedGroupScope =
  | { kind: "group"; slug: string }
  | { kind: "liquidated"; parentSlug: string; accountIds: readonly number[] };

export type ChainedGroupPct = (
  scope: ChainedGroupScope,
  period: CardMetricsPeriod | "total",
  unit: TsUnit
) => number | null;

/** Σ value of `rows` at the period's close and at its start (null start for Total). */
function scopeEnds(
  rows: readonly CardMetricsAccountRow[],
  period: CardMetricsPeriod | "total",
  unit: TsUnit
): { close: number; prior: number | null } {
  let close = 0;
  let prior = 0;
  for (const r of rows) {
    const c = unit === "clp" ? r.current_value_clp : r.current_value_usd;
    if (c != null && Number.isFinite(c)) close += c;
    if (period === "total") continue;
    const p =
      period === "day"
        ? unit === "clp" ? r.prior_day_close_clp : r.prior_day_close_usd
        : period === "month"
          ? unit === "clp" ? r.prior_month_close_clp : r.prior_month_close_usd
          : unit === "clp" ? r.prior_year_close_clp : r.prior_year_close_usd;
    if (p != null && Number.isFinite(p)) prior += p;
  }
  return { close, prior: period === "total" ? null : prior };
}

/**
 * `pct` with each blank cell filled by `chained` when the period's P/L is material and the
 * scope is empty at both ends (bought and sold inside the period: no capital base for the
 * one-step rule). A blank for any other reason, and every answered cell, is left alone.
 */
export function fillBlankGroupPct(
  pct: NavCardMetricsDto["row_pct"],
  metrics: NavCardMetricsVariantDto,
  scopeRows: readonly CardMetricsAccountRow[],
  scope: ChainedGroupScope,
  chained: ChainedGroupPct | undefined
): NavCardMetricsDto["row_pct"] {
  if (!chained) return pct;
  const out = { ...pct };
  for (const period of ["day", "month", "year", "total"] as const) {
    const cell = { ...pct[period] };
    for (const unit of ["clp", "usd"] as const) {
      if (cell[unit] != null) continue;
      const m = period === "total" ? metrics.month : metrics[period];
      const delta =
        period === "total"
          ? unit === "clp" ? m.delta_total_clp : m.delta_total_usd
          : unit === "clp" ? m.delta_period_clp : m.delta_period_usd;
      if (delta == null || !Number.isFinite(delta) || Math.abs(delta) < 0.5) continue;
      const ends = scopeEnds(scopeRows, period, unit);
      const eps = ZERO_CLOSE_EPS[unit];
      if (Math.abs(ends.close) > eps || (ends.prior != null && Math.abs(ends.prior) > eps)) continue;
      cell[unit] = chained(scope, period, unit);
    }
    out[period] = cell;
  }
  return out;
}

/** Port of client `stripMetricsRowsForNavChild` (cash-savings node uses raw leaf ids). */
export function stripMetricsRows(
  node: NavTreeNodeDto,
  rows: readonly CardMetricsAccountRow[]
): CardMetricsAccountRow[] {
  const source = isCashSavingsNavNode(node)
    ? (() => {
        const leafIds = navLeafAccountIdSet(node);
        return rows.filter((a) => leafIds.has(a.account_id));
      })()
    : (() => {
        const ids = navMetricsAccountIdSet(node);
        return rows.filter((a) => ids.has(a.account_id));
      })();
  return source.filter((a) => accountCountsTowardGroupTotals(a));
}

function childVariantForNode(
  node: NavTreeNodeDto,
  input: NavCardMetricsBuildInput
): NavCardMetricsVariantDto {
  const { rows } = input;
  const metricsRows = stripMetricsRows(node, rows);
  const fullBucket = usesFullDashboardBucketTotals(node);

  const metricsFor = (period: CardMetricsPeriod): CardPeriodMetricsDto =>
    fullBucket ? bucketCardMetrics(rows, fullBucket, period) : cardMetricsFromRows(metricsRows, period);

  return {
    day: metricsFor("day"),
    month: metricsFor("month"),
    year: metricsFor("year"),
  };
}

function parentVariantForNode(
  node: NavTreeNodeDto,
  input: NavCardMetricsBuildInput,
  childVariantBySlug: Map<string, NavCardMetricsVariantDto>
): NavCardMetricsVariantDto {
  const { rows } = input;
  const mode = parentTitleModeForNavNode(node);
  const subtreeIds = navMetricsAccountIdSet(node);
  const subtreeRows = rows.filter((a) => subtreeIds.has(a.account_id));

  const childMetricsOfStripChildren = (period: CardMetricsPeriod): CardPeriodMetricsDto[] => {
    const stripChildren = portfolioStripGroupChildren(node);
    if (stripChildren.length === 0) {
      throw new Error(`nav card metrics: no strip children under nav node ${node.slug}`);
    }
    return stripChildren.map((child) => {
      const v = childVariantBySlug.get(child.slug) ?? childVariantForNode(child, input);
      return period === "month" ? v.month : period === "day" ? v.day : v.year;
    });
  };

  const metricsFor = (period: CardMetricsPeriod): CardPeriodMetricsDto => {
    if (mode.kind === "dashboard_group") {
      return bucketCardMetrics(rows, mode.group, period, (a) => subtreeIds.has(a.account_id));
    }
    if (mode.kind === "sum_dashboard_groups") {
      return sumCardMetrics(childMetricsOfStripChildren(period));
    }
    return cardMetricsFromRows(subtreeRows, period);
  };

  return {
    day: metricsFor("day"),
    month: metricsFor("month"),
    year: metricsFor("year"),
  };
}

/**
 * Metrics for every group node of the given nav roots (roots included), keyed by slug.
 * Account leaves are skipped — compact account cards are single-row projections the client
 * keeps computing from its row. Each root is processed with its own child-variant map so a
 * slug shared across trees (e.g. `liabilities`) always composes from its own tree's children.
 */
export function buildNavCardMetricsBySlug(
  input: NavCardMetricsBuildInput
): Record<string, NavCardMetricsDto> {
  const out: Record<string, NavCardMetricsDto> = {};
  for (const navRoot of input.navRoots) {
    const groupNodes: NavTreeNodeDto[] = [];
    const visit = (n: NavTreeNodeDto) => {
      if (n.account_id == null && n.expense_account_id == null) groupNodes.push(n);
      for (const c of n.children ?? []) visit(c);
    };
    visit(navRoot);

    const childBySlug = new Map<string, NavCardMetricsVariantDto>();
    for (const node of groupNodes) {
      childBySlug.set(node.slug, childVariantForNode(node, input));
    }

    for (const node of groupNodes) {
      const liquidated = liquidatedRowsForNode(node, input.rows, input.chainedGroupPct);
      const child = childBySlug.get(node.slug)!;
      const parent = parentVariantForNode(node, input, childBySlug);
      const scope: ChainedGroupScope = { kind: "group", slug: node.slug };
      const childRows = stripMetricsRows(node, input.rows);
      const parentRows = parentScopeRows(node, input.rows);
      out[node.slug] = {
        child,
        parent,
        row_pct: fillBlankGroupPct(rowPctForRows(childRows), child, childRows, scope, input.chainedGroupPct),
        parent_pct: fillBlankGroupPct(
          rowPctForRows(parentRows),
          parent,
          parentRows,
          scope,
          input.chainedGroupPct
        ),
        ...(liquidated ? { liquidated } : {}),
      };
    }
  }
  return out;
}
