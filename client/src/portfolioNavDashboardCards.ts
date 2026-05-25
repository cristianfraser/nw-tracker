import { accountCountsTowardGroupTotals, isChartActiveAccount } from "./accountGroupTotals";
import {
  buildBrokerageCardBreakdown,
  cashCardBreakdownFromDash,
  buildLiabilitiesCardBreakdown,
  buildRealEstateCardBreakdown,
  buildRetirementAfpAfcBreakdown,
  buildRetirementApvBreakdown,
  buildRetirementCardBreakdown,
  cardGroupMetricsForAccountSubset,
  cardGroupMetricsForGroup,
  cardGroupMetricsFromAccounts,
  cardGroupTitleBalanceDelta,
  dashboardBucketMainValue,
  subsetTitleBalanceDeltaRounded,
  sumCurrentValueClpUsd,
  type CardBreakdownLine,
  type CardGroupMetrics,
  type CardGroupMetricsPeriod,
  type DashboardGroupSlug,
} from "./dashboardCardBreakdown";
import i18n from "./i18n";
import { liabilitiesSubgroupPath } from "./liabilitiesPath";
import {
  collectNavAccountDataKeys,
  dashboardBucketGroupsUnderNavHub,
  isNavHubNode,
  resolveDashboardBucketFromNavNode,
} from "./portfolioNavFromApi";
import type { DashboardAccountRow, DashboardResponse, NavTreeNodeDto } from "./types";

const CASH_DASHBOARD_CATEGORY_SLUGS = new Set(["fondo_reserva", "cuenta_corriente", "cuenta_vista"]);

/** Nav subtree with optional first-level children removed (e.g. cash → credit card reference link). */
export function navNodeWithoutChildSlugs(
  navNode: NavTreeNodeDto,
  excludeSlugs: ReadonlySet<string>
): NavTreeNodeDto {
  if (!excludeSlugs.size) return navNode;
  return {
    ...navNode,
    children: navNode.children.filter((c) => !excludeSlugs.has(c.slug)),
  };
}

const CASH_NAV_REFERENCE_CHILD_SLUGS = new Set(["liabilities_credit_card"]);

/** Account ids referenced anywhere under `navNode` (including the node itself). */
export function navAccountIdSet(navNode: NavTreeNodeDto): Set<number> {
  const idSet = new Set<number>();
  for (const k of collectNavAccountDataKeys(navNode)) {
    const n = Number(k);
    if (Number.isFinite(n)) idSet.add(n);
  }
  return idSet;
}

/** Cash portfolio node: totals/metrics exclude linked liability reference children. */
export function navNodeForCashAssetTotals(navNode: NavTreeNodeDto): NavTreeNodeDto {
  if (navNode.slug !== "cash_eqs") return navNode;
  return navNodeWithoutChildSlugs(navNode, CASH_NAV_REFERENCE_CHILD_SLUGS);
}

export function dashboardRowsForNavSubtree(
  all: DashboardAccountRow[],
  navNode: NavTreeNodeDto
): DashboardAccountRow[] {
  const idSet = navAccountIdSet(navNode);
  return all.filter((a) => idSet.has(a.account_id) && isChartActiveAccount(a));
}

/**
 * Dashboard rows under a nav child that count toward “material” balance on strips (excludes chart-inactive).
 */
function activeDashboardRowsForStripChild(
  allAccounts: DashboardAccountRow[],
  navChild: NavTreeNodeDto
): DashboardAccountRow[] {
  return dashboardRowsForNavSubtree(allAccounts, navChild);
}

/** True when this nav subtree has a nonzero live balance on non-chart-inactive accounts. */
export function navChildHasMaterialBalanceForStrip(
  navChild: NavTreeNodeDto,
  allAccounts: DashboardAccountRow[],
  showUsd: boolean
): boolean {
  const rows = activeDashboardRowsForStripChild(allAccounts, navChild);
  if (!rows.length) return false;
  if (showUsd) {
    let sum = 0;
    let anyUsd = false;
    for (const r of rows) {
      if (r.current_value_usd != null && Number.isFinite(r.current_value_usd)) {
        sum += r.current_value_usd;
        anyUsd = true;
      }
    }
    return anyUsd && Math.abs(sum) > 1e-9;
  }
  let clp = 0;
  for (const r of rows) {
    if (r.current_value_clp != null && Number.isFinite(r.current_value_clp)) clp += r.current_value_clp;
  }
  return Math.abs(clp) > 1e-9;
}

/** Routable nav children with material balance (entity card strip; hides row when ≤1 child). */
export function filterNavChildrenForEntityStrip(
  navChildren: NavTreeNodeDto[],
  allAccounts: DashboardAccountRow[],
  showUsd: boolean
): NavTreeNodeDto[] {
  const withBalance = navChildren
    .filter((c) => Boolean(c.route_path?.trim()))
    .filter((c) => navChildHasMaterialBalanceForStrip(c, allAccounts, showUsd));
  if (withBalance.length <= 1) return [];
  return withBalance;
}

