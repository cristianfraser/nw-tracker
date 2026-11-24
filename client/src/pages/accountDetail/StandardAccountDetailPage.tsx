import { useTranslation } from "../../i18n";
import { AccountFlowsSection } from "../../components/account/AccountFlowsSection";
import { PeriodReturnsWithBenchmark } from "../../components/perf/PeriodReturnsTable";
import { CheckingCartolaMonthTable } from "./CheckingCartolaMonthTable";
import { CheckingLedgerAnchorForm } from "../../components/account/CheckingLedgerAnchorForm";
import { Table } from "../../components/ui/Table";
import { loadableClass } from "../../components/ui/Loadable";
import { PageGridTile } from "../../components/layout/PageGridTile";
import { formatInstrumentUnits, formatMoney, formatPct } from "../../format";
import { formatOptionStrikeDollars } from "../../formatNative";
import { AccountBookLedgerSection } from "../../components/account/AccountBookLedgerSection";
import { AccountImportSection } from "../../components/account/AccountImportSection";
import { supportsBookLedgerEdit } from "../../accountBookLedgerEdit";
import { AccountDetailSharedLayout } from "./AccountDetailSharedLayout";
import { ExportToolbarButton } from "../../components/export/ExportModal";
import type { AccountDetailPageData } from "./useAccountDetailPageData";
import {
  AccountDeltaAccumCombo,
  AccountDetalleSurface,
  AccountPlYtdCombo,
  AccountValuationChart,
  useAccountChartSurfaces,
  useAccountMovementForm,
} from "./accountSurfaces";
import { MONTHLY_PERF_COLLAPSED } from "./shared";

type Props = {
  data: AccountDetailPageData;
};

