import { useMemo } from "react";
import { CardValueDayPl, DashboardCardGroupMetrics } from "./DashboardCardGroupMetrics";
import { CompactEntityCard } from "./CompactEntityCard";
import { PortfolioEntityCardsStrip } from "./PortfolioEntityCardsStrip";
import { PortfolioNavAccountCompactCards } from "./PortfolioNavAccountCompactCards";
import { PortfolioNavChildDetailCards } from "./PortfolioNavChildDetailCards";
import {
  dashboardRowsForNavSubtree,
  inactiveAccountNavLeavesWithActivity,
  routableNavStripChildren,
  portfolioNavParentMainValue,
  portfolioNavParentTitleModeForNavNode,
  requireNavCardMetrics,
  type InversionesPeriodMetricsDto,
} from "../../portfolioNavDashboardCards";
import {
  portfolioStripAccountChildren,
  portfolioStripGroupChildren,
} from "../../portfolioNavFromApi";
import type { DashboardResponse, NavTreeNodeDto } from "../../types";

export type PortfolioNavEntityCardsStripProps = {
  dash: Pick<
    DashboardResponse,
    "accounts" | "totals" | "liabilities_breakdown" | "dashboard_layout" | "card_metrics_by_slug"
  > & {
    inversiones_period_metrics?: InversionesPeriodMetricsDto;
  };
  parentNavNode: NavTreeNodeDto;
  showUsd: boolean;
  animated?: boolean;
  placeholderPhase?: boolean;
  /** Nodes for `parentNavNode.linked_card_slugs`, resolved by the page against the sidebar nav. */
  linkedCardNavChildren?: NavTreeNodeDto[];
};

/**
 * Portfolio strip: compact parent, optional detailed group children, optional compact account leaves.
 */
export function PortfolioNavEntityCardsStrip({
  dash,
  parentNavNode,
  showUsd,
  animated = true,
  placeholderPhase = false,
  linkedCardNavChildren = [],
}: PortfolioNavEntityCardsStripProps) {
  const parentTitleMode = portfolioNavParentTitleModeForNavNode(parentNavNode);
  const compactCardSlug = `grp-nav-${parentNavNode.slug}-${parentNavNode.node_id}`;
  const parentRows = dashboardRowsForNavSubtree(dash.accounts, parentNavNode);
  const parentTotals = portfolioNavParentMainValue(dash, parentTitleMode, parentRows, showUsd);
  const parentMetricsByPeriod = requireNavCardMetrics(dash, parentNavNode).parent;

  const stripGroupChildren = useMemo(
    () => portfolioStripGroupChildren(parentNavNode),
    [parentNavNode]
  );

  const stripAccountChildren = useMemo(
    () => portfolioStripAccountChildren(parentNavNode),
    [parentNavNode]
  );

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
      ...inactiveAccountNavLeavesWithActivity(dash, parentNavNode, stripGroupChildren),
    ],
    [filteredAccountChildren, dash, parentNavNode, stripGroupChildren]
  );

  /** Groups hosted from elsewhere in the tree (Efectivo ← Pasivos > tarjeta de crédito). */
  const detailChildren = useMemo(
    () => [...filteredGroupChildren, ...linkedCardNavChildren],
    [filteredGroupChildren, linkedCardNavChildren]
  );

  const showDetailSlots = detailChildren.length > 0;
  const showAccountCompactSlots = accountCardChildren.length > 0;

  const isCashParent = parentNavNode.slug === "cash_eqs" || parentNavNode.slug === "cash_savings";

  return (
    <div style={{ marginTop: "0.85rem" }}>
      <PortfolioEntityCardsStrip
        compactStripClassName={isCashParent ? "card--cash" : undefined}
        compactSlot={
          <CompactEntityCard
            showUsd={showUsd}
            clp={parentTotals.clp}
            apiUsd={parentTotals.apiUsd}
            cardSlug={compactCardSlug}
            animated={animated}
            placeholderPhase={placeholderPhase}
            stripInner
            valueVariant="main"
            valueDelta={
              <CardValueDayPl
                metricsByPeriod={parentMetricsByPeriod}
                showUsd={showUsd}
                cardSlug={compactCardSlug}
                animated={animated}
                placeholderPhase={placeholderPhase}
              />
            }
            metrics={
              <DashboardCardGroupMetrics
                metricsByPeriod={parentMetricsByPeriod}
                showUsd={showUsd}
                cardSlug={compactCardSlug}
                animated={animated}
                placeholderPhase={placeholderPhase}
              />
            }
          />
        }
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
        accountCompactSlots={
          showAccountCompactSlots ? (
            <PortfolioNavAccountCompactCards
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
