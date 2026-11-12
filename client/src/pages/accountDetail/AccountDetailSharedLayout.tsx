import type { ReactNode } from "react";
import { CompactEntityCard } from "../../components/dashboard/CompactEntityCard";
import { CardValueDayPl, DashboardCardGroupMetrics } from "../../components/dashboard/DashboardCardGroupMetrics";
import { PortfolioEntityCardsStrip } from "../../components/dashboard/PortfolioEntityCardsStrip";
import { PortfolioNavChildDetailCards } from "../../components/dashboard/PortfolioNavChildDetailCards";
import { PageTitleRow } from "../../components/layout/PageTitleRow";
import { PageGridTile } from "../../components/layout/PageGridTile";
import { loadableClass } from "../../components/ui/Loadable";
import type { cardMetricsByPeriodForAccountRow } from "../../dashboardCardBreakdown";
import type { dashPickForNavStrip } from "../../queries/fetchers";
import styles from "../AccountDetailPage.module.css";
import type { DisplayUnit } from "../../queries/keys";

type LayoutProps = {
  title: string;
  accountMetricsAgg: ReturnType<typeof cardMetricsByPeriodForAccountRow>;
  /** The unit the strip renders in (`AccountDetailPageData.stripUnit`). */
  stripUnit: DisplayUnit;
  /** The hero balance in `stripUnit` (null: none on file). */
  heroValue: number | null;
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
  heroValue,
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
        unit={stripUnit}
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

  // The page sits on the column grid (styles/page-grid.css): <main> and the content shell are
  // page grids, every section below is a tile with its heading inside, and the row gap is the
  // only space between them.
  return (
    <main>
      <PageTitleRow title={title} />
      <div className={loadableClass(loading, styles.contentShell, "page-grid")}>
        {/* The strip is a grid of its own (its card blocks are subgrids), so the tile passes the columns through. */}
        <PageGridTile id="strip" className="page-grid">
          <PortfolioEntityCardsStrip
            compactSlot={
              <CompactEntityCard
                value={heroValue}
                unit={stripUnit}
                animated
                valueVariant="main"
                valueDelta={
                  <CardValueDayPl
                    metricsByPeriod={accountMetricsAgg}
                    unit={stripUnit}
                    animated
                  />
                }
                metrics={
                  <DashboardCardGroupMetrics
                    metricsByPeriod={accountMetricsAgg}
                    unit={stripUnit}
                    animated
                  />
                }
              />
            }
            detailSlots={detailSlots}
          />
        </PageGridTile>
        {children}
        {toolbar ? (
          <PageGridTile id="export" className="page-tile--end">
            {toolbar}
          </PageGridTile>
        ) : null}
      </div>
    </main>
  );
}
