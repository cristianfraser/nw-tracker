import type { ReactNode } from "react";
import { cn } from "../cn";
import { useTranslation } from "../i18n";
import {
  GroupGlanceStrip,
  GroupGlanceTable,
  GroupGlanceTitle,
} from "../components/group/GroupGlance";
import { GroupInfoBase, type GroupInfoPortfolioStrip } from "../components/group/GroupInfoBase";
import { PageGridTile } from "../components/layout/PageGridTile";
import { loadableClass } from "../components/ui/Loadable";
import type { GroupInfoTableAccount } from "../useGroupInfoConsolidatedTables";
import type { GroupGlanceDto, GroupGlanceRowDto } from "../types";
import styles from "./InvestmentGroupPage.module.css";

/**
 * The page of a group at or under «Inversiones» (`NavTreeNodeDto.investment_glance`;
 * docs/investment-group-pages-plan.md): a title line (value, day P/L, positions · aportes ·
 * total), the band [valuation chart | value map, the sold children under it], the strip
 * [composition of today's value | día / mes / año], the children table (server `group_glance` on
 * the nav context), the pair [«Valor por posición» | «P/L mensual»] under one control row, then
 * Rentabilidad | Detalle, the movements and the export. No card strip, no accounts tree. The
 * charts are the group page's (built by `GroupInfoPage`), the tables `GroupInfoBase`'s. One
 * column below 880, in DOM order.
 */
export function InvestmentGroupPage({
  title,
  glance,
  glanceLoading,
  pendingLabels,
  loading,
  portfolio,
  tableAccounts,
  exportSlot,
  valuationChart,
  valueMap,
  pairControls,
  positionsChart,
  plChart,
  colorForRow,
  totalColor,
}: {
  /** The nav node's label (the title while the glance is pending). */
  title: string;
  /** The nav context's `group_glance`; undefined while pending. */
  glance: GroupGlanceDto | undefined;
  /** The nav context is not this unit's yet: the title figures, the strip and the table dim. */
  glanceLoading: boolean;
  /** The nav node's children's names (the pending table's rows). */
  pendingLabels: readonly string[];
  /** The page bundle is a placeholder or held: the page dims. */
  loading: boolean;
  portfolio: GroupInfoPortfolioStrip | null;
  tableAccounts: readonly GroupInfoTableAccount[];
  exportSlot: ReactNode;
  /** «Valorización y aportes» (the group total and its aportes). */
  valuationChart: ReactNode;
  /** The value map (always the map, its own día / mes / año row). */
  valueMap: ReactNode;
  /** The pair's shared Período / Rango row. */
  pairControls: ReactNode;
  /** «Valor por posición» (stacked value, or the share view). */
  positionsChart: ReactNode;
  /** «P/L mensual»; null when the loaded bundle says the group has no P/L. */
  plChart: ReactNode | null;
  /** A child row's dot colour (the charts' colour maps). */
  colorForRow: (row: GroupGlanceRowDto) => string;
  /** The total row's dot colour (the group's). */
  totalColor: string;
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
      layout={{
        titleRow: <GroupGlanceTitle glance={glance} fallbackTitle={title} loading={glanceLoading} />,
        arrange: ({ returns, detail, flows, exportRow }) => (
          <>
            <PageGridTile id="investment-band" className={cn("page-grid", styles.band)}>
              <div className={cn("chart-grid chart-grid--full-line", styles.bandChart)}>{valuationChart}</div>
              <div className={cn("chart-grid chart-grid--full-line", styles.bandMap)}>
                {valueMap}
              </div>
            </PageGridTile>

            <PageGridTile
              id="investment-strip"
              className={loadableClass(glanceLoading, cn("page-grid", styles.strip))}
              aria-busy={glanceLoading || undefined}
            >
              <GroupGlanceStrip glance={glance} />
            </PageGridTile>

            <PageGridTile id="investment-table" className={styles.tableTile}>
              <GroupGlanceTable
                glance={glance}
                title={title}
                pendingLabels={pendingLabels}
                colorFor={colorForRow}
                totalColor={totalColor}
                loading={glanceLoading}
              />
            </PageGridTile>

            <PageGridTile id="investment-pair" className={cn("page-grid", styles.pair)}>
              <div className={styles.pairControls}>{pairControls}</div>
              <div className={cn("chart-grid chart-grid--full-line", styles.pairFirst)}>{positionsChart}</div>
              <div className={cn("chart-grid chart-grid--full-line", styles.pairSecond)}>
                {plChart ?? (
                  <>
                    <h2>{t("accountDetail.positionGlance.plMonthlyTitle")}</h2>
                    <p className="muted">{t("accountDetail.monthlyPerfNotEnough")}</p>
                  </>
                )}
              </div>
            </PageGridTile>

            {returns ? (
              <PageGridTile id="returns" className={styles.narrow}>
                {returns}
              </PageGridTile>
            ) : null}

            {detail ? (
              <PageGridTile id="detail" className={cn(styles.wide, returns != null && styles.second)}>
                {detail}
              </PageGridTile>
            ) : null}

            {flows ? (
              <PageGridTile id="wealth-flows" className={styles.fullRow}>
                {flows}
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
