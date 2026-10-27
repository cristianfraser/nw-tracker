import { useMemo } from "react";
import { CardValueDayPl, DashboardCardGroupMetrics } from "./DashboardCardGroupMetrics";
import { CompactEntityCard } from "./CompactEntityCard";
import { PortfolioEntityCardsStrip } from "./PortfolioEntityCardsStrip";
import { PortfolioNavAccountsSummaryTable } from "./PortfolioNavAccountsSummaryTable";
import { PortfolioNavChildDetailCards } from "./PortfolioNavChildDetailCards";
import {
  dashboardRowsForNavSubtree,
  inactiveAccountNavLeaf,
  navChildCardHasActivity,
  routableNavStripChildren,
  portfolioNavParentMainValue,
  portfolioNavParentTitleModeForNavNode,
  requireNavCardMetrics,
} from "../../portfolioNavDashboardCards";
import {
  portfolioStripAccountChildren,
  portfolioStripGroupChildren,
  portfolioStripSummaryHubs,
} from "../../portfolioNavFromApi";
import { resolveNavTreeLabel } from "../../sidebarNavFromApi";
import type { DashboardResponse, NavTreeNodeDto } from "../../types";

type StripDash = Pick<
  DashboardResponse,
  "accounts" | "totals" | "liabilities_breakdown" | "dashboard_layout" | "card_metrics_by_slug"
>;

export type PortfolioNavEntityCardsStripProps = {
  dash: StripDash;
  parentNavNode: NavTreeNodeDto;
  showUsd: boolean;
  animated?: boolean;
  /** Nodes for `parentNavNode.linked_card_slugs`, resolved by the page against the sidebar nav. */
  linkedCardNavChildren?: NavTreeNodeDto[];
};

type NavSummaryCardProps = {
  dash: StripDash;
  node: NavTreeNodeDto;
  label?: string;
  to?: string;
  showUsd: boolean;
  animated: boolean;
};

/**
 * A nav node's own summary card: the hero on the node's page, and a spread hub's card beside
 * the hero on its parent's page — one rendering, so both show the same numbers.
 */
function NavSummaryCard({
  dash,
  node,
  label,
  to,
  showUsd,
  animated,
}: NavSummaryCardProps) {
  const totals = portfolioNavParentMainValue(
    dash,
    portfolioNavParentTitleModeForNavNode(node),
    dashboardRowsForNavSubtree(dash.accounts, node),
    showUsd
  );
  const metricsByPeriod = requireNavCardMetrics(dash, node).parent;
  return (
    <CompactEntityCard
      label={label}
      to={to}
      showUsd={showUsd}
      clp={totals.clp}
      apiUsd={totals.apiUsd}
      animated={animated}
      stripInner
      valueVariant="main"
      valueDelta={
        <CardValueDayPl
          metricsByPeriod={metricsByPeriod}
          showUsd={showUsd}
          animated={animated}
        />
      }
      metrics={
        <DashboardCardGroupMetrics
          metricsByPeriod={metricsByPeriod}
          showUsd={showUsd}
          animated={animated}
        />
      }
    />
  );
}

/**
 * Portfolio strip: compact parent (plus a summary card per spread hub), optional detailed group
 * children, and — on leaf buckets — one accounts summary table for the account leaves (replaced
 * the per-account compact cards).
 */
