import { useMemo } from "react";
import { CardValueDayPl, DashboardCardGroupMetrics } from "./DashboardCardGroupMetrics";
import { CompactEntityCard } from "./CompactEntityCard";
import { dashboardRowsForNavSubtree } from "../../portfolioNavDashboardCards";
import {
  cardGroupMetricsByPeriodFromAccounts,
  compareDashboardCardMainDesc,
  sumCurrentValueClpUsd,
} from "../../dashboardCardBreakdown";
import type { DashboardResponse, NavTreeNodeDto } from "../../types";
import { resolveNavTreeLabel } from "../../sidebarNavFromApi";

export type PortfolioNavAccountCompactCardsProps = {
  dash: Pick<DashboardResponse, "accounts">;
  navChildren: NavTreeNodeDto[];
  showUsd: boolean;
  animated?: boolean;
  placeholderPhase?: boolean;
};

/** Third-row compact cards for account nav leaves under a portfolio group. */
export function PortfolioNavAccountCompactCards({
  dash,
  navChildren,
  showUsd,
  animated = true,
  placeholderPhase = false,
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
        const { clp, apiUsd } = sumCurrentValueClpUsd(rows, showUsd);
        const metricsByPeriod = cardGroupMetricsByPeriodFromAccounts(rows);
        const fxMissing = showUsd && rows.some((r) => r.fx_missing);
        const syncStale = rows.length > 0 && rows.every((r) => r.sync_stale === true);
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
              showUsd={showUsd}
              clp={clp}
              apiUsd={apiUsd}
              fxMissing={fxMissing}
              syncStale={syncStale}
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
          </div>
        );
      })}
    </>
  );
}
