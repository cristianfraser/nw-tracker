import { useMemo } from "react";
import { DashboardCardBreakdown } from "./DashboardCardBreakdown";
import { DashboardCardGroupMetrics } from "./DashboardCardGroupMetrics";
import { CompactEntityCard } from "./CompactEntityCard";
import { PortfolioEntityCardsStrip } from "./PortfolioEntityCardsStrip";
import { PortfolioNavChildDetailCards } from "./PortfolioNavChildDetailCards";
import {
  dashboardRowsForNavSubtree,
  filterNavChildrenForEntityStrip,
  navAccountIdSet,
  navNodeForCashAssetTotals,
  parentTitleBalanceDelta,
  portfolioNavParentMainValue,
  portfolioNavParentMetrics,
  type PortfolioNavParentTitleDeltaMode,
} from "../portfolioNavDashboardCards";
import { cashCardBreakdownFromDash, type CardGroupMetricsPeriod } from "../dashboardCardBreakdown";
import type { DashboardResponse, NavTreeNodeDto } from "../types";

export type PortfolioNavEntityCardsStripProps = {
  dash: Pick<
    DashboardResponse,
    "accounts" | "totals" | "suecia_snapshot" | "liabilities_breakdown" | "cash_credit_card_links"
  >;
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
  const parentNavForTotals = navNodeForCashAssetTotals(parentNavNode);
  const parentIds = navAccountIdSet(parentNavForTotals);
  const parentRows = dashboardRowsForNavSubtree(dash.accounts, parentNavForTotals);
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

  const stripDetailChildren = useMemo(() => {
    if (parentNavNode.slug === "cash_eqs") {
      return detailNavChildren.filter((c) => c.slug !== "liabilities_credit_card");
    }
    return detailNavChildren;
  }, [detailNavChildren, parentNavNode.slug]);

  const filteredDetailChildren = filterNavChildrenForEntityStrip(
    stripDetailChildren,
    dash.accounts,
    showUsd
  );
  const showDetailSlots = filteredDetailChildren.length > 0;

  const isCashParent = parentNavNode.slug === "cash_eqs";
  const cashBreakdown = useMemo(
    () => (isCashParent ? cashCardBreakdownFromDash(dash.accounts, dash) : null),
    [isCashParent, dash]
  );

  const compactBreakdown =
    cashBreakdown && (cashBreakdown.lines.length > 0 || cashBreakdown.bottomLines.length > 0) ? (
      <DashboardCardBreakdown
        lines={cashBreakdown.lines}
        bottomLines={cashBreakdown.bottomLines}
        pinBottomToCard
        showUsd={showUsd}
        cardSlug={compactCardSlug}
        animated={animated}
      />
    ) : undefined;

  return (
    <div style={{ marginTop: "0.85rem" }}>
      <PortfolioEntityCardsStrip
        compactStripClassName={isCashParent ? "card--cash" : undefined}
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
