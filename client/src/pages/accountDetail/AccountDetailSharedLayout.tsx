import type { ReactNode } from "react";
import { CompactEntityCard } from "../../components/CompactEntityCard";
import { DashboardCardGroupMetrics } from "../../components/DashboardCardGroupMetrics";
import { PortfolioEntityCardsStrip } from "../../components/PortfolioEntityCardsStrip";
import { PortfolioNavChildDetailCards } from "../../components/PortfolioNavChildDetailCards";
import { PageTitleRow } from "../../components/PageTitleRow";
import type { EntityColorTarget } from "../../entityColor";
import type { CardGroupMetricsPeriod } from "../../dashboardCardBreakdown";
import type { accountCardTitleBalanceDelta } from "../../dashboardCardBreakdown";
import type { cardGroupMetricsFromAccounts } from "../../dashboardCardBreakdown";
import type { DashboardResponse } from "../../types";

type LayoutProps = {
  title: string;
  accountColorRgb: string | null;
  pageColorTarget: EntityColorTarget | undefined;
  accountId: number;
  accountName: string;
  accountTitleDelta: ReturnType<typeof accountCardTitleBalanceDelta>;
  accountMetricsAgg: ReturnType<typeof cardGroupMetricsFromAccounts>;
  displayUnit: "clp" | "usd";
  metricsPeriod: CardGroupMetricsPeriod;
  heroClp: number;
  heroApiUsd: number | null;
  dash: DashboardResponse | null;
  overviewPoints: Record<string, string | number | null>[];
  accountNavChildren: NonNullable<
    ReturnType<typeof import("../../portfolioNavFromApi").findNavTreeNodeByAccountId>
  >["children"];
  heroSubtitle?: ReactNode;
  children: ReactNode;
};

export function AccountDetailSharedLayout({
  title,
  accountColorRgb,
  pageColorTarget,
  accountId,
  accountName,
  accountTitleDelta,
  accountMetricsAgg,
  displayUnit,
  metricsPeriod,
  heroClp,
  heroApiUsd,
  dash,
  overviewPoints,
  accountNavChildren,
  heroSubtitle,
  children,
}: LayoutProps) {
  return (
    <main>
      <PageTitleRow title={title} colorRgb={accountColorRgb} colorTarget={pageColorTarget} />
      <PortfolioEntityCardsStrip
        compactSlot={
          <CompactEntityCard
            label={accountName}
            balanceDelta={accountTitleDelta}
            showUsd={displayUnit === "usd"}
            clp={displayUnit === "usd" ? 0 : heroClp}
            apiUsd={displayUnit === "usd" ? heroApiUsd : null}
            cardSlug={`acc-${accountId}-hero`}
            animated
            stripInner
            valueVariant="main"
            metrics={
              <DashboardCardGroupMetrics
                metrics={accountMetricsAgg}
                showUsd={displayUnit === "usd"}
                period={metricsPeriod}
                cardSlug={`acc-${accountId}-hero`}
                animated
              />
            }
          />
        }
        detailSlots={
          dash && accountNavChildren.length > 0 ? (
            <PortfolioNavChildDetailCards
              dash={dash}
              overviewPoints={overviewPoints}
              navChildren={accountNavChildren}
              showUsd={displayUnit === "usd"}
              metricsPeriod={metricsPeriod}
              animated
            />
          ) : null
        }
      />
      {heroSubtitle ? <p className="muted">{heroSubtitle}</p> : null}
      {children}
    </main>
  );
}
