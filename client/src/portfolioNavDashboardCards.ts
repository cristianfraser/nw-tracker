import { accountCountsTowardGroupTotals, isChartActiveAccount } from "./accountGroupTotals";
import {
  accountCardTitleBalanceDelta,
  buildCashEqsCardBreakdown,
  buildCashSavingsCardBreakdown,
  buildLiabilitiesCardBreakdown,
  buildRealEstateCardBreakdown,
  dashboardBucketMainValue,
  sumCurrentValueClpUsd,
  type CardBreakdownLine,
  type CardGroupMetrics,
  type CardGroupMetricsPeriod,
  type DashboardGroupSlug,
  isCashSavingsCcShortfallRow,
} from "./dashboardCardBreakdown";
import { buildNavCardBreakdown } from "./navCardBreakdown";
import { dashboardAccountNavLabel } from "./navAccountLabels";
import i18n from "./i18n";
import { liabilitiesSubgroupPath } from "./liabilitiesPath";
import { DASHBOARD_NET_WORTH_BUCKET_SLUGS } from "./portfolioDashboardBuckets";
import { collectNavBucketCoverageKeys } from "./navChartBuckets";
import {
  collectNavAccountDataKeys,
  dashboardBucketGroupsUnderNavHub,
  isNavHubNode,
  portfolioStripGroupChildren,
  resolveDashboardBucketFromNavNode,
} from "./portfolioNavFromApi";
import type {
  DashboardAccountRow,
  DashboardResponse,
  NavCardMetricsDto,
  NavCardMetricsVariantDto,
  NavTreeNodeDto,
} from "./types";

function accountBucketSlug(row: Pick<DashboardAccountRow, "bucket_slug" | "group_slug">): string {
  return (row.bucket_slug ?? row.group_slug ?? "").trim();
}

/**
 * `chart_inactive` accounts omitted from the nav tree still belong in metrics scope when their
 * bucket matches this node (same placement rule as group-page account enrich).
 */
export function accountInNavMetricsScope(
  row: Pick<DashboardAccountRow, "account_id" | "bucket_slug" | "group_slug" | "chart_inactive">,
  navNode: NavTreeNodeDto,
  navLeafIds: Set<number>
): boolean {
  if (navLeafIds.has(row.account_id)) return true;
  if (!row.chart_inactive) return false;
  const bucket = accountBucketSlug(row);
  if (!bucket) return false;
  const normalized = bucket.replace(/__/g, "_");
  if (normalized === navNode.slug) return true;
  for (const prefix of collectNavBucketCoverageKeys(navNode)) {
    if (normalized === prefix || normalized.startsWith(`${prefix}_`)) return true;
    if (bucket === prefix || bucket.startsWith(`${prefix}__`)) return true;
  }
  const asset = navNode.asset_group_slug?.trim();
  if (asset && (bucket === asset || bucket.startsWith(`${asset}__`))) return true;
  return bucket === navNode.slug || bucket.startsWith(`${navNode.slug}__`);
}

/** Nav subtree account ids for card metrics (includes chart-inactive group members). */
export function navMetricsAccountIdSet(
  navNode: NavTreeNodeDto,
  all: readonly Pick<
    DashboardAccountRow,
    "account_id" | "bucket_slug" | "group_slug" | "chart_inactive"
  >[] = []
): Set<number> {
  const leafIds = navLeafAccountIdSet(navNode);
  const ids = new Set(leafIds);
  for (const row of all) {
    if (ids.has(row.account_id)) continue;
    if (accountInNavMetricsScope(row, navNode, leafIds)) ids.add(row.account_id);
  }
  return ids;
}

function isNetWorthPortfolioRoot(node: NavTreeNodeDto): boolean {
  return node.slug === "net_worth" || node.asset_group_slug === "net_worth";
}

