import { useMemo } from "react";
import { PaginatedTable, useClientPagination } from "../../components/ui/PaginatedTable";
import { Table } from "../../components/ui/Table";
import {
  TableMobileCard,
  TableMobileCardRow,
  TableMobileCardSection,
} from "../../components/ui/TableMobileCard";
import type {
  AccountMortgageLedgerResponse,
  DeptoMortgageSheetRow,
  DeptoPaymentScenarioRow,
  DeptoPaymentScenarioTerm,
} from "../../types";
import { formatClp, formatUfUnits, formatUfUnitsFine } from "../../format";
import { cn } from "../../cn";
import i18n, { Trans } from "../../i18n";
import styles from "../AccountDetailPage.module.css";

/** UF amount with the CLP amount as a muted sub-line (shared desktop/mobile pair cell). */
function cellUfClpPair(uf: number | null, clp: number | null) {
  if (uf == null && clp == null) return "—";
  return (
    <>
      {uf != null ? formatUfUnitsFine(uf) : "—"}
      {clp != null ? (
        <span className={cn("muted", styles.cellSub)}>{formatClp(clp)}</span>
      ) : null}
    </>
  );
}

/** Min payment CLP is not stored on the sheet row; convert at the row's UF rate. */
function minUfClp(row: DeptoMortgageSheetRow): number | null {
  if (row.min_uf == null || row.uf_clp_day == null) return null;
  return row.min_uf * row.uf_clp_day;
}

/** Remaining credit: UF (coarse units) with the CLP amount as a muted sub-line. */
function cellCreditoPair(row: DeptoMortgageSheetRow) {
  if (row.credito_restante_uf == null && row.restante_clp == null) return "—";
  return (
    <>
      {row.credito_restante_uf != null ? formatUfUnits(row.credito_restante_uf) : "—"}
      {row.restante_clp != null ? (
        <span className={cn("muted", styles.cellSub)}>{formatClp(row.restante_clp)}</span>
      ) : null}
    </>
  );
}

function colLabel(key: string): string {
  return i18n.t(`accountDetail.mortgageSheet.cols.${key}`);
}

function MortgageDividendosMobileCard({ row }: { row: DeptoMortgageSheetRow }) {
  return (
    <TableMobileCard title={`${row.cuota} · ${row.occurred_on}`}>
      <TableMobileCardSection>
        <TableMobileCardRow label={colLabel("pago")} value={cellUfClpPair(row.pago_uf, row.pago_clp)} />
      </TableMobileCardSection>
      <TableMobileCardSection>
        <TableMobileCardRow label={colLabel("credito")} value={cellCreditoPair(row)} />
        <TableMobileCardRow label={colLabel("minUf")} value={cellUfClpPair(row.min_uf, minUfClp(row))} />
      </TableMobileCardSection>
      <TableMobileCardSection>
        <TableMobileCardRow
          label={colLabel("incendio")}
          value={cellUfClpPair(row.incendio_uf, row.incendio_clp)}
        />
        <TableMobileCardRow
          label={colLabel("desgravamen")}
          value={cellUfClpPair(row.desgravamen_uf, row.desgravamen_clp)}
        />
      </TableMobileCardSection>
      <TableMobileCardSection>
        <TableMobileCardRow
          label={colLabel("amortizacion")}
          value={cellUfClpPair(row.amortizacion_uf, row.amortizacion_clp)}
        />
        <TableMobileCardRow
          label={colLabel("amortExt")}
          value={cellUfClpPair(row.amortizacion_ext_uf, row.amortizacion_ext_clp)}
        />
        <TableMobileCardRow
          label={colLabel("interes")}
          value={cellUfClpPair(row.interes_uf, row.interes_clp)}
        />
      </TableMobileCardSection>
    </TableMobileCard>
  );
}

function MortgageDividendosDesktopRow({ row }: { row: DeptoMortgageSheetRow }) {
  return (
    <>
      <td className={cn("mono", "desktop-only", styles.nowrap)}>
        {row.cuota}
        <span className={cn("muted", styles.cellSub)}>{row.occurred_on}</span>
      </td>
      <td className="mono desktop-only">{cellUfClpPair(row.pago_uf, row.pago_clp)}</td>
      <td className="mono desktop-only">{cellCreditoPair(row)}</td>
      <td className="mono desktop-only">{cellUfClpPair(row.min_uf, minUfClp(row))}</td>
      <td className="mono desktop-only">{cellUfClpPair(row.incendio_uf, row.incendio_clp)}</td>
      <td className="mono desktop-only">{cellUfClpPair(row.desgravamen_uf, row.desgravamen_clp)}</td>
      <td className="mono desktop-only">{cellUfClpPair(row.amortizacion_uf, row.amortizacion_clp)}</td>
      <td className="mono desktop-only">
        {cellUfClpPair(row.amortizacion_ext_uf, row.amortizacion_ext_clp)}
      </td>
      <td className="mono desktop-only">{cellUfClpPair(row.interes_uf, row.interes_clp)}</td>
    </>
  );
}

