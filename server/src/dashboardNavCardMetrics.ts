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
import { endChargedFlow, flowAdjustedPct, groupStartFrameFlow } from "./periodReturns.js";
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

function accountCountsTowardGroupTotals(row: CardMetricsAccountRow): boolean {
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

function rowPctForRows(rows: readonly CardMetricsAccountRow[]): NavCardMetricsDto["row_pct"] {
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
function isCashSavingsNavNode(node: NavTreeNodeDto): boolean {
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

function navLeafAccountIdSet(node: NavTreeNodeDto): Set<number> {
  const idSet = new Set<number>();
  const visit = (n: NavTreeNodeDto) => {
    if (n.account_id != null && n.account_id > 0) idSet.add(n.account_id);
    for (const c of n.children ?? []) visit(c);
  };
  visit(node);
  return idSet;
}

/** Port of client `collectNavBucketCoverageKeys` (group nodes only). */
function collectNavBucketCoverageKeys(node: NavTreeNodeDto): string[] {
  const keys = new Set<string>();
  const visit = (n: NavTreeNodeDto) => {
    keys.add(n.slug);
    const ag = n.asset_group_slug?.trim();
    if (ag) keys.add(ag);
    for (const c of n.children ?? []) {
      if (c.account_id == null) visit(c);
    }
  };
  visit(node);
  return [...keys];
}

function accountBucketSlug(row: CardMetricsAccountRow): string {
  return (row.bucket_slug ?? row.group_slug ?? "").trim();
}

/** Port of client `accountInNavMetricsScope` (chart-inactive bucket members outside the tree). */
function accountInNavMetricsScope(
  row: CardMetricsAccountRow,
  node: NavTreeNodeDto,
  navLeafIds: Set<number>
): boolean {
  if (navLeafIds.has(row.account_id)) return true;
  if (!row.chart_inactive) return false;
  const bucket = accountBucketSlug(row);
  if (!bucket) return false;
  const normalized = bucket.replace(/__/g, "_");
  if (normalized === node.slug) return true;
  for (const prefix of collectNavBucketCoverageKeys(node)) {
    if (normalized === prefix || normalized.startsWith(`${prefix}_`)) return true;
    if (bucket === prefix || bucket.startsWith(`${prefix}__`)) return true;
  }
  const asset = node.asset_group_slug?.trim();
  if (asset && (bucket === asset || bucket.startsWith(`${asset}__`))) return true;
  return bucket === node.slug || bucket.startsWith(`${node.slug}__`);
}

/** Port of client `navMetricsAccountIdSet`. */
function navMetricsAccountIdSet(
  node: NavTreeNodeDto,
  rows: readonly CardMetricsAccountRow[]
): Set<number> {
  const leafIds = navLeafAccountIdSet(node);
  const ids = new Set(leafIds);
  for (const row of rows) {
    if (ids.has(row.account_id)) continue;
    if (accountInNavMetricsScope(row, node, leafIds)) ids.add(row.account_id);
  }
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
};

/** Port of client `stripMetricsRowsForNavChild` (cash-savings node uses raw leaf ids). */
function stripMetricsRows(
  node: NavTreeNodeDto,
  rows: readonly CardMetricsAccountRow[]
): CardMetricsAccountRow[] {
  const source = isCashSavingsNavNode(node)
    ? (() => {
        const leafIds = navLeafAccountIdSet(node);
        return rows.filter((a) => leafIds.has(a.account_id));
      })()
    : (() => {
        const ids = navMetricsAccountIdSet(node, rows);
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
  const subtreeIds = navMetricsAccountIdSet(node, rows);
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
      out[node.slug] = {
        child: childBySlug.get(node.slug)!,
        parent: parentVariantForNode(node, input, childBySlug),
        row_pct: rowPctForRows(stripMetricsRows(node, input.rows)),
      };
    }
  }
  return out;
}