/** Account ids referenced anywhere under `navNode` (including the node itself). */
export function navAccountIdSet(navNode: NavTreeNodeDto): Set<number> {
  const idSet = new Set<number>();
  for (const k of collectNavAccountDataKeys(navNode)) {
    const n = Number(k);
    if (Number.isFinite(n)) idSet.add(n);
  }
  return idSet;
}

/**
 * Nav leaf `account_id` values only (not `source_account_id`).
 * Use for dashboard row sums so Pasivos liability_view + master are not double-counted.
 */
/** Account ids under `navNode` marked `chart_inactive` (history charts only). */
export function navChartInactiveAccountIds(navNode: NavTreeNodeDto): Set<number> {
  const ids = new Set<number>();
  const visit = (n: NavTreeNodeDto) => {
    if (n.chart_inactive && n.account_id != null && n.account_id > 0) {
      ids.add(n.account_id);
    }
    for (const c of n.children ?? []) visit(c);
  };
  visit(navNode);
  return ids;
}

export function navLeafAccountIdSet(navNode: NavTreeNodeDto): Set<number> {
  const idSet = new Set<number>();
  const visit = (n: NavTreeNodeDto) => {
    if (n.account_id != null && n.account_id > 0) idSet.add(n.account_id);
    for (const c of n.children ?? []) visit(c);
  };
  visit(navNode);
  return idSet;
}

export function dashboardRowsForNavSubtree(
  all: DashboardAccountRow[],
  navNode: NavTreeNodeDto
): DashboardAccountRow[] {
  const idSet = navMetricsAccountIdSet(navNode, all);
  return all.filter((a) => idSet.has(a.account_id));
}

/** Nav subtree rows visible in breakdown lines (hides chart_inactive + null marks). */
export function dashboardDisplayRowsForNavSubtree(
  all: DashboardAccountRow[],
  navNode: NavTreeNodeDto
): DashboardAccountRow[] {
  return dashboardRowsForNavSubtree(all, navNode).filter((a) => isChartActiveAccount(a));
}

/** Nav children that render as strip cards (balance filtering is server-side on shape APIs). */
export function routableNavStripChildren(navChildren: NavTreeNodeDto[]): NavTreeNodeDto[] {
  return navChildren.filter((c) => Boolean(c.route_path?.trim()));
}

/** Main balance + deposits/Δ metrics for a nav child card (bucket totals or nav subtree). */
function rowsForCashSavingsCard(
  all: DashboardAccountRow[],
  navChild: NavTreeNodeDto
): DashboardAccountRow[] {
  const leafIds = navLeafAccountIdSet(navChild);
  return all.filter((a) => leafIds.has(a.account_id) && !isCashSavingsCcShortfallRow(a));
}

function cashSavingsLinkedBottomLines(
  dash: Pick<DashboardResponse, "dashboard_layout">
): CardBreakdownLine[] | undefined {
  const card =
    dash.dashboard_layout?.find((c) => c.slug === "cash_eqs") ??
    dash.dashboard_layout?.find((c) => c.slug === "cash_savings");
  const linked = card?.linked_balances ?? [];
  if (!linked.length) return undefined;
  return linked.map((lb) => ({
    label: lb.label_i18n_key ? i18n.t(lb.label_i18n_key) : lb.label,
    clp: lb.clp,
    usd: lb.usd ?? null,
    depth: 0,
    to: lb.route_path,
  }));
}

export function stripMetricsRowsForNavChild(
  dash: Pick<DashboardResponse, "accounts">,
  navChild: NavTreeNodeDto
): DashboardAccountRow[] {
  const sourceRows = isCashSavingsNavNode(navChild)
    ? rowsForCashSavingsCard(dash.accounts, navChild)
    : dashboardRowsForNavSubtree(dash.accounts, navChild);
  return sourceRows.filter((a) => accountCountsTowardGroupTotals(a));
}

function usesFullDashboardBucketTotals(navChild: NavTreeNodeDto): DashboardGroupSlug | null {
  const bucket = resolveDashboardBucketFromNavNode(navChild);
  if (!bucket || bucket === "net_worth") return null;
  if (bucket === "cash_eqs") return "cash_eqs";
  if (navChild.slug === bucket) return bucket;
  return null;
}

