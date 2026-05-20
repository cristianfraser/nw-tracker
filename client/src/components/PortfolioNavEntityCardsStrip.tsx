import { DashboardCardGroupMetrics } from "./DashboardCardGroupMetrics";
import { CompactEntityCard } from "./CompactEntityCard";
import { PortfolioEntityCardsStrip } from "./PortfolioEntityCardsStrip";
import { PortfolioNavChildDetailCards } from "./PortfolioNavChildDetailCards";
import {
  dashboardRowsForNavSubtree,
  filterNavChildrenForEntityStrip,
  navAccountIdSet,
  parentTitleBalanceDelta,
  type PortfolioNavParentTitleDeltaMode,
} from "../portfolioNavDashboardCards";
import { cardGroupMetricsFromAccounts, sumCurrentValueClpUsd, type CardGroupMetricsPeriod } from "../dashboardCardBreakdown";
import type { DashboardResponse, NavTreeNodeDto } from "../types";

export type PortfolioNavEntityCardsStripProps = {
  dash: Pick<DashboardResponse, "accounts" | "totals" | "suecia_snapshot" | "liabilities_breakdown">;
  overviewPoints: Record<string, string | number | null>[];
  parentNavNode: NavTreeNodeDto;
  detailNavChildren: NavTreeNodeDto[];
  compactTitle: string;
  compactCardSlug: string;
  compactTitleTo?: string;
  parentTitleMode: PortfolioNavParentTitleDeltaMode;
  showUsd: boolean;
  metricsPeriod: CardGroupMetricsPeriod;
  animated?: boolean;
};

/**
 * Two-row strip: compact parent (nav subtree totals + dashboard-style Δ / metrics) and optional
 * detailed cards for first-level nav children (same breakdown builders as the home dashboard).
 */
export function PortfolioNavEntityCardsStrip({
  dash,
  overviewPoints,
  parentNavNode,
  detailNavChildren,
  compactTitle,
  compactCardSlug,
  compactTitleTo,
  parentTitleMode,
  showUsd,
  metricsPeriod,
  animated = true,
}: PortfolioNavEntityCardsStripProps) {
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
  const parentTotals = sumCurrentValueClpUsd(parentRows, showUsd);
  const parentMetrics = cardGroupMetricsFromAccounts(parentRows, metricsPeriod);

  const filteredDetailChildren = filterNavChildrenForEntityStrip(detailNavChildren, dash.accounts, showUsd);
  const showDetailSlots = filteredDetailChildren.length > 0;

  return (
    <div style={{ marginTop: "0.85rem" }}>
      <PortfolioEntityCardsStrip
        compactSlot={
          <CompactEntityCard
            label={compactTitle}
            to={compactTitleTo}
            balanceDelta={parentTitleDelta}
            showUsd={showUsd}
            clp={parentTotals.clp}
            apiUsd={parentTotals.apiUsd}
            cardSlug={compactCardSlug}
            animated={animated}
            stripInner
            valueVariant="main"
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
              navChildren={filteredDetailChildren}
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
