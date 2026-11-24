import { cn } from "../../cn";
import { useTranslation } from "../../i18n";
import { AccountFlowsSection } from "../../components/account/AccountFlowsSection";
import { AccountImportSection } from "../../components/account/AccountImportSection";
import { AccountBookLedgerSection } from "../../components/account/AccountBookLedgerSection";
import {
  PositionGlanceRail,
  PositionGlanceTitle,
  type PositionGlanceShape,
} from "../../components/account/PositionGlance";
import { ExportToolbarButton } from "../../components/export/ExportModal";
import { PageGridTile } from "../../components/layout/PageGridTile";
import { PeriodReturnsWithBenchmark } from "../../components/perf/PeriodReturnsTable";
import { Table } from "../../components/ui/Table";
import { loadableClass } from "../../components/ui/Loadable";
import { formatMoney } from "../../format";
import { supportsBookLedgerEdit } from "../../accountBookLedgerEdit";
import { supportsUnitsFlowMovements } from "../../accountMovementCreate";
import { AccountDetailSharedLayout } from "./AccountDetailSharedLayout";
import {
  AccountDetalleSurface,
  AccountPlYtdCombo,
  AccountValuationChart,
  useAccountChartSurfaces,
  useAccountMovementForm,
} from "./accountSurfaces";
import type { AccountDetailPageData } from "./useAccountDetailPageData";
import styles from "./PositionAccountDetailPage.module.css";

/**
 * The page of a unit position (server `position_glance`: a stock or a coin held in units, a fund
 * held in cuotas — AFP, AFC, Fintual and APV goals — held today or sold out): a title line (ticker
 * or account name, value, day P/L; the instrument's name or the fund's series and today's price
 * under it), then the valuation chart beside the glance's rail, «P/L mensual» beside
 * «Rentabilidad», then the movements and the detalle across the page (side by side their rows
 * could not stay on one line), an APV account's state-bonus list, and the export. One column below
 * 880, in that reading order (the chart before the rail). Its surfaces and its add-movement form
 * are the standard page's (`accountSurfaces.tsx`, picked by capability); the hero strip and the
 * position table are left out — the title line and the rail carry their figures.
 */
export function PositionAccountDetailPage({
  data,
  pendingShape,
}: {
  data: AccountDetailPageData;
  /** The glance's remembered rows while the bundle is pending. */
  pendingShape: PositionGlanceShape | null;
}) {
  const { t } = useTranslation();
  const { summary, displayUnit, periodReturns, monthlyPerfRows, depositInflows } = data;
  const loading = data.contentLoading;
  const glance = data.positionGlance ?? undefined;
  const surfaces = useAccountChartSurfaces(data, { compactControls: true });
  const { form: addMovementsForm } = useAccountMovementForm(data);
  const showBookLedgerEdit = supportsBookLedgerEdit(summary.book_ledger_edit);
  // undefined = still loading (the table frames itself); null = the server states none.
  const showPeriodReturns = periodReturns !== null;
  const noPerfRows = monthlyPerfRows.length === 0 && !loading;
  // A fund's units are cuotas (the detalle's inflow reads «Cuotas (aportes)»); before the glance
  // is in, the AFP / AFC category says so, as on the standard page.
  const isFund =
    glance != null ? glance.instrument.kind === "fund" : summary.category_slug === "afp" || summary.category_slug === "afc";
  // The units column is named by the units-flow form's unit (cuotas, BTC, ETH), else «Cuotas» on a fund.
  const unitLabel = supportsUnitsFlowMovements(summary.movement_create)
    ? (summary.movement_create.unit_label ?? null)
    : isFund
      ? "cuotas"
      : null;
  const unitsLabel = unitLabel ? t(`accountDetail.positionGlance.unitsColumn.${unitLabel}`) : undefined;
  // The state bonus only exists on APV accounts: while loading they show the table's frame.
  const showStateContribution =
    depositInflows.state_contribution_events.length > 0 || (loading && summary.category_slug === "apv");

  return (
    <AccountDetailSharedLayout
      title={data.ts.name}
      titleRow={
        <PositionGlanceTitle
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
      <PageGridTile id="position-band" className={cn("page-grid", styles.band)}>
        <div className={cn("chart-grid chart-grid--full-line", styles.bandChart)}>
          <AccountValuationChart data={data} surfaces={surfaces} hideLegend />
        </div>
        <div className={loadableClass(loading, styles.bandRail)} aria-busy={loading || undefined}>
          <PositionGlanceRail
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
            <h2>{t("accountDetail.positionGlance.plMonthlyTitle")}</h2>
            <p className="muted">{t("accountDetail.monthlyPerfNotEnough")}</p>
          </>
        ) : (
          <AccountPlYtdCombo
            data={data}
            surfaces={surfaces}
            title={t("accountDetail.positionGlance.plMonthlyTitle")}
            titleAs="h2"
          />
        )}
      </PageGridTile>

      <PageGridTile id="returns" className={cn(styles.narrow, styles.second)}>
        {showPeriodReturns ? (
          <PeriodReturnsWithBenchmark
            title={t("periodReturns.title")}
            data={periodReturns ?? null}
            displayUnit={displayUnit}
            scope={{ accountId: summary.account_id }}
            surfaceId={`account.${summary.account_id}.returns`}
            loading={loading}
            compact
          />
        ) : null}
      </PageGridTile>

      <AccountFlowsSection
        title={t("accountDetail.positionGlance.movementsTitle")}
        className={styles.fullRow}
        addMovementsForm={addMovementsForm}
        accountId={summary.account_id}
        unitsKind={summary.units_kind}
        unitsAsColumn
        unitsLabel={unitsLabel}
      />

      <PageGridTile id="detail" className={styles.fullRow}>
        {noPerfRows ? null : <AccountDetalleSurface data={data} headingAs="h2" isCuotaLedgerAccount={isFund} />}
      </PageGridTile>

      {showStateContribution ? (
        <PageGridTile
          id="state-contribution"
          className={loadableClass(loading, styles.fullRow)}
          aria-busy={loading || undefined}
        >
          <h2>{t("accountDetail.stateContribution.title")}</h2>
          <Table
            header={
              <thead>
                <tr>
                  <th>{t("accountDetail.stateContribution.colDate")}</th>
                  <th>{t("accountDetail.stateContribution.colAmount")}</th>
                  <th>{t("accountDetail.stateContribution.colAccumulated")}</th>
                </tr>
              </thead>
            }
          >
            {depositInflows.state_contribution_events.map((e, idx) => (
              <tr key={`state-${e.occurred_on}-${idx}`}>
                <td>{e.occurred_on}</td>
                <td className="mono">{formatMoney({ value: e.amt, currency: depositInflows.unit })}</td>
                <td className="mono muted">{formatMoney({ value: e.cumulative, currency: depositInflows.unit })}</td>
              </tr>
            ))}
          </Table>
        </PageGridTile>
      ) : null}

      {showBookLedgerEdit ? (
        <AccountBookLedgerSection accountId={summary.account_id} displayUnit={displayUnit} />
      ) : null}
    </AccountDetailSharedLayout>
  );
}
