import {
  buildBrokerageCardBreakdown,
  buildCashCardBreakdown,
  buildLiabilitiesCardBreakdown,
  buildRealEstateCardBreakdown,
  buildRetirementCardBreakdown,
  cardGroupTitleBalanceDelta,
  subsetTitleBalanceDeltaRounded,
  type CardBreakdownLine,
  type CardGroupMetricsPeriod,
  type DashboardGroupSlug,
} from "./dashboardCardBreakdown";
import { collectNavAccountDataKeys } from "./portfolioNavFromApi";
import type { AssetGroupSlug, DashboardAccountRow, DashboardResponse, NavTreeNodeDto } from "./types";

const CASH_DASHBOARD_CATEGORY_SLUGS = new Set(["fondo_reserva", "cuenta_corriente"]);

/** Account ids referenced anywhere under `navNode` (including the node itself). */
export function navAccountIdSet(navNode: NavTreeNodeDto): Set<number> {
  const idSet = new Set<number>();
  for (const k of collectNavAccountDataKeys(navNode)) {
    const n = Number(k);
    if (Number.isFinite(n)) idSet.add(n);
  }
  return idSet;
}

export function dashboardRowsForNavSubtree(
  all: DashboardAccountRow[],
  navNode: NavTreeNodeDto
): DashboardAccountRow[] {
  const idSet = navAccountIdSet(navNode);
  return all.filter((a) => idSet.has(a.account_id));
}

/**
 * Dashboard rows under a nav child that count toward “material” balance on strips (excludes chart-inactive).
 */
function activeDashboardRowsForStripChild(
  allAccounts: DashboardAccountRow[],
  navChild: NavTreeNodeDto
): DashboardAccountRow[] {
  return dashboardRowsForNavSubtree(allAccounts, navChild).filter((r) => r.chart_inactive !== true);
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
      groupRowFilter: (a) => CASH_DASHBOARD_CATEGORY_SLUGS.has(a.category_slug),
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

/** Maps asset-class page slug to the same title-Δ rules as dashboard buckets where applicable. */
export function assetGroupPageParentTitleMode(slug: AssetGroupSlug): PortfolioNavParentTitleDeltaMode {
  if (slug === "real_estate") return { kind: "dashboard_group", group: "real_estate" };
  if (slug === "cash_eqs") {
    return {
      kind: "dashboard_group",
      group: "cash_eqs",
      groupRowFilter: (a) => CASH_DASHBOARD_CATEGORY_SLUGS.has(a.category_slug),
    };
  }
  if (slug === "liabilities") return { kind: "subset_only" };
  if (slug === "retirement") return { kind: "dashboard_group", group: "retirement" };
  if (slug === "brokerage" || slug === "crypto") return { kind: "dashboard_group", group: "brokerage" };
  if (slug === "inversiones") return { kind: "sum_dashboard_groups", groups: ["retirement", "brokerage"] };
  return { kind: "subset_only" };
}

/** Parent title balance Δ mode from the matched API nav node (Inversiones hub, bucket slugs, or subset). */
export function portfolioNavParentTitleModeForNavNode(
  node: NavTreeNodeDto | null | undefined
): PortfolioNavParentTitleDeltaMode {
  if (!node) return { kind: "subset_only" };
  const slug = node.slug;
  if (slug === "inversiones") return { kind: "sum_dashboard_groups", groups: ["retirement", "brokerage"] };
  if (slug === "retirement" || slug.startsWith("retirement_")) {
    return { kind: "dashboard_group", group: "retirement" };
  }
  if (slug === "brokerage" || slug.startsWith("brokerage_")) {
    return { kind: "dashboard_group", group: "brokerage" };
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
  dash: Pick<DashboardResponse, "suecia_snapshot" | "liabilities_breakdown">
): NavChildBreakdownResult | null {
  const slug = navChild.slug;
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
    const cc = dash.liabilities_breakdown;
    const b = buildCashCardBreakdown(
      rows,
      cc ? { clp: cc.credit_card_clp, usd: cc.credit_card_usd ?? null } : null
    );
    return { lines: b.lines, bottomLines: b.bottomLines, pinBottom: true };
  }
  if (slug === "liabilities" || slug.startsWith("liabilities_")) {
    const lb = dash.liabilities_breakdown;
    if (!lb) return null;
    return { lines: buildLiabilitiesCardBreakdown(lb) };
  }
  return null;
}
