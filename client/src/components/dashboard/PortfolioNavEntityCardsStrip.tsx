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
  filterNavChildrenForEntityStrip,
  portfolioNavParentMainValue,
  portfolioNavParentMetrics,
  portfolioNavParentTitleModeForNavNode,
} from "../../portfolioNavDashboardCards";
import {
  buildCashEqsCardBreakdown,
  periodBalanceChangeFromAccountRows,
  type CardGroupMetricsPeriod,
} from "../../dashboardCardBreakdown";
import { accountCountsTowardGroupTotals, isChartActiveAccount } from "../../accountGroupTotals";
import {
  portfolioStripAccountChildren,
  portfolioStripGroupChildren,
} from "../../portfolioNavFromApi";
import type { DashboardResponse, NavTreeNodeDto } from "../../types";

export type PortfolioNavEntityCardsStripProps = {
  dash: Pick<
    DashboardResponse,
    "accounts" | "totals" | "suecia_snapshot" | "liabilities_breakdown" | "dashboard_layout"
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
  const parentMetricsRows = parentRows.filter(
    (a) =>
      accountCountsTowardGroupTotals(a) &&
      isChartActiveAccount(a) &&
      a.current_value_clp != null &&
      Number.isFinite(a.current_value_clp)
  );
  const parentTitleDelta = periodBalanceChangeFromAccountRows(
    parentMetricsRows,
    metricsPeriod,
    showUsd
  );

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

  const isCashEqsHub = parentNavNode.slug === "cash_eqs";
  const isCashSavings = parentNavNode.slug === "cash_savings";
  const isCashParent = isCashEqsHub || isCashSavings;
  const cashBreakdown = useMemo(() => {
    if (isCashSavings) {
      const rows = dashboardRowsForNavSubtree(dash.accounts, parentNavNode);
      return breakdownForNavChild(parentNavNode, rows, dash);
    }
    if (isCashEqsHub) {
      const lines = buildCashEqsCardBreakdown(dash.accounts);
      return lines.length ? { lines } : null;
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