/**
 * Server card-metrics entry for a nav node — the metrics/title numbers are computed
 * server-side (server/src/dashboardNavCardMetrics.ts) and the client only renders them.
 * Missing entry = payload/tree drift; fail fast rather than silently re-summing rows.
 */
export function requireNavCardMetrics(
  dash: Pick<DashboardResponse, "card_metrics_by_slug">,
  node: NavTreeNodeDto
): NavCardMetricsDto {
  const entry = dash.card_metrics_by_slug?.[node.slug];
  if (!entry) {
    throw new Error(`card_metrics_by_slug has no entry for nav node "${node.slug}"`);
  }
  return entry;
}

function titleDeltaFromVariant(
  variant: NavCardMetricsVariantDto,
  period: CardGroupMetricsPeriod,
  showUsd: boolean
): number | null {
  const t = variant.title_delta;
  if (period === "month") return showUsd ? t.month_usd : t.month_clp;
  return showUsd ? t.year_usd : t.year_clp;
}

/** Title Δ for a nav strip child (server-computed; full bucket totals vs subtree per node). */
export function titleBalanceDeltaForNavChild(
  dash: Pick<DashboardResponse, "card_metrics_by_slug">,
  navChild: NavTreeNodeDto,
  period: CardGroupMetricsPeriod,
  showUsd: boolean
): number | null {
  return titleDeltaFromVariant(requireNavCardMetrics(dash, navChild).child, period, showUsd);
}

export function mainValueAndMetricsForNavChild(
  dash: Pick<DashboardResponse, "accounts" | "totals" | "dashboard_layout" | "card_metrics_by_slug">,
  navChild: NavTreeNodeDto,
  metricsPeriod: CardGroupMetricsPeriod,
  showUsd: boolean
): { clp: number; apiUsd: number | null; metrics: CardGroupMetrics } {
  const entry = requireNavCardMetrics(dash, navChild);
  const metrics = metricsPeriod === "month" ? entry.child.month : entry.child.year;
  const fullBucket = usesFullDashboardBucketTotals(navChild);
  if (fullBucket) {
    return { ...dashboardBucketMainValue(dash.totals, fullBucket, showUsd), metrics };
  }
  const metricsRows = stripMetricsRowsForNavChild(dash, navChild);
  return { ...sumCurrentValueClpUsd(metricsRows, showUsd), metrics };
}

/**
 * Detail card visibility for a `chart_inactive` bucket: render only when the selected period shows
 * activity — nonzero balance, period deposits, or period Δ (monthly view hides a wound-down bucket;
 * yearly view still shows the year it went to zero).
 */
export function navChildCardHasPeriodActivity(
  dash: Pick<DashboardResponse, "accounts" | "totals" | "dashboard_layout" | "card_metrics_by_slug">,
  navChild: NavTreeNodeDto,
  period: CardGroupMetricsPeriod,
  showUsd: boolean
): boolean {
  const { clp, metrics } = mainValueAndMetricsForNavChild(dash, navChild, period, showUsd);
  const titleDelta = titleBalanceDeltaForNavChild(dash, navChild, period, showUsd);
  const material = (v: number | null | undefined) => v != null && Math.abs(v) >= 0.5;
  return (
    material(clp) ||
    material(metrics.deposits_period_clp) ||
    material(metrics.delta_period_clp) ||
    material(titleDelta)
  );
}

/** Same period-activity rule at account-row level (compact account cards). */
export function inactiveAccountRowHasPeriodActivity(
  row: DashboardAccountRow,
  period: CardGroupMetricsPeriod
): boolean {
  const material = (v: number | null | undefined) => v != null && Math.abs(v) >= 0.5;
  const deposits = period === "month" ? row.deposits_month_clp : row.deposits_year_clp;
  const delta = period === "month" ? row.delta_month_clp : row.delta_year_clp;
  return (
    material(row.current_value_clp) ||
    material(deposits) ||
    material(delta) ||
    material(accountCardTitleBalanceDelta(row, period, false))
  );
}