export type NavChildTitleDeltaModel =
  | { mode: "dashboard_group"; group: DashboardGroupSlug; groupRowFilter?: (a: DashboardAccountRow) => boolean }
  | { mode: "subset" };

export function cashEqsRowFilter(a: DashboardAccountRow): boolean {
  return CASH_DASHBOARD_CATEGORY_SLUGS.has(a.category_slug) && accountCountsTowardGroupTotals(a);
}

/** Optional row filter for dashboard bucket cards (cash excludes savings categories). */
export function dashboardGroupRowFilter(
  group: DashboardGroupSlug
): ((a: DashboardAccountRow) => boolean) | undefined {
  return group === "cash_eqs" ? cashEqsRowFilter : undefined;
}

/** Main balance + deposits/Δ metrics for a nav child card (bucket totals or nav subtree). */
export function mainValueAndMetricsForNavChild(
  dash: Pick<DashboardResponse, "accounts" | "totals">,
  navChild: NavTreeNodeDto,
  metricsPeriod: CardGroupMetricsPeriod,
  showUsd: boolean
): { clp: number; apiUsd: number | null; metrics: CardGroupMetrics } {
  const spec = titleDeltaModelForNavChild(navChild);
  if (spec.mode === "dashboard_group") {
    const groupFilter = spec.groupRowFilter ?? dashboardGroupRowFilter(spec.group);
    return {
      ...dashboardBucketMainValue(dash.totals, spec.group, showUsd),
      metrics: cardGroupMetricsForGroup(dash.accounts, spec.group, metricsPeriod, groupFilter),
    };
  }
  const childRows = dashboardRowsForNavSubtree(dash.accounts, navChild);
  const metricsRows = childRows.filter(
    (a) =>
      accountCountsTowardGroupTotals(a) &&
      a.current_value_clp != null &&
      Number.isFinite(a.current_value_clp)
  );
  return {
    ...sumCurrentValueClpUsd(metricsRows, showUsd),
    metrics: cardGroupMetricsFromAccounts(metricsRows, metricsPeriod),
  };
}

function dashboardGroupTitleDeltaModel(group: DashboardGroupSlug): NavChildTitleDeltaModel {
  return {
    mode: "dashboard_group",
    group,
    ...(group === "cash_eqs" ? { groupRowFilter: cashEqsRowFilter } : {}),
  };
}

/** Title Δ for a strip/detail nav child — driven by `asset_group_slug` and nav subtree. */
export function titleDeltaModelForNavChild(navChild: NavTreeNodeDto): NavChildTitleDeltaModel {
  const bucket = resolveDashboardBucketFromNavNode(navChild);
  if (bucket && bucket !== "net_worth") {
    return dashboardGroupTitleDeltaModel(bucket);
  }
  if (navChild.slug.startsWith("retirement_")) {
    return dashboardGroupTitleDeltaModel("retirement");
  }
  if (navChild.slug.startsWith("brokerage_")) {
    return dashboardGroupTitleDeltaModel("brokerage");
  }
  return { mode: "subset" };
}

export type PortfolioNavParentTitleDeltaMode =
  | { kind: "dashboard_group"; group: DashboardGroupSlug; groupRowFilter?: (a: DashboardAccountRow) => boolean }
  | { kind: "sum_dashboard_groups"; groups: readonly DashboardGroupSlug[] }
  | { kind: "subset_only" };

export function titleBalanceDeltaForAccountIds(
  dash: Pick<DashboardResponse, "accounts" | "totals">,
  overviewPoints: Record<string, string | number | null>[],
  accountIds: Set<number>,
  period: CardGroupMetricsPeriod,
  showUsd: boolean,
  model: NavChildTitleDeltaModel
): number | null {
  const inIds = (a: DashboardAccountRow) => accountIds.has(a.account_id);
  if (model.mode === "dashboard_group") {
    return cardGroupTitleBalanceDelta(
      dash.accounts,
      dash.totals,
      overviewPoints,
      model.group,
      period,
      showUsd,
      (a) => inIds(a) && (!model.groupRowFilter || model.groupRowFilter(a))
    );
  }
  return subsetTitleBalanceDeltaRounded(dash.accounts, period, showUsd, inIds);
}