export function StandardAccountDetailPage({ data }: Props) {
  const { t } = useTranslation();
  const {
    summary,
    depositInflows,
    displayUnit,
    monthlyPerfRows,
    periodReturns,
    checkingCartolaMonths,
  } = data;

  // The page data is not in (or is held prior-unit data): sections render their frame, dimmed.
  const loading = data.contentLoading;
  // Capability forms (movement_create / book_ledger_edit / mortgage_payment_create) stay hidden
  // until the bundle states them: a wrong form is worse than a late one.
  const { form: addMovementsForm, isForeignCashAccount: isUsdCashAccount } = useAccountMovementForm(data);
  const showBookLedgerEdit = supportsBookLedgerEdit(summary.book_ledger_edit);
  const surfaces = useAccountChartSurfaces(data);

  // An option contract account (server `option_contract`): its terms above the position, its own kinds on the form.
  const optionContract = summary.option_contract ?? null;
  const isMovementCartolaAccount = summary.category_slug === "cuenta_corriente" || summary.category_slug === "cuenta_vista";
  const showMonthlyPerformance =
    !isMovementCartolaAccount && summary.category_slug !== "cuenta_ahorro_vivienda";
  const isAfpAccount = summary.category_slug === "afp";
  const isAfcAccount = summary.category_slug === "afc";
  // Cuota-ledger accounts (AFP, AFC): the perf table reads contributions in cuotas.
  const isCuotaLedgerAccount = isAfpAccount || isAfcAccount;
  const showPositionBlock = !isMovementCartolaAccount && !isUsdCashAccount;
  const showPeriodReturns =
    periodReturns === undefined
      ? data.accountDashRow == null || data.accountDashRow.has_period_returns === true
      : periodReturns !== null;
  const showEquityReturnColumns = summary.position?.dividends != null;
  // Every money figure of the summary is the server's, in its `unit` (the request's display unit).
  const summaryUnit = summary.position?.unit ?? summary.unit;
  const money = (v: number | null | undefined) =>
    v != null && Number.isFinite(v) ? formatMoney({ value: v, currency: summaryUnit }) : "—";
  // Shown only when the ticker is held through more than one cash account (broker).
  const brokerHoldings = summary.position?.brokers ?? [];

  return (
    <AccountDetailSharedLayout
      toolbar={<ExportToolbarButton exportPath={`/api/accounts/${summary.account_id}/export.xlsx`} />}
      title={data.ts.name}
      accountMetricsAgg={data.accountMetricsAgg}
      stripUnit={data.stripUnit}
      heroValue={
        data.accountDashRow?.current_value ??
        (data.stripUnit === summary.unit ? summary.latest_valuation ?? 0 : data.chartUnitVal)
      }
      dash={data.dash}
      accountNavChildren={data.accountNavChildren}
      loading={loading || data.dashIsPlaceholder}
    >
      {/* Self-gates on the server's import specs (a capability): hidden until they arrive. */}
      <AccountImportSection accountId={summary.account_id} displayUnit={displayUnit} />

      {optionContract ? (
        <PageGridTile id="option-contract" className={loadableClass(loading)} aria-busy={loading || undefined}>
          <h2>{t("options.terms.title")}</h2>
          <Table
            header={
              <thead>
                <tr>
                  <th>{t("options.terms.occSymbol")}</th>
                  <th>{t("options.terms.underlying")}</th>
                  <th>{t("options.terms.right")}</th>
                  <th>{t("options.terms.strike")}</th>
                  <th>{t("options.terms.expiry")}</th>
                  <th>{t("options.terms.multiplier")}</th>
                </tr>
              </thead>
            }
          >
            <tr>
              <td className="mono">{optionContract.occ_symbol}</td>
              <td className="mono">{optionContract.underlying_ticker}</td>
              <td>{optionContract.right === "C" ? t("options.terms.call") : t("options.terms.put")}</td>
              <td className="mono">{formatOptionStrikeDollars(optionContract.strike)}</td>
              <td className="mono">{optionContract.expiry}</td>
              <td className="mono">{formatInstrumentUnits(optionContract.multiplier, "shares")}</td>
            </tr>
          </Table>
          <p className="muted">{t("options.terms.intrinsicNote")}</p>
        </PageGridTile>
      ) : null}

      {showPositionBlock ? (
        <PageGridTile id="position" className={loadableClass(loading)} aria-busy={loading || undefined}>
          <h2>{t("accountDetail.position.title")}</h2>
          <Table
            header={
              <thead>
                <tr>
                  <th>{t("accountDetail.position.colTicker")}</th>
                  <th>{t("accountDetail.position.colUnits")}</th>
                  <th>
                    {showEquityReturnColumns
                      ? t("accountDetail.equityPosition.depositedPocket")
                      : t("accountDetail.position.colDeposited")}
                  </th>
                  {showEquityReturnColumns ? (
                    <th>{t("accountDetail.equityPosition.dividends")}</th>
                  ) : null}
                  <th>{t("accountDetail.position.colValueToday")}</th>
                  <th>{t("accountDetail.position.colValueDate")}</th>
                  <th>{t("accountDetail.position.colValuePerUnit")}</th>
                  {showEquityReturnColumns ? (
                    <>
                      <th>{t("accountDetail.equityPosition.totalReturn")}</th>
                      <th>{t("accountDetail.equityPosition.returnOnDeposited")}</th>
                    </>
                  ) : null}
                </tr>
              </thead>
            }
          >
            <tr>
              <td className="mono">
                {summary.position?.ticker ?? summary.ticker ?? "—"}
              </td>
              <td className="mono">
                {summary.position?.units != null && Number.isFinite(summary.position.units)
                  ? formatInstrumentUnits(
                    summary.position.units,
                    summary.position.units_kind ?? summary.units_kind ?? "shares"
                  )
                  : "—"}
              </td>
              <td className="mono">{money(summary.position ? summary.position.deposited : summary.deposits)}</td>
              {showEquityReturnColumns ? (
                <td className="mono">{money(summary.position?.dividends ?? 0)}</td>
              ) : null}
              <td className="mono">{money(summary.position?.value ?? summary.latest_valuation)}</td>
              <td className="muted">
                {summary.position?.value_as_of ?? summary.latest_valuation_date ?? "—"}
              </td>
              <td className="mono">
                {money(summary.position?.value_per_unit)}
              </td>
              {showEquityReturnColumns ? (
                <>
                  <td className="mono">
                    {money(summary.position?.total_return)}
                  </td>
                  <td className="mono">
                    {summary.position?.return_on_deposited_pct != null
                      ? formatPct(summary.position.return_on_deposited_pct * 100)
                      : "—"}
                  </td>
                </>
              ) : null}
            </tr>
          </Table>
          {brokerHoldings.length >= 2 ? (
            <>
              <h3>{t("accountDetail.brokerHoldings.title")}</h3>
              <p className="muted">{t("accountDetail.brokerHoldings.hint")}</p>
              <Table
                header={
                  <thead>
                    <tr>
                      <th>{t("accountDetail.brokerHoldings.colAccount")}</th>
                      <th>{t("accountDetail.brokerHoldings.colUnits")}</th>
                      <th>{t("accountDetail.brokerHoldings.colShare")}</th>
                      <th>{t("accountDetail.brokerHoldings.colValue")}</th>
                    </tr>
                  </thead>
                }
              >
                {brokerHoldings.map((h) => (
                  <tr key={h.cash_account_id ?? "none"}>
                    <td>{h.cash_account_name ?? t("accountDetail.brokerHoldings.noCashAccount")}</td>
                    <td className="mono">
                      {formatInstrumentUnits(h.units, summary.position?.units_kind ?? "shares")}
                    </td>
                    <td className="mono">{formatPct(h.share * 100)}</td>
                    <td className="mono">{money(h.value)}</td>
                  </tr>
                ))}
              </Table>
            </>
          ) : null}
        </PageGridTile>
      ) : null}

      {isUsdCashAccount ? (
        <PageGridTile id="usd-cash" className={loadableClass(loading)} aria-busy={loading || undefined}>
          <h2>{t("accountDetail.usdCash.positionTitle")}</h2>
          <Table
            header={
              <thead>
                <tr>
                  <th>{t("accountDetail.usdCash.balanceUsd")}</th>
                  <th>{t("accountDetail.usdCash.valueInUnit", { currency: summary.unit.toUpperCase() })}</th>
                  <th>{t("accountDetail.usdCash.asOf")}</th>
                </tr>
              </thead>
            }
          >
            <tr>
              <td className="mono">
                {/* What the account holds, in its own currency whatever the display unit. */}
                {summary.latest_valuation_native ? formatMoney(summary.latest_valuation_native) : "—"}
              </td>
              <td className="mono">{money(summary.latest_valuation)}</td>
              <td className="muted">
                {summary.latest_valuation_date ?? "—"}
              </td>
            </tr>
          </Table>
        </PageGridTile>
      ) : null}

      <PageGridTile id="valuation" className="chart-grid chart-grid--full-line">
        <AccountValuationChart data={data} surfaces={surfaces} trimLeadingInactive={!isMovementCartolaAccount} />
      </PageGridTile>

      {isMovementCartolaAccount ? (
        <PageGridTile id="cartola-months">
          <h2>{t("accountDetail.monthlyDetailTitle")}</h2>
          {/* An edit form whose copy reads «no cartola» on empty anchors: hidden until they are known. */}
          {loading && checkingCartolaMonths == null ? null : (
            <CheckingLedgerAnchorForm
              accountId={summary.account_id}
              displayUnit={displayUnit}
              ledgerAnchor={checkingCartolaMonths?.ledger_anchor ?? null}
              cartolaDerivedAnchor={checkingCartolaMonths?.cartola_derived_anchor ?? null}
            />
          )}
          <CheckingCartolaMonthTable
            rows={checkingCartolaMonths?.rows ?? []}
            accountId={summary.account_id}
            importedMonthCount={checkingCartolaMonths?.imported_months.length ?? 0}
            collapsedVisibleRows={MONTHLY_PERF_COLLAPSED}
            loading={loading}
          />
        </PageGridTile>
      ) : null}

      {showMonthlyPerformance ? (
        <>
          <PageGridTile id="returns">
            <h2>{t("accountDetail.monthlyPerfComputedTitle")}</h2>
            {/* undefined = still loading (the table frames itself unless the card row's bucket rules it out); null = the server states none. */}
            {showPeriodReturns ? (
              <>
                <h3>{t("periodReturns.title")}</h3>
                <PeriodReturnsWithBenchmark
                  data={periodReturns ?? null}
                  displayUnit={displayUnit}
                  scope={{ accountId: summary.account_id }}
                  surfaceId={`account.${summary.account_id}.returns`}
                  loading={loading}
                />
              </>
            ) : null}
            {monthlyPerfRows.length === 0 && !loading ? (
              <p className="muted">{t("accountDetail.monthlyPerfNotEnough")}</p>
            ) : null}
          </PageGridTile>
          {monthlyPerfRows.length === 0 && !loading ? null : (
            <>
              <PageGridTile id="perf-combo" className="chart-grid chart-grid--full-line">
                <AccountPlYtdCombo data={data} surfaces={surfaces} />
              </PageGridTile>
              <PageGridTile id="perf-accum" className="chart-grid chart-grid--full-line">
                <AccountDeltaAccumCombo data={data} surfaces={surfaces} />
              </PageGridTile>
              <PageGridTile id="detail">
                <AccountDetalleSurface
                  data={data}
                  isCuotaLedgerAccount={isCuotaLedgerAccount}
                />
              </PageGridTile>
            </>
          )}
        </>
      ) : null}

      {/* The state bonus only exists on APV accounts: while loading they show the table's frame. */}
      {depositInflows.state_contribution_events.length > 0 ||
      (loading && summary.category_slug === "apv") ? (
        <PageGridTile id="state-contribution" className={loadableClass(loading)} aria-busy={loading || undefined}>
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
        <AccountBookLedgerSection
          accountId={summary.account_id}
          displayUnit={displayUnit}
        />
      ) : null}

      <AccountFlowsSection
        addMovementsForm={addMovementsForm}
        accountId={summary.account_id}
        unitsKind={summary.units_kind}
        unitsAsColumn={summary.position?.units != null}
      />
    </AccountDetailSharedLayout>
  );
}