/**
 * Compact cards for `chart_inactive` accounts the nav tree omits: synthesize account leaves for
 * rows in this node's bucket scope when the selected period has activity. Rows already covered by
 * a group-child detail card are skipped (that card carries the activity).
 */
export function inactiveAccountNavLeavesWithPeriodActivity(
  dash: Pick<DashboardResponse, "accounts">,
  parentNavNode: NavTreeNodeDto,
  stripGroupChildren: readonly NavTreeNodeDto[],
  period: CardGroupMetricsPeriod
): NavTreeNodeDto[] {
  const leafIds = navLeafAccountIdSet(parentNavNode);
  const coveredByGroups = new Set<number>();
  for (const g of stripGroupChildren) {
    for (const id of navMetricsAccountIdSet(g, dash.accounts)) coveredByGroups.add(id);
  }
  const out: NavTreeNodeDto[] = [];
  for (const row of dash.accounts) {
    if (row.chart_inactive !== true) continue;
    if (leafIds.has(row.account_id) || coveredByGroups.has(row.account_id)) continue;
    if (!accountInNavMetricsScope(row, parentNavNode, leafIds)) continue;
    if (!inactiveAccountRowHasPeriodActivity(row, period)) continue;
    out.push({
      node_id: `acc.${row.account_id}`,
      slug: `account_${row.account_id}`,
      label: dashboardAccountNavLabel(row),
      label_i18n_key: null,
      route_path: `/account/${row.account_id}`,
      active_prefix: null,
      nav_end: true,
      show_leaf_hyphen: true,
      account_id: row.account_id,
      portfolio_group_id: null,
      source_account_id: null,
      expense_account_id: null,
      expense_account_slug: null,
      asset_group_slug: null,
      kind_slug: null,
      dashboard_bucket_slug: null,
      api_group: null,
      api_subgroup: null,
      color_rgb: null,
      color: null,
      group_kind: "bucket",
      chart_inactive: true,
      children: [],
    });
  }
  return out;
}

export type PortfolioNavParentTitleDeltaMode =
  | { kind: "dashboard_group"; group: DashboardGroupSlug; groupRowFilter?: (a: DashboardAccountRow) => boolean }
  | { kind: "sum_dashboard_groups"; groups: readonly DashboardGroupSlug[] }
  | { kind: "subset_only" };

export type ConsolidatedHubPeriodMetricsSlice = {
  closing_clp: number;
  prior_closing_clp: number | null;
  net_capital_flow_clp: number;
  nominal_pl_clp: number | null;
  balance_delta_clp: number | null;
};

export type InversionesPeriodMetricsDto = {
  month: ConsolidatedHubPeriodMetricsSlice | null;
  year: ConsolidatedHubPeriodMetricsSlice | null;
};

/** Period row from canonical consolidated hub series; lifetime fields come from child buckets. */
export function cardGroupMetricsFromConsolidatedHubPeriodMetrics(
  hubMetrics: InversionesPeriodMetricsDto,
  period: CardGroupMetricsPeriod,
  lifetime: Pick<
    CardGroupMetrics,
    "deposits_clp" | "deposits_usd" | "delta_total_clp" | "delta_total_usd"
  >
): CardGroupMetrics {
  const slice = period === "month" ? hubMetrics.month : hubMetrics.year;
  if (!slice) {
    return {
      ...lifetime,
      deposits_period_clp: 0,
      deposits_period_usd: null,
      delta_period_clp: null,
      delta_period_usd: null,
    };
  }
  return {
    ...lifetime,
    deposits_period_clp: slice.net_capital_flow_clp,
    deposits_period_usd: null,
    delta_period_clp: slice.balance_delta_clp,
    delta_period_usd: null,
  };
}