export function parentTitleBalanceDelta(
  dash: Pick<DashboardResponse, "accounts" | "totals">,
  overviewPoints: Record<string, string | number | null>[],
  accountIds: Set<number>,
  period: CardGroupMetricsPeriod,
  showUsd: boolean,
  mode: PortfolioNavParentTitleDeltaMode
): number | null {
  const inIds = (a: DashboardAccountRow) => accountIds.has(a.account_id);
  if (mode.kind === "dashboard_group") {
    return cardGroupTitleBalanceDelta(
      dash.accounts,
      dash.totals,
      overviewPoints,
      mode.group,
      period,
      showUsd,
      (a) => inIds(a) && (!mode.groupRowFilter || mode.groupRowFilter(a))
    );
  }
  if (mode.kind === "sum_dashboard_groups") {
    let sum = 0;
    let any = false;
    for (const g of mode.groups) {
      const d = cardGroupTitleBalanceDelta(
        dash.accounts,
        dash.totals,
        overviewPoints,
        g,
        period,
        showUsd,
        inIds
      );
      if (d != null && Number.isFinite(d)) {
        sum += d;
        any = true;
      }
    }
    return any ? Math.round(sum) : null;
  }
  return subsetTitleBalanceDeltaRounded(dash.accounts, period, showUsd, inIds);
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

/** Deposits / period Δ metrics aligned with {@link portfolioNavParentMainValue}. */
export function portfolioNavParentMetrics(
  dash: Pick<DashboardResponse, "accounts">,
  mode: PortfolioNavParentTitleDeltaMode,
  navSubtreeRows: DashboardAccountRow[],
  period: CardGroupMetricsPeriod
): CardGroupMetrics {
  if (mode.kind === "dashboard_group") {
    return cardGroupMetricsForGroup(
      dash.accounts,
      mode.group,
      period,
      mode.groupRowFilter
    );
  }
  if (mode.kind === "sum_dashboard_groups") {
    return cardGroupMetricsForAccountSubset(
      dash.accounts,
      period,
      (a) =>
        (mode.groups as readonly string[]).includes(a.group_slug) &&
        accountCountsTowardGroupTotals(a) &&
        a.current_value_clp != null &&
        Number.isFinite(a.current_value_clp)
    );
  }
  return cardGroupMetricsFromAccounts(navSubtreeRows, period);
}

/** Parent title balance Δ mode from the matched nav node (`asset_group_slug`, hub children, or subtree). */
export function portfolioNavParentTitleModeForNavNode(
  node: NavTreeNodeDto | null | undefined
): PortfolioNavParentTitleDeltaMode {
  if (!node) return { kind: "subset_only" };

  const bucket = resolveDashboardBucketFromNavNode(node);
  if (bucket) {
    return {
      kind: "dashboard_group",
      group: bucket,
      ...(bucket === "cash_eqs" ? { groupRowFilter: cashEqsRowFilter } : {}),
    };
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
  "suecia_snapshot" | "liabilities_breakdown" | "cash_credit_card_links"
>;

function breakdownByAssetGroup(
  assetGroup: string,
  rows: DashboardAccountRow[],
  dash: BreakdownDash
): NavChildBreakdownResult | null {
  switch (assetGroup) {
    case "real_estate":
      return { lines: buildRealEstateCardBreakdown(rows, dash.suecia_snapshot ?? null) };
    case "retirement":
      return { lines: buildRetirementCardBreakdown(rows) };
    case "brokerage":
      return { lines: buildBrokerageCardBreakdown(rows) };
    case "cash_eqs": {
      const b = cashCardBreakdownFromDash(rows, dash);
      return { lines: b.lines, bottomLines: b.bottomLines, pinBottom: true };
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
  rows: DashboardAccountRow[],
  dash: BreakdownDash
): NavChildBreakdownResult | null {
  if (slug === "retirement_afp_afc") {
    const lines = buildRetirementAfpAfcBreakdown(rows);
    return lines.length ? { lines } : null;
  }
  if (slug === "retirement_apv") {
    const lines = buildRetirementApvBreakdown(rows);
    return lines.length ? { lines } : null;
  }
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

/** Breakdown lines for a nav child — `asset_group_slug` first, then known subgroup slugs. */
export function breakdownForNavChild(
  navChild: NavTreeNodeDto,
  rows: DashboardAccountRow[],
  dash: BreakdownDash
): NavChildBreakdownResult | null {
  const bySlug = breakdownByNavSlug(navChild.slug, rows, dash);
  if (bySlug) return bySlug;

  const asset = navChild.asset_group_slug;
  if (asset) {
    const byAsset = breakdownByAssetGroup(asset, rows, dash);
    if (byAsset) return byAsset;
  }

  if (navChild.slug.startsWith("retirement_")) {
    return { lines: buildRetirementCardBreakdown(rows) };
  }
  if (navChild.slug.startsWith("brokerage_")) {
    return { lines: buildBrokerageCardBreakdown(rows) };
  }
  if (navChild.slug.startsWith("liabilities_")) {
    return breakdownByAssetGroup("liabilities", rows, dash);
  }

  return null;
}
