import type { ReactNode } from "react";
import { cn } from "../../cn";
import { CompactEntityCard } from "../../components/dashboard/CompactEntityCard";
import { DashboardCardGroupMetrics } from "../../components/dashboard/DashboardCardGroupMetrics";
import { PortfolioEntityCardsStrip } from "../../components/dashboard/PortfolioEntityCardsStrip";
import { PortfolioNavChildDetailCards } from "../../components/dashboard/PortfolioNavChildDetailCards";
import { PageTitleRow } from "../../components/layout/PageTitleRow";
import type { EntityColorTarget } from "../../entityColor";
import type { CardGroupMetricsPeriod } from "../../dashboardCardBreakdown";
import type { accountCardTitleBalanceDelta } from "../../dashboardCardBreakdown";
import type { cardGroupMetricsFromAccounts } from "../../dashboardCardBreakdown";
import type { dashPickForNavStrip } from "../../queries/fetchers";
import styles from "../AccountDetailPage.module.css";

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
  dash: ReturnType<typeof dashPickForNavStrip> | null;
  overviewPoints: Record<string, string | number | null>[];
  accountNavChildren: NonNullable<
    ReturnType<typeof import("../../portfolioNavFromApi").findNavTreeNodeByAccountId>
  >["children"];
  heroSubtitle?: ReactNode;
  /** Extra bare cards for the strip's second row (same `.cards` grid as the hero, like group pages). */
  stripDetailSlots?: ReactNode;
  children: ReactNode;
  /** Rendered below the title row (e.g. Export button). */
  toolbar?: ReactNode;
  loading?: boolean;
  /** Nav child dashboard cards (second strip row). Off for leaf pages that never show them (e.g. credit card). */
  showNavChildCards?: boolean;
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
  stripDetailSlots,
  children,
  toolbar,
  loading = false,
  showNavChildCards = true,
}: LayoutProps) {
  const navChildDetailCards =
    showNavChildCards && dash && accountNavChildren.length > 0 ? (
      <PortfolioNavChildDetailCards
        dash={dash}
        overviewPoints={overviewPoints}
        navChildren={accountNavChildren}
        showUsd={displayUnit === "usd"}
        metricsPeriod={metricsPeriod}
        animated
        placeholderPhase={loading}
      />
    ) : null;

  const detailSlots =
    navChildDetailCards != null || stripDetailSlots != null ? (
      <>
        {navChildDetailCards}
        {stripDetailSlots}
      </>
    ) : null;

  return (
    <main>
      <PageTitleRow title={title} colorRgb={accountColorRgb} colorTarget={pageColorTarget} />
      {toolbar}
      <div className={cn(styles.contentShell, loading && styles.contentShellLoading)}>
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
              placeholderPhase={loading}
              stripInner
              valueVariant="main"
              metrics={
                <DashboardCardGroupMetrics
                  metrics={accountMetricsAgg}
                  showUsd={displayUnit === "usd"}
                  period={metricsPeriod}
                  cardSlug={`acc-${accountId}-hero`}
                  animated
                  placeholderPhase={loading}
                />
              }
            />
          }
          detailSlots={detailSlots}
        />
        {heroSubtitle ? <p className="muted">{heroSubtitle}</p> : null}
        {children}
      </div>
    </main>
  );
}