/** Compact parent card title Δ (server-computed per node; mode logic lives server-side). */
export function parentTitleBalanceDelta(
  dash: Pick<DashboardResponse, "card_metrics_by_slug">,
  parentNavNode: NavTreeNodeDto,
  period: CardGroupMetricsPeriod,
  showUsd: boolean
): number | null {
  return titleDeltaFromVariant(requireNavCardMetrics(dash, parentNavNode).parent, period, showUsd);
}

/**
 * Main balance for portfolio strip compact card: dashboard bucket totals when the page maps to a
 * bucket; otherwise sum of live values under the nav subtree (e.g. Pasivos subset).
 */
export function portfolioNavParentMainValue(
  dash: Pick<DashboardResponse, "totals">,
  mode: PortfolioNavParentTitleDeltaMode,
  navSubtreeRows: DashboardAccountRow[],
  showUsd: boolean
): { clp: number; apiUsd: number | null } {
  if (mode.kind === "dashboard_group") {
    return dashboardBucketMainValue(dash.totals, mode.group, showUsd);
  }
  if (mode.kind === "sum_dashboard_groups") {
    let clp = 0;
    let usd = 0;
    let anyUsd = false;
    for (const g of mode.groups) {
      const part = dashboardBucketMainValue(dash.totals, g, showUsd);
      clp += part.clp;
      if (part.apiUsd != null) {
        usd += part.apiUsd;
        anyUsd = true;
      }
    }
    return { clp, apiUsd: anyUsd ? usd : null };
  }
  return sumCurrentValueClpUsd(navSubtreeRows, showUsd);
}

/** Deposits / period Δ metrics aligned with {@link portfolioNavParentMainValue} (server-computed). */
export function portfolioNavParentMetrics(
  dash: Pick<DashboardResponse, "card_metrics_by_slug">,
  parentNavNode: NavTreeNodeDto,
  period: CardGroupMetricsPeriod
): CardGroupMetrics {
  const variant = requireNavCardMetrics(dash, parentNavNode).parent;
  return period === "month" ? variant.month : variant.year;
}

/** Parent title balance Δ mode from the matched nav node (`asset_group_slug`, hub children, or subtree). */
export function portfolioNavParentTitleModeForNavNode(
  node: NavTreeNodeDto | null | undefined
): PortfolioNavParentTitleDeltaMode {
  if (!node) return { kind: "subset_only" };

  /** Home Patrimonio neto: bucket totals (incl. CC-adjusted cash), not raw account subtree sum. */
  if (isNetWorthPortfolioRoot(node)) {
    return { kind: "sum_dashboard_groups", groups: DASHBOARD_NET_WORTH_BUCKET_SLUGS };
  }

  const bucket = resolveDashboardBucketFromNavNode(node);
  if (bucket) {
    const stripKids = portfolioStripGroupChildren(node);
    /** Portfolio subgroups (APV, AFP) are not separate dashboard buckets — only foreign bucket slugs force subset rollup. */
    const childBuckets = stripKids
      .map((c) => resolveDashboardBucketFromNavNode(c))
      .filter((g): g is DashboardGroupSlug => g != null && g !== "net_worth");
    if (childBuckets.some((g) => g !== bucket)) {
      return { kind: "subset_only" };
    }
    return { kind: "dashboard_group", group: bucket };
  }

  if (isNavHubNode(node)) {
    const groups = dashboardBucketGroupsUnderNavHub(node);
    if (groups.length > 0) return { kind: "sum_dashboard_groups", groups };
  }

  if (node.asset_group_slug === "liabilities" || node.slug.startsWith("liabilities")) {
    return { kind: "subset_only" };
  }

  return { kind: "subset_only" };
}

export type NavChildBreakdownResult = {
  lines: CardBreakdownLine[];
  bottomLines?: CardBreakdownLine[];
  pinBottom?: boolean;
};

type BreakdownDash = Pick<
  DashboardResponse,
  "liabilities_breakdown" | "dashboard_layout"
> &
  Partial<Pick<DashboardResponse, "accounts">>;

