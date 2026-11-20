import type { ReactNode } from "react";
import { cn } from "../cn";
import { useTranslation } from "../i18n";
import { BasketGlanceRail, BasketGlanceTitle } from "../components/group/BasketGlance";
import { GroupInfoBase, type GroupInfoPortfolioStrip } from "../components/group/GroupInfoBase";
import { PageGridTile } from "../components/layout/PageGridTile";
import { loadableClass } from "../components/ui/Loadable";
import type { GroupInfoTableAccount } from "../useGroupInfoConsolidatedTables";
import type { BasketGlanceDto } from "../types";
// The position page's layout, tile for tile (band, P/L | Rentabilidad, full rows).
import styles from "./accountDetail/PositionAccountDetailPage.module.css";

/**
 * The page of a portfolio group declared a basket (`NavTreeNodeDto.basket`: a few positions that
 * are one investment), laid out as a unit position's page: a title line (the group, its value
 * and day P/L), the group's valuation chart beside the basket's rail (server `basket_glance` on
 * the nav context: the members' breakdown, the value index, the composition, día / mes / año),
 * «P/L mensual» beside «Rentabilidad», then the group's movements and detalle across the page,
 * and the export. One column below 880, the chart before the rail. The charts are the group
 * page's (built by `GroupInfoPage`), the tables `GroupInfoBase`'s.
 */
export function BasketGroupPage({
  title,
  groupSlug,
  glance,
  glanceLoading,
  pendingMembers,
  loading,
  portfolio,
  tableAccounts,
  valuationChart,
  plChart,
  exportSlot,
}: {
  /** The nav node's label (the title while the glance is pending). */
  title: string;
  groupSlug: string;
  /** The nav context's `basket_glance`; undefined (or a null not refetched yet) while pending. */
  glance: BasketGlanceDto | undefined;
  /** The nav context is not this unit's yet: the title figures and the rail dim. */
  glanceLoading: boolean;
  /** The member count the nav tree states (the pending breakdown's lines). */
  pendingMembers: number;
  /** The page bundle is a placeholder or held: the page dims. */
  loading: boolean;
  portfolio: GroupInfoPortfolioStrip | null;
  tableAccounts: readonly GroupInfoTableAccount[];
  valuationChart: ReactNode;
  /** «P/L mensual»; null when the loaded bundle says the group has no P/L. */
  plChart: ReactNode | null;
  exportSlot: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <GroupInfoBase
      title={title}
      loading={loading}
      portfolio={portfolio}
      charts={null}
      tableAccounts={tableAccounts}
      accountsTree={null}
      exportSlot={exportSlot}
      basket={{
        titleRow: <BasketGlanceTitle glance={glance} fallbackTitle={title} loading={glanceLoading} />,
        arrange: ({ returns, detail, flows, exportRow }) => (
          <>
            <PageGridTile id="basket-band" className={cn("page-grid", styles.band)}>
              <div className={cn("chart-grid chart-grid--full-line", styles.bandChart)}>{valuationChart}</div>
              <div className={loadableClass(glanceLoading, styles.bandRail)} aria-busy={glanceLoading || undefined}>
                <BasketGlanceRail groupSlug={groupSlug} glance={glance} pendingMembers={pendingMembers} />
              </div>
            </PageGridTile>

            <PageGridTile id="perf-combo" className={cn("chart-grid chart-grid--full-line", styles.wide, styles.plTile)}>
              {plChart ?? (
                <>
                  <h2>{t("accountDetail.positionGlance.plMonthlyTitle")}</h2>
                  <p className="muted">{t("accountDetail.monthlyPerfNotEnough")}</p>
                </>
              )}
            </PageGridTile>

            <PageGridTile id="returns" className={cn(styles.narrow, styles.second)}>
              {returns}
            </PageGridTile>

            {flows ? (
              <PageGridTile id="wealth-flows" className={styles.fullRow}>
                {flows}
              </PageGridTile>
            ) : null}

            {detail ? (
              <PageGridTile id="detail" className={styles.fullRow}>
                {detail}
              </PageGridTile>
            ) : null}

            {exportRow ? (
              <PageGridTile id="export" className="page-tile--end">
                {exportRow}
              </PageGridTile>
            ) : null}
          </>
        ),
      }}
    />
  );
}
