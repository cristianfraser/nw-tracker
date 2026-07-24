import { useMemo } from "react";
import { DashboardCardGroupMetrics } from "./DashboardCardGroupMetrics";
import { CompactEntityCard } from "./CompactEntityCard";
import { PortfolioEntityCardsStrip } from "./PortfolioEntityCardsStrip";
import { PortfolioNavAccountCompactCards } from "./PortfolioNavAccountCompactCards";
import { PortfolioNavChildDetailCards } from "./PortfolioNavChildDetailCards";
import {
  dashboardRowsForNavSubtree,
  inactiveAccountNavLeavesWithPeriodActivity,
  parentTitleBalanceDelta,
  routableNavStripChildren,
  portfolioNavParentMainValue,
  portfolioNavParentMetrics,
  portfolioNavParentTitleModeForNavNode,
  type InversionesPeriodMetricsDto,
} from "../../portfolioNavDashboardCards";
import type { CardGroupMetricsPeriod } from "../../dashboardCardBreakdown";
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
  metricsPeriod: CardGroupMetricsPeriod;
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
  metricsPeriod,
  animated = true,
  placeholderPhase = false,
  linkedCardNavChildren = [],
}: PortfolioNavEntityCardsStripProps) {
  const parentTitleMode = portfolioNavParentTitleModeForNavNode(parentNavNode);
  const compactCardSlug = `grp-nav-${parentNavNode.slug}-${parentNavNode.node_id}`;
  const parentRows = dashboardRowsForNavSubtree(dash.accounts, parentNavNode);
  const parentTotals = portfolioNavParentMainValue(dash, parentTitleMode, parentRows, showUsd);
  const parentMetrics = portfolioNavParentMetrics(dash, parentNavNode, metricsPeriod);
  const parentTitleDelta = parentTitleBalanceDelta(dash, parentNavNode, metricsPeriod, showUsd);

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

  /** Accounts the nav tree hides (chart-inactive) still get a card when the period has activity. */
  const accountCardChildren = useMemo(
    () => [
      ...filteredAccountChildren,
      ...inactiveAccountNavLeavesWithPeriodActivity(
        dash,
        parentNavNode,
        stripGroupChildren,
        metricsPeriod
      ),
    ],
    [filteredAccountChildren, dash, parentNavNode, stripGroupChildren, metricsPeriod]
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
            balanceDelta={parentTitleDelta}
            showUsd={showUsd}
            clp={parentTotals.clp}
            apiUsd={parentTotals.apiUsd}
            cardSlug={compactCardSlug}
            animated={animated}
            placeholderPhase={placeholderPhase}
            stripInner
            valueVariant="main"
            metrics={
              <DashboardCardGroupMetrics
                metrics={parentMetrics}
                showUsd={showUsd}
                period={metricsPeriod}
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
              metricsPeriod={metricsPeriod}
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
              metricsPeriod={metricsPeriod}
              animated={animated}
              placeholderPhase={placeholderPhase}
            />
          ) : null
        }
      />
    </div>
  );
}
