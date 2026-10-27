import type { ReactNode } from "react";
import { CompactEntityCard } from "../../components/dashboard/CompactEntityCard";
import { CardValueDayPl, DashboardCardGroupMetrics } from "../../components/dashboard/DashboardCardGroupMetrics";
import { PortfolioEntityCardsStrip } from "../../components/dashboard/PortfolioEntityCardsStrip";
import { PortfolioNavChildDetailCards } from "../../components/dashboard/PortfolioNavChildDetailCards";
import { PageTitleRow } from "../../components/layout/PageTitleRow";
import { loadableClass } from "../../components/ui/Loadable";
import type { cardGroupMetricsByPeriodFromAccounts } from "../../dashboardCardBreakdown";
import type { dashPickForNavStrip } from "../../queries/fetchers";
import styles from "../AccountDetailPage.module.css";

type LayoutProps = {
  title: string;
  accountMetricsAgg: ReturnType<typeof cardGroupMetricsByPeriodFromAccounts>;
  /** The unit the strip renders in (`AccountDetailPageData.stripUnit`). */
  stripUnit: "clp" | "usd";
  heroClp: number;
  heroApiUsd: number | null;
  dash: ReturnType<typeof dashPickForNavStrip> | null;
  accountNavChildren: NonNullable<
    ReturnType<typeof import("../../portfolioNavFromApi").findNavTreeNodeByAccountId>
  >["children"];
  /** Extra bare cards for the strip's second row (same `.cards` grid as the hero, like group pages). */
  stripDetailSlots?: ReactNode;
  children: ReactNode;
  /** Rendered right-aligned at the bottom of the page (e.g. Export button). */
  toolbar?: ReactNode;
  /** The page data is not in (or is held prior-unit data): the body dims. */
  loading?: boolean;
  /** Nav child dashboard cards (second strip row). Off for leaf pages that never show them (e.g. credit card). */
  showNavChildCards?: boolean;
};

export function AccountDetailSharedLayout({
  title,
  accountMetricsAgg,
  stripUnit,
  heroClp,
  heroApiUsd,
  dash,
  accountNavChildren,
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
        navChildren={accountNavChildren}
        showUsd={stripUnit === "usd"}
        animated
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
      <PageTitleRow title={title} />
      <div className={loadableClass(loading, styles.contentShell)}>
        <PortfolioEntityCardsStrip
          compactSlot={
            <CompactEntityCard
              showUsd={stripUnit === "usd"}
              clp={stripUnit === "usd" ? 0 : heroClp}
              apiUsd={stripUnit === "usd" ? heroApiUsd : null}
              animated
              stripInner
              valueVariant="main"
              valueDelta={
                <CardValueDayPl
                  metricsByPeriod={accountMetricsAgg}
                  showUsd={stripUnit === "usd"}
                  animated
                />
              }
              metrics={
                <DashboardCardGroupMetrics
                  metricsByPeriod={accountMetricsAgg}
                  showUsd={stripUnit === "usd"}
                  animated
                />
              }
            />
          }
          detailSlots={detailSlots}
        />
        {children}
        {toolbar ? (
          <div style={{ display: "flex", justifyContent: "flex-end", marginTop: "1.25rem" }}>
            {toolbar}
          </div>
        ) : null}
      </div>
    </main>
  );
}
