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
import { collectNavAccountDataKeys } from "./portfolioNavFromApi";
import type { DashboardAccountRow, DashboardResponse, NavTreeNodeDto } from "./types";

const CASH_DASHBOARD_CATEGORY_SLUGS = new Set(["fondo_reserva", "cuenta_corriente"]);

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

/** Routable first-level nav children with material balance (for entity card strips).
 *
 * When only **one** such child remains, row‑2 of the strip would duplicate the compact parent
 * (same subtree totals). We return `[]` in that case.
 *
 * Sidebar subgroups always keep a group node + account leaves (even for a single account), so
 * users can open the group route; this filter avoids duplicating that subtree as a second card.
 */
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

export function titleDeltaModelForNavChildSlug(navChildSlug: string): NavChildTitleDeltaModel {
  if (navChildSlug === "cash_eqs") {
    return {
      mode: "dashboard_group",
      group: "cash_eqs",
      groupRowFilter: (a) =>
        CASH_DASHBOARD_CATEGORY_SLUGS.has(a.category_slug) && accountCountsTowardGroupTotals(a),
    };
  }
  if (navChildSlug === "real_estate") return { mode: "dashboard_group", group: "real_estate" };
  if (navChildSlug === "retirement" || navChildSlug.startsWith("retirement_")) {
    return { mode: "dashboard_group", group: "retirement" };
  }
  if (navChildSlug === "brokerage" || navChildSlug.startsWith("brokerage_")) {
    return { mode: "dashboard_group", group: "brokerage" };
  }
  if (navChildSlug === "liabilities" || navChildSlug.startsWith("liabilities_")) {
    return { mode: "subset" };
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

/** Parent title balance Δ mode from the matched API nav node (Inversiones hub, bucket slugs, or subset). */
export function portfolioNavParentTitleModeForNavNode(
  node: NavTreeNodeDto | null | undefined
): PortfolioNavParentTitleDeltaMode {
  if (!node) return { kind: "subset_only" };
  const slug = node.slug;
  const asset = node.asset_group_slug;
  if (slug === "inversiones") return { kind: "sum_dashboard_groups", groups: ["retirement", "brokerage"] };
  if (slug === "retirement") return { kind: "dashboard_group", group: "retirement" };
  /** Nav sub-routes (AFP+AFC, APV, acciones, …): sum/metrics only accounts in this subtree. */
  if (slug.startsWith("retirement_")) return { kind: "subset_only" };
  if (slug === "brokerage") return { kind: "dashboard_group", group: "brokerage" };
  if (slug.startsWith("brokerage_")) return { kind: "subset_only" };
  if (slug === "real_estate" || asset === "real_estate") {
    return { kind: "dashboard_group", group: "real_estate" };
  }
  if (slug === "cash_eqs" || asset === "cash_eqs") {
    return {
      kind: "dashboard_group",
      group: "cash_eqs",
      groupRowFilter: (a) =>
        CASH_DASHBOARD_CATEGORY_SLUGS.has(a.category_slug) && accountCountsTowardGroupTotals(a),
    };
  }
  if (slug === "liabilities" || asset === "liabilities" || slug.startsWith("liabilities_")) {
    return { kind: "subset_only" };
  }
  return { kind: "subset_only" };
}

export type NavChildBreakdownResult = {
  lines: CardBreakdownLine[];
  bottomLines?: CardBreakdownLine[];
  pinBottom?: boolean;
};

/** Breakdown lines for a first-level nav child under portfolio (retirement, brokerage, etc.). */
export function breakdownForNavChild(
  navChild: NavTreeNodeDto,
  rows: DashboardAccountRow[],
  dash: Pick<DashboardResponse, "suecia_snapshot" | "liabilities_breakdown" | "cash_credit_card_links">
): NavChildBreakdownResult | null {
  const slug = navChild.slug;
  if (slug === "retirement_afp_afc") {
    const lines = buildRetirementAfpAfcBreakdown(rows);
    return lines.length ? { lines } : null;
  }
  if (slug === "retirement_apv") {
    const lines = buildRetirementApvBreakdown(rows);
    return lines.length ? { lines } : null;
  }
  if (slug === "retirement" || slug.startsWith("retirement_")) {
    return { lines: buildRetirementCardBreakdown(rows) };
  }
  if (slug === "brokerage" || slug.startsWith("brokerage_")) {
    return { lines: buildBrokerageCardBreakdown(rows) };
  }
  if (slug === "real_estate") {
    return { lines: buildRealEstateCardBreakdown(rows, dash.suecia_snapshot ?? null) };
  }
  if (slug === "cash_eqs") {
    const b = cashCardBreakdownFromDash(rows, dash);
    return { lines: b.lines, bottomLines: b.bottomLines, pinBottom: true };
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
  if (slug === "liabilities" || slug.startsWith("liabilities_")) {
    const lb = dash.liabilities_breakdown;
    if (!lb) return null;
    return { lines: buildLiabilitiesCardBreakdown(lb) };
  }
  return null;
}
