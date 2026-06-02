import { DashboardCardBreakdown } from "./DashboardCardBreakdown";
import { DashboardCardGroupMetrics } from "./DashboardCardGroupMetrics";
import { DetailedGroupCard } from "./DetailedGroupCard";
import {
  breakdownForNavChild,
  dashboardRowsForNavSubtree,
  mainValueAndMetricsForNavChild,
} from "../../portfolioNavDashboardCards";
import {
  compareDashboardCardMainDesc,
  periodBalanceChangeFromAccountRows,
  type CardGroupMetricsPeriod,
} from "../../dashboardCardBreakdown";
import { accountCountsTowardGroupTotals, isChartActiveAccount } from "../../accountGroupTotals";
import { useMemo } from "react";
import { resolveDashboardBucketFromNavNode } from "../../portfolioNavFromApi";
import type { DashboardResponse, NavTreeNodeDto } from "../../types";
import { resolveNavTreeLabel } from "../../sidebarNavFromApi";

export type PortfolioNavChildDetailCardsProps = {
  dash: Pick<
    DashboardResponse,
    "accounts" | "totals" | "suecia_snapshot" | "liabilities_breakdown" | "dashboard_layout"
  >;
  overviewPoints: Record<string, string | number | null>[];
  navChildren: NavTreeNodeDto[];
  showUsd: boolean;
  metricsPeriod: CardGroupMetricsPeriod;
  animated?: boolean;
};

/** Second-row dashboard-style cards for first-level portfolio nav children (subset of dashboard accounts). */
export function PortfolioNavChildDetailCards({
  dash,
  overviewPoints: _overviewPoints,
  navChildren,
  showUsd,
  metricsPeriod,
  animated = true,
}: PortfolioNavChildDetailCardsProps) {
  const sorted = useMemo(() => {
    const filtered = navChildren.filter((c) => c.route_path?.trim());
    return [...filtered].sort((a, b) => {
      const aMain = mainValueAndMetricsForNavChild(dash, a, metricsPeriod, showUsd);
      const bMain = mainValueAndMetricsForNavChild(dash, b, metricsPeriod, showUsd);
      return compareDashboardCardMainDesc(aMain.clp, aMain.apiUsd, bMain.clp, bMain.apiUsd, showUsd);
    });
  }, [navChildren, dash, metricsPeriod, showUsd]);

  if (!sorted.length) return null;

  return (
    <>
      {sorted.map((child) => {
        const childRows = dashboardRowsForNavSubtree(dash.accounts, child);
        const metricsRows = childRows.filter(
          (a) =>
            accountCountsTowardGroupTotals(a) &&
            isChartActiveAccount(a) &&
            a.current_value_clp != null &&
            Number.isFinite(a.current_value_clp)
        );
        const { clp, apiUsd, metrics: childMetrics } = mainValueAndMetricsForNavChild(
          dash,
          child,
          metricsPeriod,
          showUsd
        );
        const childTitleDelta = periodBalanceChangeFromAccountRows(
          metricsRows,
          metricsPeriod,
          showUsd
        );
        const br = breakdownForNavChild(child, childRows, dash);
        const rp = child.route_path?.trim() ?? "";
        const cashClass =
          resolveDashboardBucketFromNavNode(child) === "cash_eqs" ? "card--cash" : "";
        const cardSlug = `nav-${child.slug}-${child.node_id}`;
        const fxMissing = showUsd && childRows.some((r) => r.fx_missing);

        return (
          <DetailedGroupCard
            key={child.node_id}
            title={resolveNavTreeLabel(child)}
            titleTo={rp || undefined}
            balanceDelta={childTitleDelta}
            showUsd={showUsd}
            clp={clp}
            apiUsd={apiUsd}
            fxMissing={fxMissing}
            cardSlug={cardSlug}
            animated={animated}
            className={cashClass}
            metrics={
              <DashboardCardGroupMetrics
                metrics={childMetrics}
                showUsd={showUsd}
                period={metricsPeriod}
                cardSlug={cardSlug}
                animated={animated}
              />
            }
            breakdown={
              br ? (
                <DashboardCardBreakdown
                  lines={br.lines}
                  bottomLines={br.bottomLines}
                  pinBottomToCard={br.pinBottom}
                  showUsd={showUsd}
                  cardSlug={cardSlug}
                  animated={animated}
                />
              ) : null
            }
          />
        );
      })}
    </>
  );
}