function breakdownByAssetGroup(
  assetGroup: string,
  rows: DashboardAccountRow[],
  dash: BreakdownDash
): NavChildBreakdownResult | null {
  switch (assetGroup) {
    case "real_estate":
      return {
        lines: buildRealEstateCardBreakdown(rows, dash.accounts),
      };
    case "cash_eqs": {
      const lines = buildCashEqsCardBreakdown(rows);
      return lines.length ? { lines } : null;
    }
    case "liabilities": {
      const lb = dash.liabilities_breakdown;
      if (!lb) return null;
      return { lines: buildLiabilitiesCardBreakdown(lb) };
    }
    default:
      return null;
  }
}

function breakdownByNavSlug(
  slug: string,
  _rows: DashboardAccountRow[],
  dash: BreakdownDash
): NavChildBreakdownResult | null {
  if (slug === "liabilities_credit_card") {
    const lb = dash.liabilities_breakdown;
    if (!lb || lb.credit_card_clp <= 0) return null;
    return {
      lines: [
        {
          label: i18n.t("liabilities.creditCard"),
          clp: lb.credit_card_clp,
          usd: lb.credit_card_usd ?? null,
          depth: 0,
          to: liabilitiesSubgroupPath("credit_card"),
        },
      ],
    };
  }
  if (slug === "liabilities_mortgage") {
    const lb = dash.liabilities_breakdown;
    if (!lb || lb.mortgage_clp <= 0) return null;
    return {
      lines: [
        {
          label: i18n.t("liabilities.mortgage"),
          clp: lb.mortgage_clp,
          usd: lb.mortgage_usd ?? null,
          depth: 0,
          to: liabilitiesSubgroupPath("mortgage"),
        },
      ],
    };
  }
  return null;
}

export function isCashSavingsNavNode(node: NavTreeNodeDto): boolean {
  if (node.slug === "cash_savings") return true;
  const dash = node.dashboard_bucket_slug?.trim();
  if (dash === "cash_eqs" && node.slug !== "cash_eqs") return true;
  return node.asset_group_slug === "cash_eqs__cash_savings";
}

/** Breakdown lines for a nav child — domain-specific buckets, then nav-tree children. */
export function breakdownForNavChild(
  navChild: NavTreeNodeDto,
  rows: DashboardAccountRow[],
  dash: BreakdownDash
): NavChildBreakdownResult | null {
  const bySlug = breakdownByNavSlug(navChild.slug, rows, dash);
  if (bySlug) return bySlug;

  if (isCashSavingsNavNode(navChild)) {
    const cardRows = rowsForCashSavingsCard(rows, navChild);
    const lines = buildCashSavingsCardBreakdown(cardRows);
    const bottomLines = cashSavingsLinkedBottomLines(dash);
    if (!lines.length && !bottomLines?.length) return null;
    return {
      lines,
      ...(bottomLines?.length ? { bottomLines, pinBottom: true } : {}),
    };
  }

  const bucket = resolveDashboardBucketFromNavNode(navChild);
  if (bucket === "cash_eqs" && navChild.slug === "cash_eqs") {
    const byCash = breakdownByAssetGroup("cash_eqs", rows, dash);
    const bottomLines = cashSavingsLinkedBottomLines(dash);
    if (!byCash?.lines.length && !bottomLines?.length) return null;
    return {
      lines: byCash?.lines ?? [],
      ...(bottomLines?.length ? { bottomLines, pinBottom: true } : {}),
    };
  }

  const asset = navChild.asset_group_slug;
  if (asset === "real_estate" || asset === "liabilities") {
    const byAsset = breakdownByAssetGroup(asset, rows, dash);
    if (byAsset) return byAsset;
  }
  if (navChild.slug.startsWith("liabilities_")) {
    return breakdownByAssetGroup("liabilities", rows, dash);
  }

  const navLines = buildNavCardBreakdown(navChild, rows);
  if (navLines?.length) return { lines: navLines };

  return null;
}
