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

function MortgageDividendosMobileCard({ row }: { row: DeptoMortgageSheetRow }) {
  return (
    <TableMobileCard title={`${row.cuota} · ${row.occurred_on}`}>
      <TableMobileCardSection>
        <TableMobileCardRow label="Pago" value={cellUfClpPair(row.pago_uf, row.pago_clp)} />
      </TableMobileCardSection>
      <TableMobileCardSection>
        <TableMobileCardRow label="Crédito" value={cellCreditoPair(row)} />
        <TableMobileCardRow label="Min UF" value={cellUfClpPair(row.min_uf, minUfClp(row))} />
      </TableMobileCardSection>
      <TableMobileCardSection>
        <TableMobileCardRow
          label="Incendio"
          value={cellUfClpPair(row.incendio_uf, row.incendio_clp)}
        />
        <TableMobileCardRow
          label="Desgravamen"
          value={cellUfClpPair(row.desgravamen_uf, row.desgravamen_clp)}
        />
      </TableMobileCardSection>
      <TableMobileCardSection>
        <TableMobileCardRow
          label="Amortización"
          value={cellUfClpPair(row.amortizacion_uf, row.amortizacion_clp)}
        />
        <TableMobileCardRow
          label="Amort. ext"
          value={cellUfClpPair(row.amortizacion_ext_uf, row.amortizacion_ext_clp)}
        />
        <TableMobileCardRow
          label="Interés"
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
            <div className="label">Vivienda (hoja)</div>
            <div className="value mono">
              {m.valor_vivienda_uf != null ? formatUfUnits(m.valor_vivienda_uf) : "—"}
            </div>
          </div>
          <div className="card">
            <div className="label">Hipoteca tras pie</div>
            <div className="value mono">
              {m.hipoteca_tras_pie_uf != null ? formatUfUnits(m.hipoteca_tras_pie_uf) : "—"}
            </div>
          </div>
          <div className="card">
            <div className="label">Pie (CLP / UF)</div>
            <div className={cn("value", "mono", styles.cardValueSecondary)}>
              {m.pie_clp != null ? formatClp(m.pie_clp) : "—"} · {formatUfUnitsFine(m.pie_uf)}
            </div>
          </div>
          <div className="card">
            <div className="label">Filas de pago</div>
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
              <th className="desktop-only">Cuota</th>
              <th className="desktop-only">Pago</th>
              <th className="desktop-only">Crédito</th>
              <th className="desktop-only">Min UF</th>
              <th className="desktop-only">Incendio</th>
              <th className="desktop-only">Desgravamen</th>
              <th className="desktop-only">Amortización</th>
              <th className="desktop-only">Amort. ext</th>
              <th className="desktop-only">Interés</th>
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

const SCENARIO_TERM_LABELS: Record<DeptoPaymentScenarioTerm, string> = {
  30: "30 años (mín.)",
  25: "25 años",
  20: "20 años",
  15: "15 años",
  12: "12 años",
  10: "10 años",
  5: "5 años",
  max: "Máx. (~80 UF)",
};

const SCENARIO_TERMS: DeptoPaymentScenarioTerm[] = [30, 25, 20, 15, 12, 10, 5, "max"];

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
              label={SCENARIO_TERM_LABELS[term]}
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
        Escenarios de la hoja depto (no son movimientos), en fechas del calendario hipotecario (día 11 de cada mes).
        La primera fila es la próxima cuota proyectada. El pago mínimo (30 años) es editable en Numbers; el máximo
        (~80 UF) aproxima amortizar en 5 años al inicio del crédito.
      </p>
      <PaginatedTable page={scenarioPage} pageSize={12} total={scenarioTotal} onPageChange={setScenarioPage}>
        <Table
          tableClassName={cn("table--parallel-mobile", styles.tableScenario)}
          header={
            <thead>
              <tr>
                <th className="desktop-only">Cuota</th>
                <th className="desktop-only">Fecha</th>
                {SCENARIO_TERMS.map((term) => (
                  <th key={String(term)} className={cn("desktop-only", styles.nowrap)}>
                    {SCENARIO_TERM_LABELS[term]}
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
