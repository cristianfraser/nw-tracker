import { useMemo } from "react";
import { DashboardCardBreakdown } from "./DashboardCardBreakdown";
import { DashboardCardGroupMetrics } from "./DashboardCardGroupMetrics";
import { DetailedGroupCard } from "./DetailedGroupCard";
import {
  breakdownForNavChild,
  dashboardRowsForNavSubtree,
  mainValueForNavChild,
  navChildCardHasActivity,
  requireNavCardMetrics,
} from "../../portfolioNavDashboardCards";
import { compareDashboardCardMainDesc } from "../../dashboardCardBreakdown";
import type { DashboardResponse, NavTreeNodeDto } from "../../types";
import { resolveNavTreeLabel } from "../../sidebarNavFromApi";

export type PortfolioNavChildDetailCardsProps = {
  dash: Pick<
    DashboardResponse,
    "accounts" | "totals" | "liabilities_breakdown" | "dashboard_layout" | "card_metrics_by_slug"
  >;
  navChildren: NavTreeNodeDto[];
  showUsd: boolean;
  animated?: boolean;
  placeholderPhase?: boolean;
};

/** Second-row dashboard-style cards for first-level portfolio nav children (subset of dashboard accounts). */
export function PortfolioNavChildDetailCards({
  dash,
  navChildren,
  showUsd,
  animated = true,
  placeholderPhase = false,
}: PortfolioNavChildDetailCardsProps) {
  const sorted = useMemo(() => {
    const filtered = navChildren.filter(
      (c) =>
        c.route_path?.trim() &&
        (c.chart_inactive !== true || navChildCardHasActivity(dash, c, showUsd))
    );
    return [...filtered].sort((a, b) => {
      const aMain = mainValueForNavChild(dash, a, showUsd);
      const bMain = mainValueForNavChild(dash, b, showUsd);
      return compareDashboardCardMainDesc(aMain.clp, aMain.apiUsd, bMain.clp, bMain.apiUsd, showUsd);
    });
  }, [navChildren, dash, showUsd]);

  if (!sorted.length) return null;

  return (
    <>
      {sorted.map((child) => {
        const childRows = dashboardRowsForNavSubtree(dash.accounts, child);
        const { clp, apiUsd } = mainValueForNavChild(dash, child, showUsd);
        const metricsByPeriod = requireNavCardMetrics(dash, child).child;
        const br = breakdownForNavChild(child, childRows, dash);
        const rp = child.route_path?.trim() ?? "";
        const cashClass =
          child.slug === "cash_eqs" ||
          child.slug === "cash_savings" ||
          child.asset_group_slug?.startsWith("cash_eqs")
            ? "card--cash"
            : "";
        const cardSlug = `nav-${child.slug}-${child.node_id}`;
        const fxMissing = showUsd && childRows.some((r) => r.fx_missing);
        const syncStale =
          childRows.length > 0 && childRows.every((r) => r.sync_stale === true);

        return (
          <DetailedGroupCard
            key={child.node_id}
            title={resolveNavTreeLabel(child)}
            titleTo={rp || undefined}
            showUsd={showUsd}
            clp={clp}
            apiUsd={apiUsd}
            fxMissing={fxMissing}
            syncStale={syncStale}
            cardSlug={cardSlug}
            animated={animated}
            placeholderPhase={placeholderPhase}
            className={cashClass}
            metrics={
              <DashboardCardGroupMetrics
                metricsByPeriod={metricsByPeriod}
                showUsd={showUsd}
                cardSlug={cardSlug}
                animated={animated}
                placeholderPhase={placeholderPhase}
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
                  placeholderPhase={placeholderPhase}
                />
              ) : null
            }
          />
        );
      })}
    </>
  );
}