export function MortgageDividendosTable({
  ledger,
  variant = "property",
}: {
  ledger: AccountMortgageLedgerResponse;
  /** `property` = inmueble (incl. pie); `mortgage` = pasivo (solo cuotas / prepagos). */
  variant?: "property" | "mortgage";
}) {
  const m = ledger.meta;
  const isMortgageView = variant === "mortgage";

  const rowsSorted = useMemo(
    () => [...ledger.rows].sort((a, b) => String(b.occurred_on).localeCompare(String(a.occurred_on))),
    [ledger.rows]
  );

  // Display newest payments first. `occurred_on` is ISO-like (`YYYY-MM-DD`), so lexicographic
  // order matches chronological order.
  const { page, setPage, pageRows, total } = useClientPagination(rowsSorted, 12);

  return (
    <>
      <h2 className={styles.sectionTitle}>
        {isMortgageView
          ? i18n.t("accountDetail.mortgageSheet.titleMortgage")
          : i18n.t("accountDetail.mortgageSheet.titleProperty")}
      </h2>
      <p className={cn("muted", styles.proseMuted)}>
        <Trans
          i18nKey="accountDetail.mortgageSheet.intro"
          components={{ 1: <span className="mono" /> }}
        />
        {isMortgageView ? (
          <Trans i18nKey="accountDetail.mortgageSheet.pieNote" components={{ 1: <strong /> }} />
        ) : (
          <Trans i18nKey="accountDetail.mortgageSheet.tasaNote" components={{ 1: <strong /> }} />
        )}
      </p>
      {m && !isMortgageView && (
        <div className={cn("cards", styles.cardsBelow)}>
          <div className="card">
            <div className="label">{i18n.t("accountDetail.mortgageSheet.cards.viviendaHoja")}</div>
            <div className="value mono">
              {m.valor_vivienda_uf != null ? formatUfUnits(m.valor_vivienda_uf) : "—"}
            </div>
          </div>
          <div className="card">
            <div className="label">{i18n.t("accountDetail.mortgageSheet.cards.hipotecaTrasPie")}</div>
            <div className="value mono">
              {m.hipoteca_tras_pie_uf != null ? formatUfUnits(m.hipoteca_tras_pie_uf) : "—"}
            </div>
          </div>
          <div className="card">
            <div className="label">{i18n.t("accountDetail.mortgageSheet.cards.pieClpUf")}</div>
            <div className={cn("value", "mono", styles.cardValueSecondary)}>
              {m.pie_clp != null ? formatClp(m.pie_clp) : "—"} · {formatUfUnitsFine(m.pie_uf)}
            </div>
          </div>
          <div className="card">
            <div className="label">{i18n.t("accountDetail.mortgageSheet.cards.filasDePago")}</div>
            <div className="value mono">{m.row_count}</div>
          </div>
        </div>
      )}
      <PaginatedTable page={page} pageSize={12} total={total} onPageChange={setPage}>
        <Table
          tableClassName={cn("mortgage-sheet", "table--parallel-mobile", styles.tableMortgage)}
          header={
          <thead>
            <tr>
              <th className="desktop-only">{colLabel("cuota")}</th>
              <th className="desktop-only">{colLabel("pago")}</th>
              <th className="desktop-only">{colLabel("credito")}</th>
              <th className="desktop-only">{colLabel("minUf")}</th>
              <th className="desktop-only">{colLabel("incendio")}</th>
              <th className="desktop-only">{colLabel("desgravamen")}</th>
              <th className="desktop-only">{colLabel("amortizacion")}</th>
              <th className="desktop-only">{colLabel("amortExt")}</th>
              <th className="desktop-only">{colLabel("interes")}</th>
              <th className="mobile-only" aria-hidden="true" />
            </tr>
          </thead>
        }
        >
          {pageRows.map((row, idx) => (
            <tr key={`${row.cuota}-${row.occurred_on}-${idx}`}>
              <MortgageDividendosDesktopRow row={row} />
              <td className="mobile-only">
                <MortgageDividendosMobileCard row={row} />
              </td>
            </tr>
          ))}
        </Table>
      </PaginatedTable>
    </>
  );
}

const SCENARIO_TERMS: DeptoPaymentScenarioTerm[] = [30, 25, 20, 15, 12, 10, 5, "max"];

