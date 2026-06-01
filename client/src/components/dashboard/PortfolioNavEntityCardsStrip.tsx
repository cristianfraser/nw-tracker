import { useMemo } from "react";
import { DashboardCardBreakdown } from "./DashboardCardBreakdown";
import { DashboardCardGroupMetrics } from "./DashboardCardGroupMetrics";
import { CompactEntityCard } from "./CompactEntityCard";
import { PortfolioEntityCardsStrip } from "./PortfolioEntityCardsStrip";
import { PortfolioNavAccountCompactCards } from "./PortfolioNavAccountCompactCards";
import { PortfolioNavChildDetailCards } from "./PortfolioNavChildDetailCards";
import {
  dashboardRowsForNavSubtree,
  filterNavChildrenForEntityStrip,
  navAccountIdSet,
  parentTitleBalanceDelta,
  portfolioNavParentMainValue,
  portfolioNavParentMetrics,
  portfolioNavParentTitleModeForNavNode,
} from "../../portfolioNavDashboardCards";
import { buildCashCardBreakdown, type CardGroupMetricsPeriod } from "../../dashboardCardBreakdown";
import {
  portfolioStripAccountChildren,
  portfolioStripGroupChildren,
  resolveDashboardBucketFromNavNode,
} from "../../portfolioNavFromApi";
import type { DashboardResponse, NavTreeNodeDto } from "../../types";

export type PortfolioNavEntityCardsStripProps = {
  dash: Pick<
    DashboardResponse,
    "accounts" | "totals" | "suecia_snapshot" | "liabilities_breakdown"
  >;
  overviewPoints: Record<string, string | number | null>[];
  parentNavNode: NavTreeNodeDto;
  compactTitle: string;
  compactTitleTo?: string;
  showUsd: boolean;
  metricsPeriod: CardGroupMetricsPeriod;
  animated?: boolean;
};

/**
 * Portfolio strip: compact parent, optional detailed group children, optional compact account leaves.
 */
export function PortfolioNavEntityCardsStrip({
  dash,
  overviewPoints,
  parentNavNode,
  compactTitle,
  compactTitleTo,
  showUsd,
  metricsPeriod,
  animated = true,
}: PortfolioNavEntityCardsStripProps) {
  const parentTitleMode = portfolioNavParentTitleModeForNavNode(parentNavNode);
  const compactCardSlug = `grp-nav-${parentNavNode.slug}-${parentNavNode.node_id}`;
  const parentIds = navAccountIdSet(parentNavNode);
  const parentRows = dashboardRowsForNavSubtree(dash.accounts, parentNavNode);
  const parentTitleDelta = parentTitleBalanceDelta(
    dash,
    overviewPoints,
    parentIds,
    metricsPeriod,
    showUsd,
    parentTitleMode
  );
  const parentTotals = portfolioNavParentMainValue(dash, parentTitleMode, parentRows, showUsd);
  const parentMetrics = portfolioNavParentMetrics(dash, parentTitleMode, parentRows, metricsPeriod);

  const stripGroupChildren = useMemo(
    () => portfolioStripGroupChildren(parentNavNode),
    [parentNavNode]
  );

  const stripAccountChildren = useMemo(
    () => portfolioStripAccountChildren(parentNavNode),
    [parentNavNode]
  );

  const filteredGroupChildren = useMemo(() => {
    if (parentNavNode.asset_group_slug === "net_worth") {
      return stripGroupChildren;
    }
    return filterNavChildrenForEntityStrip(stripGroupChildren, dash.accounts, showUsd);
  }, [parentNavNode.asset_group_slug, stripGroupChildren, dash.accounts, showUsd]);

  const filteredAccountChildren = useMemo(
    () => filterNavChildrenForEntityStrip(stripAccountChildren, dash.accounts, showUsd),
    [stripAccountChildren, dash.accounts, showUsd]
  );

  const showDetailSlots = filteredGroupChildren.length > 0;
  const showAccountCompactSlots = filteredAccountChildren.length > 0;

  const isCashParent =
    resolveDashboardBucketFromNavNode(parentNavNode) === "cash_eqs" ||
    parentNavNode.slug === "cash_savings";
  const cashBreakdownLines = useMemo(
    () => (isCashParent ? buildCashCardBreakdown(dash.accounts) : null),
    [isCashParent, dash.accounts]
  );

  const compactBreakdown =
    cashBreakdownLines && cashBreakdownLines.length > 0 ? (
      <DashboardCardBreakdown
        lines={cashBreakdownLines}
        showUsd={showUsd}
        cardSlug={compactCardSlug}
        animated={animated}
      />
    ) : undefined;

  const compactTitleToResolved =
    compactTitleTo ?? (parentNavNode.route_path?.trim() ? parentNavNode.route_path.trim() : undefined);

  return (
    <div style={{ marginTop: "0.85rem" }}>
      <PortfolioEntityCardsStrip
        compactStripClassName={isCashParent ? "card--cash" : undefined}
        compactSlot={
          <CompactEntityCard
            label={compactTitle}
            to={compactTitleToResolved}
            balanceDelta={parentTitleDelta}
            showUsd={showUsd}
            clp={parentTotals.clp}
            apiUsd={parentTotals.apiUsd}
            cardSlug={compactCardSlug}
            animated={animated}
            stripInner
            valueVariant="main"
            breakdown={compactBreakdown}
            metrics={
              <DashboardCardGroupMetrics
                metrics={parentMetrics}
                showUsd={showUsd}
                period={metricsPeriod}
                cardSlug={compactCardSlug}
                animated={animated}
              />
            }
          />
        }
        detailSlots={
          showDetailSlots ? (
            <PortfolioNavChildDetailCards
              dash={dash}
              overviewPoints={overviewPoints}
              navChildren={filteredGroupChildren}
              showUsd={showUsd}
              metricsPeriod={metricsPeriod}
              animated={animated}
            />
          ) : null
        }
        accountCompactSlots={
          showAccountCompactSlots ? (
            <PortfolioNavAccountCompactCards
              dash={dash}
              navChildren={filteredAccountChildren}
              showUsd={showUsd}
              metricsPeriod={metricsPeriod}
              animated={animated}
            />
          ) : null
        }
      />
    </div>
  );
}