export function PortfolioNavEntityCardsStrip({
  dash,
  parentNavNode,
  showUsd,
  animated = true,
  linkedCardNavChildren = [],
}: PortfolioNavEntityCardsStripProps) {
  const summaryHubs = useMemo(() => portfolioStripSummaryHubs(parentNavNode), [parentNavNode]);
  // Beside other summary cards the parent's is titled too (repeating the page title), so the
  // cards' rows line up.
  const parentLabel = summaryHubs.length > 0 ? resolveNavTreeLabel(parentNavNode) : undefined;

  const stripGroupChildren = useMemo(
    () => portfolioStripGroupChildren(parentNavNode),
    [parentNavNode]
  );

  const stripAccountChildren = useMemo(
    () => portfolioStripAccountChildren(parentNavNode),
    [parentNavNode]
  );

  /**
   * Beside accounts a sub-bucket is one more row of the accounts table, not a detail card
   * (Portafolio IPSA among Acciones' stocks) — a leaf of this page, sorted by balance with them.
   */
  const groupsAsRows = stripAccountChildren.length > 0 && stripGroupChildren.length > 0;

  /**
   * A chart-inactive sub-bucket listed as a detail card stays only while some period still
   * shows activity, as `PortfolioNavChildDetailCards` keeps it. Listed beside accounts it is a
   * liquidated table row instead (below).
   */
  const filteredGroupChildren = useMemo(
    () =>
      routableNavStripChildren(stripGroupChildren).filter((c) =>
        c.chart_inactive !== true
          ? true
          : !groupsAsRows && navChildCardHasActivity(dash, c, showUsd)
      ),
    [stripGroupChildren, groupsAsRows, dash, showUsd]
  );

  const filteredAccountChildren = useMemo(
    () => routableNavStripChildren(stripAccountChildren),
    [stripAccountChildren]
  );

  const accountCardChildren = useMemo(
    () => [...filteredAccountChildren, ...(groupsAsRows ? filteredGroupChildren : [])],
    [filteredAccountChildren, groupsAsRows, filteredGroupChildren]
  );

  /**
   * The table's liquidated rows, as the server lists them (`card_metrics_by_slug[…].liquidated`):
   * chart-inactive sub-buckets beside accounts and the chart-inactive accounts the nav tree
   * omits — every one that ever held money, so the Total column stays complete.
   */
  const liquidated = dash.card_metrics_by_slug?.[parentNavNode.slug]?.liquidated ?? null;
  const liquidatedChildren = useMemo(() => {
    if (!liquidated) return [];
    const groups = liquidated.group_slugs.map((slug) => {
      const node = (parentNavNode.children ?? []).find((c) => c.slug === slug);
      if (!node) throw new Error(`liquidated sub-bucket "${slug}" is not a child of ${parentNavNode.slug}`);
      return node;
    });
    const accounts = liquidated.account_ids.map((id) => {
      const row = dash.accounts.find((r) => r.account_id === id);
      if (!row) throw new Error(`liquidated account ${id} has no dashboard row`);
      return inactiveAccountNavLeaf(row);
    });
    return [...groups, ...accounts];
  }, [liquidated, parentNavNode, dash.accounts]);

  /** Groups hosted from elsewhere in the tree (Efectivo ← Pasivos > tarjeta de crédito). */
  const detailChildren = useMemo(
    () => [...(groupsAsRows ? [] : filteredGroupChildren), ...linkedCardNavChildren],
    [groupsAsRows, filteredGroupChildren, linkedCardNavChildren]
  );

  const showDetailSlots = detailChildren.length > 0;
  const showAccountsTable = accountCardChildren.length + liquidatedChildren.length > 0;
  /**
   * A page whose cards are only its own summary (a leaf bucket: Acciones) shows that summary
   * as the table's first «Total» row instead of a card.
   */
  const tableCarriesPage = showAccountsTable && !showDetailSlots && summaryHubs.length === 0;

  const isCashParent = parentNavNode.slug === "cash_eqs" || parentNavNode.slug === "cash_savings";

  return (
    <div style={{ marginTop: "0.85rem" }}>
      <PortfolioEntityCardsStrip
        compactStripClassName={isCashParent ? "card--cash" : undefined}
        compactSlot={
          tableCarriesPage ? null : (
          <NavSummaryCard
            dash={dash}
            node={parentNavNode}
            label={parentLabel}
            showUsd={showUsd}
            animated={animated}
          />
          )
        }
        summarySlots={summaryHubs.map((hub) => ({
          key: hub.node_id,
          slot: (
            <NavSummaryCard
              dash={dash}
              node={hub}
              label={resolveNavTreeLabel(hub)}
              to={hub.route_path?.trim() || undefined}
              showUsd={showUsd}
              animated={animated}
            />
          ),
        }))}
        detailSlots={
          showDetailSlots ? (
            <PortfolioNavChildDetailCards
              dash={dash}
              navChildren={detailChildren}
              showUsd={showUsd}
              animated={animated}
            />
          ) : null
        }
        accountsTableSlot={
          showAccountsTable ? (
            <PortfolioNavAccountsSummaryTable
              dash={dash}
              pageNode={parentNavNode}
              navChildren={accountCardChildren}
              liquidatedChildren={liquidatedChildren}
              showTotalRow={tableCarriesPage}
              showUsd={showUsd}
              animated={animated}
            />
          ) : null
        }
      />
    </div>
  );
}
