import { DashboardCardBreakdown } from "./DashboardCardBreakdown";
import { DashboardCardGroupMetrics } from "./DashboardCardGroupMetrics";
import { DetailedGroupCard } from "./DetailedGroupCard";
import {
  breakdownForNavChild,
  dashboardRowsForNavSubtree,
  navAccountIdSet,
  titleBalanceDeltaForAccountIds,
  titleDeltaModelForNavChildSlug,
} from "../portfolioNavDashboardCards";
import { cardGroupMetricsFromAccounts, sumCurrentValueClpUsd, type CardGroupMetricsPeriod } from "../dashboardCardBreakdown";
import type { DashboardResponse, NavTreeNodeDto } from "../types";
import { resolveNavTreeLabel } from "../sidebarNavFromApi";

export type PortfolioNavChildDetailCardsProps = {
  dash: Pick<DashboardResponse, "accounts" | "totals" | "suecia_snapshot" | "liabilities_breakdown">;
  overviewPoints: Record<string, string | number | null>[];
  navChildren: NavTreeNodeDto[];
  showUsd: boolean;
  metricsPeriod: CardGroupMetricsPeriod;
  animated?: boolean;
};

/** Second-row dashboard-style cards for first-level portfolio nav children (subset of dashboard accounts). */
export function PortfolioNavChildDetailCards({
  dash,
  overviewPoints,
  navChildren,
  showUsd,
  metricsPeriod,
  animated = true,
}: PortfolioNavChildDetailCardsProps) {
  const filtered = navChildren.filter((c) => c.route_path?.trim());
  if (!filtered.length) return null;

  return (
    <>
      {filtered.map((child) => {
        const childRows = dashboardRowsForNavSubtree(dash.accounts, child);
        const childIds = navAccountIdSet(child);
        const spec = titleDeltaModelForNavChildSlug(child.slug);
        const childTitleDelta = titleBalanceDeltaForAccountIds(
          dash,
          overviewPoints,
          childIds,
          metricsPeriod,
          showUsd,
          spec
        );
        const { clp, apiUsd } = sumCurrentValueClpUsd(childRows, showUsd);
        const childMetrics = cardGroupMetricsFromAccounts(childRows, metricsPeriod);
        const br = breakdownForNavChild(child, childRows, dash);
        const rp = child.route_path?.trim() ?? "";
        const cashClass = child.slug === "cash_eqs" ? "card--cash" : "";
        const cardSlug = `nav-${child.slug}-${child.node_id}`;

        return (
          <DetailedGroupCard
            key={child.node_id}
            title={resolveNavTreeLabel(child)}
            titleTo={rp || undefined}
            balanceDelta={childTitleDelta}
            showUsd={showUsd}
            clp={clp}
            apiUsd={apiUsd}
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
