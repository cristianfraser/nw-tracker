import { cn } from "../../cn";
import { useTranslation } from "../../i18n";
import { AccountFlowsSection } from "../../components/account/AccountFlowsSection";
import { AccountImportSection } from "../../components/account/AccountImportSection";
import {
  EquityGlanceRail,
  EquityGlanceTitle,
  type EquityGlanceShape,
} from "../../components/account/EquityGlance";
import { ExportToolbarButton } from "../../components/export/ExportModal";
import { PageGridTile } from "../../components/layout/PageGridTile";
import { PeriodReturnsWithBenchmark } from "../../components/perf/PeriodReturnsTable";
import { loadableClass } from "../../components/ui/Loadable";
import { AccountDetailSharedLayout } from "./AccountDetailSharedLayout";
import {
  AccountDetalleSurface,
  AccountPlYtdCombo,
  AccountValuationChart,
  useAccountChartSurfaces,
  useAccountMovementForm,
} from "./accountSurfaces";
import type { AccountDetailPageData } from "./useAccountDetailPageData";
import styles from "./EquityAccountDetailPage.module.css";

/**
 * The page of a stock (an equity account held in shares, server `equity_glance`): a title line
 * (ticker, value, day P/L; the name and today's price under it), then the valuation chart beside
 * the glance's rail, «P/L mensual» beside «Rentabilidad», then the movements and the detalle
 * across the page (side by side their rows could not stay on one line), and the export. One column below 880, in that reading order (the chart before the rail). Its
 * surfaces are the standard page's (`accountSurfaces.tsx`); the hero strip and the position
 * table are left out — the title line and the rail carry their figures.
 */
export function EquityAccountDetailPage({
  data,
  pendingShape,
}: {
  data: AccountDetailPageData;
  /** The glance's remembered rows while the bundle is pending. */
  pendingShape: EquityGlanceShape | null;
}) {
  const { t } = useTranslation();
  const { summary, displayUnit, periodReturns, monthlyPerfRows } = data;
  const loading = data.contentLoading;
  const glance = data.equityGlance ?? undefined;
  const surfaces = useAccountChartSurfaces(data, { compactControls: true });
  const { form: addMovementsForm } = useAccountMovementForm(data);
  // undefined = still loading (the table frames itself); null = the server states none.
  const showPeriodReturns = periodReturns !== null;
  const noPerfRows = monthlyPerfRows.length === 0 && !loading;

  return (
    <AccountDetailSharedLayout
      title={data.ts.name}
      titleRow={
        <EquityGlanceTitle
          glance={glance}
          fallbackTitle={data.ts.name}
          pendingShape={pendingShape}
          loading={loading}
        />
      }
      strip={null}
      toolbar={<ExportToolbarButton exportPath={`/api/accounts/${summary.account_id}/export.xlsx`} />}
      loading={loading}
    >
      {/* Self-gates on the server's import specs (a capability): hidden until they arrive. */}
      <AccountImportSection accountId={summary.account_id} displayUnit={displayUnit} />

      {/* The valuation chart beside the rail; on a phone the chart first, then the rail's groups. */}
      <PageGridTile id="equity-band" className={cn("page-grid", styles.band)}>
        <div className={cn("chart-grid chart-grid--full-line", styles.bandChart)}>
          <AccountValuationChart data={data} surfaces={surfaces} hideLegend />
        </div>
        <div className={loadableClass(loading, styles.bandRail)} aria-busy={loading || undefined}>
          <EquityGlanceRail
            accountId={summary.account_id}
            glance={glance}
            position={summary.position}
            pendingShape={pendingShape}
          />
        </div>
      </PageGridTile>

      <PageGridTile id="perf-combo" className={cn("chart-grid chart-grid--full-line", styles.wide, styles.plTile)}>
        {noPerfRows ? (
          <>
            <h2>{t("accountDetail.equityGlance.plMonthlyTitle")}</h2>
            <p className="muted">{t("accountDetail.monthlyPerfNotEnough")}</p>
          </>
        ) : (
          <AccountPlYtdCombo
            data={data}
            surfaces={surfaces}
            title={t("accountDetail.equityGlance.plMonthlyTitle")}
            titleAs="h2"
          />
        )}
      </PageGridTile>

      <PageGridTile id="returns" className={cn(styles.narrow, styles.second)}>
        {showPeriodReturns ? (
          <PeriodReturnsWithBenchmark
            data={periodReturns ?? null}
            displayUnit={displayUnit}
            scope={{ accountId: summary.account_id }}
            surfaceId={`account.${summary.account_id}.returns`}
            loading={loading}
            compact={{ title: t("periodReturns.title") }}
          />
        ) : null}
      </PageGridTile>

      <AccountFlowsSection
        title={t("accountDetail.equityGlance.movementsTitle")}
        className={styles.fullRow}
        addMovementsForm={addMovementsForm}
        accountId={summary.account_id}
        unitsKind={summary.units_kind}
        unitsAsColumn
      />

      <PageGridTile id="detail" className={styles.fullRow}>
        {noPerfRows ? null : <AccountDetalleSurface data={data} headingAs="h2" />}
      </PageGridTile>
    </AccountDetailSharedLayout>
  );
}