function scenarioTermLabel(term: DeptoPaymentScenarioTerm): string {
  if (term === 30) return i18n.t("accountDetail.mortgageSheet.terms.years30Min");
  if (term === "max") return i18n.t("accountDetail.mortgageSheet.terms.max");
  return i18n.t("accountDetail.mortgageSheet.terms.years", { n: term });
}

function scenarioPaymentForTerm(
  row: DeptoPaymentScenarioRow,
  term: DeptoPaymentScenarioTerm,
  byTerm: Map<DeptoPaymentScenarioTerm, { payment_uf: number | null; payment_clp: number | null }>
): { uf: number | null; clp: number | null } {
  if (term === 30) {
    return { uf: row.min_payment_uf, clp: row.min_payment_clp };
  }
  const cell = byTerm.get(term);
  return { uf: cell?.payment_uf ?? null, clp: cell?.payment_clp ?? null };
}

function formatScenarioPayment(uf: number | null, clp: number | null) {
  if (uf == null && clp == null) return "—";
  return (
    <>
      {uf != null ? formatUfUnitsFine(uf) : "—"}
      {clp != null ? (
        <span className={cn("muted", styles.cellSub)}>{formatClp(clp)}</span>
      ) : null}
    </>
  );
}

function DeptoPaymentScenarioMobileCard({ row }: { row: DeptoPaymentScenarioRow }) {
  const byTerm = new Map(row.scenarios.map((s) => [s.term, s]));
  const title = (
    <>
      {row.cuota}
      {row.is_next_payment ? (
        <span className={cn("muted", styles.cellSub)}> {i18n.t("accountDetail.mortgageSheet.proxAbbrev")}</span>
      ) : null}
      {" · "}
      {row.occurred_on}
    </>
  );

  return (
    <TableMobileCard title={title}>
      <TableMobileCardSection>
        {SCENARIO_TERMS.map((term) => {
          const cell = scenarioPaymentForTerm(row, term, byTerm);
          return (
            <TableMobileCardRow
              key={String(term)}
              label={scenarioTermLabel(term)}
              value={formatScenarioPayment(cell.uf, cell.clp)}
            />
          );
        })}
      </TableMobileCardSection>
    </TableMobileCard>
  );
}

export function DeptoPaymentScenarioTable({ rows }: { rows: DeptoPaymentScenarioRow[] }) {
  const rowsDisplay = useMemo(() => [...rows].reverse(), [rows]);

  const { page: scenarioPage, setPage: setScenarioPage, pageRows: scenarioPageRows, total: scenarioTotal } =
    useClientPagination(rowsDisplay, 12);

  if (!rows.length) return null;

  return (
    <>
      <h3 className={styles.subsectionTitleMid}>{i18n.t("accountDetail.mortgageSheet.referenceMinMax")}</h3>
      <p className={cn("muted", styles.proseMutedXs)}>
        {i18n.t("accountDetail.mortgageSheet.scenarioIntro")}
      </p>
      <PaginatedTable page={scenarioPage} pageSize={12} total={scenarioTotal} onPageChange={setScenarioPage}>
        <Table
          tableClassName={cn("table--parallel-mobile", styles.tableScenario)}
          header={
            <thead>
              <tr>
                <th className="desktop-only">{colLabel("cuota")}</th>
                <th className="desktop-only">{colLabel("fecha")}</th>
                {SCENARIO_TERMS.map((term) => (
                  <th key={String(term)} className={cn("desktop-only", styles.nowrap)}>
                    {scenarioTermLabel(term)}
                  </th>
                ))}
                <th className="mobile-only" aria-hidden="true" />
              </tr>
            </thead>
          }
        >
          {scenarioPageRows.map((row) => {
            const byTerm = new Map(row.scenarios.map((s) => [s.term, s]));
            return (
              <tr key={`${row.cuota}-${row.occurred_on}`}>
                <td className="mono desktop-only">
                  {row.cuota}
                  {row.is_next_payment ? (
                    <span className={cn("muted", styles.cellSub)}>
                      {i18n.t("accountDetail.mortgageSheet.proxAbbrev")}
                    </span>
                  ) : null}
                </td>
                <td className="mono desktop-only">{row.occurred_on}</td>
                {SCENARIO_TERMS.map((term) => {
                  const cell = scenarioPaymentForTerm(row, term, byTerm);
                  return (
                    <td key={String(term)} className={cn("mono", "desktop-only", styles.nowrap)}>
                      {cell.uf != null ? formatUfUnitsFine(cell.uf) : "—"}
                      {cell.clp != null ? (
                        <span className={cn("muted", styles.cellSub)}>{formatClp(cell.clp)}</span>
                      ) : null}
                    </td>
                  );
                })}
                <td className="mobile-only">
                  <DeptoPaymentScenarioMobileCard row={row} />
                </td>
              </tr>
            );
          })}
        </Table>
      </PaginatedTable>
    </>
  );
}
