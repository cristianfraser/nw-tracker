import { useMemo } from "react";
import { DashboardCardGroupMetrics } from "./DashboardCardGroupMetrics";
import { CompactEntityCard } from "./CompactEntityCard";
import { dashboardRowsForNavSubtree } from "../portfolioNavDashboardCards";
import {
  accountCardTitleBalanceDelta,
  cardGroupMetricsFromAccounts,
  compareDashboardCardMainDesc,
  sumCurrentValueClpUsd,
  type CardGroupMetricsPeriod,
} from "../dashboardCardBreakdown";
import type { DashboardResponse, NavTreeNodeDto } from "../types";
import { resolveNavTreeLabel } from "../sidebarNavFromApi";

export type PortfolioNavAccountCompactCardsProps = {
  dash: Pick<DashboardResponse, "accounts">;
  navChildren: NavTreeNodeDto[];
  showUsd: boolean;
  metricsPeriod: CardGroupMetricsPeriod;
  animated?: boolean;
};

/** Third-row compact cards for account nav leaves under a portfolio group. */
export function PortfolioNavAccountCompactCards({
  dash,
  navChildren,
  showUsd,
  metricsPeriod,
  animated = true,
}: PortfolioNavAccountCompactCardsProps) {
  const sorted = useMemo(() => {
    const filtered = navChildren.filter((c) => c.route_path?.trim());
    return [...filtered].sort((a, b) => {
      const aVal = sumCurrentValueClpUsd(dashboardRowsForNavSubtree(dash.accounts, a), showUsd);
      const bVal = sumCurrentValueClpUsd(dashboardRowsForNavSubtree(dash.accounts, b), showUsd);
      return compareDashboardCardMainDesc(aVal.clp, aVal.apiUsd, bVal.clp, bVal.apiUsd, showUsd);
    });
  }, [navChildren, dash.accounts, showUsd]);

  if (!sorted.length) return null;

  return (
    <>
      {sorted.map((child) => {
        const rows = dashboardRowsForNavSubtree(dash.accounts, child);
        const row = rows[0] ?? null;
        const { clp, apiUsd } = sumCurrentValueClpUsd(rows, showUsd);
        const titleDelta =
          row != null ? accountCardTitleBalanceDelta(row, metricsPeriod, showUsd) : null;
        const metrics = cardGroupMetricsFromAccounts(rows, metricsPeriod);
        const rp = child.route_path?.trim() ?? "";
        const cardSlug = `nav-acc-${child.slug}-${child.node_id}`;

        return (
          <div
            key={child.node_id}
            className="card card--detail card--detail-compact card--detail-stretch"
          >
            <CompactEntityCard
              label={resolveNavTreeLabel(child)}
              to={rp || undefined}
              balanceDelta={titleDelta}
              showUsd={showUsd}
              clp={clp}
              apiUsd={apiUsd}
              cardSlug={cardSlug}
              animated={animated}
              stripInner
              valueVariant="main"
              metrics={
                <DashboardCardGroupMetrics
                  metrics={metrics}
                  showUsd={showUsd}
                  period={metricsPeriod}
                  cardSlug={cardSlug}
                  animated={animated}
                />
              }
            />
          </div>
        );
      })}
    </>
  );
}
