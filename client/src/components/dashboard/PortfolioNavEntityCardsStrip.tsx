import { useMemo } from "react";
import { CardValueDayPl, DashboardCardGroupMetrics } from "./DashboardCardGroupMetrics";
import { CompactEntityCard } from "./CompactEntityCard";
import { PortfolioEntityCardsStrip } from "./PortfolioEntityCardsStrip";
import { PortfolioNavAccountsSummaryTable } from "./PortfolioNavAccountsSummaryTable";
import { PortfolioNavChildDetailCards } from "./PortfolioNavChildDetailCards";
import {
  dashboardRowsForNavSubtree,
  inactiveAccountNavLeavesWithActivity,
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
  placeholderPhase?: boolean;
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
  placeholderPhase: boolean;
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
  placeholderPhase,
}: NavSummaryCardProps) {
  const cardSlug = `grp-nav-${node.slug}-${node.node_id}`;
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
      cardSlug={cardSlug}
      animated={animated}
      placeholderPhase={placeholderPhase}
      stripInner
      valueVariant="main"
      valueDelta={
        <CardValueDayPl
          metricsByPeriod={metricsByPeriod}
          showUsd={showUsd}
          cardSlug={cardSlug}
          animated={animated}
          placeholderPhase={placeholderPhase}
        />
      }
      metrics={
        <DashboardCardGroupMetrics
          metricsByPeriod={metricsByPeriod}
          showUsd={showUsd}
          cardSlug={cardSlug}
          animated={animated}
          placeholderPhase={placeholderPhase}
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
  placeholderPhase = false,
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

  const filteredGroupChildren = useMemo(
    () => routableNavStripChildren(stripGroupChildren),
    [stripGroupChildren]
  );

  const filteredAccountChildren = useMemo(
    () => routableNavStripChildren(stripAccountChildren),
    [stripAccountChildren]
  );

  /** Accounts the nav tree hides (chart-inactive) still get a card when any period has activity. */
  const accountCardChildren = useMemo(
    () => [
      ...filteredAccountChildren,
      ...(groupsAsRows ? filteredGroupChildren : []),
      ...inactiveAccountNavLeavesWithActivity(dash, parentNavNode, stripGroupChildren),
    ],
    [filteredAccountChildren, groupsAsRows, filteredGroupChildren, dash, parentNavNode, stripGroupChildren]
  );

  /** Groups hosted from elsewhere in the tree (Efectivo ← Pasivos > tarjeta de crédito). */
  const detailChildren = useMemo(
    () => [...(groupsAsRows ? [] : filteredGroupChildren), ...linkedCardNavChildren],
    [groupsAsRows, filteredGroupChildren, linkedCardNavChildren]
  );

  const showDetailSlots = detailChildren.length > 0;
  const showAccountsTable = accountCardChildren.length > 0;

  const isCashParent = parentNavNode.slug === "cash_eqs" || parentNavNode.slug === "cash_savings";

  return (
    <div style={{ marginTop: "0.85rem" }}>
      <PortfolioEntityCardsStrip
        compactStripClassName={isCashParent ? "card--cash" : undefined}
        compactSlot={
          <NavSummaryCard
            dash={dash}
            node={parentNavNode}
            label={parentLabel}
            showUsd={showUsd}
            animated={animated}
            placeholderPhase={placeholderPhase}
          />
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
              placeholderPhase={placeholderPhase}
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
              placeholderPhase={placeholderPhase}
            />
          ) : null
        }
        accountsTableSlot={
          showAccountsTable ? (
            <PortfolioNavAccountsSummaryTable
              dash={dash}
              navChildren={accountCardChildren}
              showUsd={showUsd}
              animated={animated}
              placeholderPhase={placeholderPhase}
            />
          ) : null
        }
      />
    </div>
  );
}
