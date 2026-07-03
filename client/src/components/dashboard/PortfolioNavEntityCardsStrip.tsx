import { useMemo } from "react";
import { DashboardCardBreakdown } from "./DashboardCardBreakdown";
import { DashboardCardGroupMetrics } from "./DashboardCardGroupMetrics";
import { CompactEntityCard } from "./CompactEntityCard";
import { PortfolioEntityCardsStrip } from "./PortfolioEntityCardsStrip";
import { PortfolioNavAccountCompactCards } from "./PortfolioNavAccountCompactCards";
import { PortfolioNavChildDetailCards } from "./PortfolioNavChildDetailCards";
import {
  breakdownForNavChild,
  dashboardRowsForNavSubtree,
  inactiveAccountNavLeavesWithPeriodActivity,
  navMetricsAccountIdSet,
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
    "accounts" | "totals" | "liabilities_breakdown" | "dashboard_layout"
  > & {
    inversiones_period_metrics?: InversionesPeriodMetricsDto;
  };
  overviewPoints: Record<string, string | number | null>[];
  parentNavNode: NavTreeNodeDto;
  compactTitle: string;
  compactTitleTo?: string;
  showUsd: boolean;
  metricsPeriod: CardGroupMetricsPeriod;
  animated?: boolean;
  placeholderPhase?: boolean;
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
  placeholderPhase = false,
}: PortfolioNavEntityCardsStripProps) {
  const parentTitleMode = portfolioNavParentTitleModeForNavNode(parentNavNode);
  const compactCardSlug = `grp-nav-${parentNavNode.slug}-${parentNavNode.node_id}`;
  const parentRows = dashboardRowsForNavSubtree(dash.accounts, parentNavNode);
  const parentTotals = portfolioNavParentMainValue(dash, parentTitleMode, parentRows, showUsd);
  const parentMetrics = portfolioNavParentMetrics(
    dash,
    parentTitleMode,
    parentRows,
    metricsPeriod,
    parentNavNode,
    showUsd
  );
  const parentTitleDelta = parentTitleBalanceDelta(
    dash,
    overviewPoints,
    navMetricsAccountIdSet(parentNavNode, dash.accounts),
    metricsPeriod,
    showUsd,
    parentTitleMode
  );

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

  const showDetailSlots = filteredGroupChildren.length > 0;
  const showAccountCompactSlots = accountCardChildren.length > 0;

  const isCashEqsHub = parentNavNode.slug === "cash_eqs";
  const isCashSavings = parentNavNode.slug === "cash_savings";
  const isCashParent = isCashEqsHub || isCashSavings;
  const cashBreakdown = useMemo(() => {
    if (isCashSavings) {
      const rows = dashboardRowsForNavSubtree(dash.accounts, parentNavNode);
      return breakdownForNavChild(parentNavNode, rows, dash);
    }
    if (isCashEqsHub) {
      const rows = dashboardRowsForNavSubtree(dash.accounts, parentNavNode);
      return breakdownForNavChild(parentNavNode, rows, dash);
    }
    return null;
  }, [isCashSavings, isCashEqsHub, dash, parentNavNode]);

  const compactBreakdown = cashBreakdown ? (
    <DashboardCardBreakdown
      lines={cashBreakdown.lines}
      bottomLines={cashBreakdown.bottomLines}
      pinBottomToCard={cashBreakdown.pinBottom}
      showUsd={showUsd}
      cardSlug={compactCardSlug}
      animated={animated}
      placeholderPhase={placeholderPhase}
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
            placeholderPhase={placeholderPhase}
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
                placeholderPhase={placeholderPhase}
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
