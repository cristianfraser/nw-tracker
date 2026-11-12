import { useMemo } from "react";
import { DashboardCardBreakdown } from "./DashboardCardBreakdown";
import { CardValueDayPl, DashboardCardGroupMetrics } from "./DashboardCardGroupMetrics";
import { DetailedGroupCard } from "./DetailedGroupCard";
import {
  breakdownForNavChild,
  mainValueForNavChild,
  navChildCardHasActivity,
  requireNavCardMetrics,
} from "../../portfolioNavDashboardCards";
import { compareDashboardCardMainDesc } from "../../dashboardCardBreakdown";
import type { DashboardResponse, NavTreeNodeDto } from "../../types";
import { resolveNavTreeLabel } from "../../sidebarNavFromApi";
import type { DisplayUnit } from "../../queries/keys";

export type PortfolioNavChildDetailCardsProps = {
  dash: Pick<
    DashboardResponse,
    "accounts" | "liabilities_breakdown" | "dashboard_layout" | "card_metrics_by_slug"
  >;
  navChildren: NavTreeNodeDto[];
  /** The payload's unit (every figure of `dash` is in it). */
  unit: DisplayUnit;
  animated?: boolean;
};

/** Second-row dashboard-style cards for first-level portfolio nav children (subset of dashboard accounts). */
export function PortfolioNavChildDetailCards({
  dash,
  navChildren,
  unit,
  animated = true,
}: PortfolioNavChildDetailCardsProps) {
  const sorted = useMemo(() => {
    const filtered = navChildren.filter(
      (c) =>
        c.route_path?.trim() &&
        (c.chart_inactive !== true || navChildCardHasActivity(dash, c))
    );
    return [...filtered].sort((a, b) => {
      return compareDashboardCardMainDesc(mainValueForNavChild(dash, a), mainValueForNavChild(dash, b));
    });
  }, [navChildren, dash]);

  if (!sorted.length) return null;

  return (
    <>
      {sorted.map((child) => {
        const value = mainValueForNavChild(dash, child);
        const entry = requireNavCardMetrics(dash, child);
        const metricsByPeriod = entry.child;
        const br = breakdownForNavChild(child, dash);
        const rp = child.route_path?.trim() ?? "";
        const cashClass =
          child.slug === "cash_eqs" ||
          child.slug === "cash_savings" ||
          child.asset_group_slug?.startsWith("cash_eqs")
            ? "card--cash"
            : "";
        const fxMissing = entry.value.fx_missing;
        const syncStale = entry.value.sync_stale;

        return (
          <DetailedGroupCard
            key={child.node_id}
            title={resolveNavTreeLabel(child)}
            titleTo={rp || undefined}
            titleColorRgb={child.color_rgb}
            value={value}
            unit={unit}
            fxMissing={fxMissing}
            syncStale={syncStale}
            animated={animated}
            className={cashClass}
            valueDelta={
              <CardValueDayPl
                metricsByPeriod={metricsByPeriod}
                unit={unit}
                animated={animated}
              />
            }
            metrics={
              <DashboardCardGroupMetrics
                metricsByPeriod={metricsByPeriod}
                unit={unit}
                animated={animated}
              />
            }
            breakdown={
              br ? (
                <DashboardCardBreakdown
                  lines={br.lines}
                  bottomLines={br.bottomLines}
                  pinBottomToCard={br.pinBottom}
                  unit={unit}
                  animated={false}
                />
              ) : null
            }
          />
        );
      })}
    </>
  );
}
