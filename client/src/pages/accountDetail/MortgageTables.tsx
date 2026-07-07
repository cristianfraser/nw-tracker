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
import { formatClp, formatClpUfDay, formatUfUnits, formatUfUnitsFine } from "../../format";
import { cn } from "../../cn";
import i18n, { Trans } from "../../i18n";
import styles from "../AccountDetailPage.module.css";

function cellClp(n: number | null | undefined) {
  if (n == null || !Number.isFinite(n)) return "—";
  return formatClp(n);
}

function cellTxt(s: string | null | undefined) {
  if (s == null || !String(s).trim()) return "—";
  return s;
}

function tasaPlusLabel(n: number | null | undefined) {
  if (n == null || !Number.isFinite(n)) return "—";
  return `${n}%`;
}

function cellUf(n: number | null | undefined) {
  return n != null ? formatUfUnits(n) : "—";
}

/** Combined CLP · UF cell for the mobile card's paired columns. */
function cellClpUf(clp: number | null, uf: number | null) {
  return `${cellClp(clp)} · ${formatUfUnitsFine(uf)}`;
}

function colLabel(key: string): string {
  return i18n.t(`accountDetail.mortgageSheet.cols.${key}`);
}

function MortgageDividendosMobileCard({ row }: { row: DeptoMortgageSheetRow }) {
  return (
    <TableMobileCard title={`${row.cuota} · ${row.occurred_on}`}>
      <TableMobileCardSection>
        <TableMobileCardRow label={colLabel("pagoClp")} value={cellClp(row.pago_clp)} />
        <TableMobileCardRow label={colLabel("pagoUf")} value={formatUfUnitsFine(row.pago_uf)} />
        <TableMobileCardRow label={colLabel("pctDiv")} value={cellTxt(row.pct_dividendo)} />
        <TableMobileCardRow
          label={colLabel("ufDia")}
          value={row.uf_clp_day != null ? formatClpUfDay(row.uf_clp_day) : "—"}
        />
        <TableMobileCardRow label={colLabel("mm")} value={cellTxt(row.mm_pct)} />
        <TableMobileCardRow label={colLabel("yy")} value={cellTxt(row.yy_pct)} />
        <TableMobileCardRow label={colLabel("tasaPlus")} value={tasaPlusLabel(row.tasa_plus)} />
      </TableMobileCardSection>
      <TableMobileCardSection>
        <TableMobileCardRow label={colLabel("creditoUf")} value={cellUf(row.credito_restante_uf)} />
        <TableMobileCardRow label={colLabel("pctCred")} value={cellTxt(row.pct_credito_uf)} />
        <TableMobileCardRow label={colLabel("restanteClp")} value={cellClp(row.restante_clp)} />
        <TableMobileCardRow label={colLabel("deltaCredito")} value={cellClp(row.delta_credito_clp)} />
        <TableMobileCardRow
          label={colLabel("deltaCredAmort")}
          value={cellClp(row.delta_credito_amort_clp)}
        />
      </TableMobileCardSection>
      <TableMobileCardSection>
        <TableMobileCardRow label={colLabel("valorNetoUf")} value={cellUf(row.valor_neto_uf)} />
        <TableMobileCardRow label={colLabel("valorNetoClp")} value={cellClp(row.valor_neto_clp)} />
        <TableMobileCardRow
          label={colLabel("pagadoNetoUf")}
          value={formatUfUnitsFine(row.pagado_neto_uf)}
        />
        <TableMobileCardRow label={colLabel("deltaVnClp")} value={cellClp(row.delta_valor_neto_clp)} />
        <TableMobileCardRow label={colLabel("viviendaUf")} value={cellUf(row.valor_vivienda_uf)} />
        <TableMobileCardRow label={colLabel("viviendaClp")} value={cellClp(row.valor_vivienda_clp)} />
        <TableMobileCardRow label={colLabel("minUf")} value={formatUfUnitsFine(row.min_uf)} />
      </TableMobileCardSection>
      <TableMobileCardSection>
        <TableMobileCardRow
          label={colLabel("incendio")}
          value={cellClpUf(row.incendio_clp, row.incendio_uf)}
        />
        <TableMobileCardRow
          label={colLabel("desgravamen")}
          value={cellClpUf(row.desgravamen_clp, row.desgravamen_uf)}
        />
        <TableMobileCardRow
          label={colLabel("totalSeguros")}
          value={cellClpUf(row.total_seguros_clp, row.total_seguros_uf)}
        />
      </TableMobileCardSection>
      <TableMobileCardSection>
        <TableMobileCardRow
          label={colLabel("amortizacion")}
          value={cellClpUf(row.amortizacion_clp, row.amortizacion_uf)}
        />
        <TableMobileCardRow
          label={colLabel("amortExt")}
          value={cellClpUf(row.amortizacion_ext_clp, row.amortizacion_ext_uf)}
        />
        <TableMobileCardRow
          label={colLabel("interes")}
          value={cellClpUf(row.interes_clp, row.interes_uf)}
        />
        <TableMobileCardRow label={colLabel("intOculto")} value={cellClp(row.interes_oculto_clp)} />
        <TableMobileCardRow label={colLabel("intOcultoB")} value={cellClp(row.interes_oculto_b_clp)} />
        <TableMobileCardRow label={colLabel("intReal")} value={cellClp(row.interes_real_clp)} />
        <TableMobileCardRow
          label={colLabel("intCalcUf")}
          value={formatUfUnitsFine(row.interes_calculado_uf)}
        />
        <TableMobileCardRow label={colLabel("amortInt")} value={cellTxt(row.amort_interes_text)} />
      </TableMobileCardSection>
      <TableMobileCardSection>
        <TableMobileCardRow label={colLabel("pagoAcum")} value={cellClp(row.pago_acumulado_clp)} />
        <TableMobileCardRow label={colLabel("amortAcum")} value={cellClp(row.amort_acum_clp)} />
        <TableMobileCardRow label={colLabel("intAcum")} value={cellClp(row.interes_acum_clp)} />
      </TableMobileCardSection>
    </TableMobileCard>
  );
}

function MortgageDividendosDesktopRow({ row }: { row: DeptoMortgageSheetRow }) {
  return (
    <>
      <td className={cn("mono", "desktop-only", styles.nowrap)}>{row.cuota}</td>
      <td className="desktop-only">{row.occurred_on}</td>
      <td className="mono desktop-only">{cellClp(row.pago_clp)}</td>
      <td className="mono desktop-only">{formatUfUnitsFine(row.pago_uf)}</td>
      <td className="mono muted desktop-only">{cellTxt(row.pct_dividendo)}</td>
      <td className="mono desktop-only">
        {row.uf_clp_day != null ? formatClpUfDay(row.uf_clp_day) : "—"}
      </td>
      <td className="mono muted desktop-only">{cellTxt(row.mm_pct)}</td>
      <td className="mono muted desktop-only">{cellTxt(row.yy_pct)}</td>
      <td className="mono muted desktop-only">{tasaPlusLabel(row.tasa_plus)}</td>
      <td className="mono desktop-only">{cellUf(row.credito_restante_uf)}</td>
      <td className="mono muted desktop-only">{cellTxt(row.pct_credito_uf)}</td>
      <td className="mono desktop-only">{cellClp(row.restante_clp)}</td>
      <td className="mono desktop-only">{cellClp(row.delta_credito_clp)}</td>
      <td className="mono desktop-only">{cellUf(row.valor_neto_uf)}</td>
      <td className="mono desktop-only">{cellClp(row.valor_neto_clp)}</td>
      <td className="mono desktop-only">{formatUfUnitsFine(row.pagado_neto_uf)}</td>
      <td className="mono desktop-only">{cellClp(row.delta_valor_neto_clp)}</td>
      <td className="mono desktop-only">{cellUf(row.valor_vivienda_uf)}</td>
      <td className="mono desktop-only">{cellClp(row.valor_vivienda_clp)}</td>
      <td className="mono desktop-only">{formatUfUnitsFine(row.min_uf)}</td>
      <td className="mono desktop-only">{cellClp(row.incendio_clp)}</td>
      <td className="mono desktop-only">{formatUfUnitsFine(row.incendio_uf)}</td>
      <td className="mono desktop-only">{cellClp(row.desgravamen_clp)}</td>
      <td className="mono desktop-only">{formatUfUnitsFine(row.desgravamen_uf)}</td>
      <td className="mono desktop-only">{cellClp(row.total_seguros_clp)}</td>
      <td className="mono desktop-only">{formatUfUnitsFine(row.total_seguros_uf)}</td>
      <td className="mono desktop-only">{cellClp(row.amortizacion_clp)}</td>
      <td className="mono desktop-only">{formatUfUnitsFine(row.amortizacion_uf)}</td>
      <td className="mono desktop-only">{cellClp(row.amortizacion_ext_clp)}</td>
      <td className="mono desktop-only">{formatUfUnitsFine(row.amortizacion_ext_uf)}</td>
      <td className="mono desktop-only">{cellClp(row.interes_clp)}</td>
      <td className="mono desktop-only">{formatUfUnitsFine(row.interes_uf)}</td>
      <td className="mono desktop-only">{cellClp(row.delta_credito_amort_clp)}</td>
      <td className="mono desktop-only">{cellClp(row.interes_oculto_clp)}</td>
      <td className="mono desktop-only">{cellClp(row.interes_oculto_b_clp)}</td>
      <td className="mono desktop-only">{cellClp(row.interes_real_clp)}</td>
      <td className="mono desktop-only">{formatUfUnitsFine(row.interes_calculado_uf)}</td>
      <td className="mono muted desktop-only">{cellTxt(row.amort_interes_text)}</td>
      <td className="mono muted desktop-only">{cellClp(row.pago_acumulado_clp)}</td>
      <td className="mono muted desktop-only">{cellClp(row.amort_acum_clp)}</td>
      <td className="mono muted desktop-only">{cellClp(row.interes_acum_clp)}</td>
    </>
  );
}

/**
 * Desktop header layout: simple columns span both header rows; the CLP/UF pairs
 * (Incendio … Interés) take colSpan 2 with a CLP/UF sub-row. Desktop cell order in
 * `MortgageDividendosDesktopRow` follows SIMPLE_BEFORE + pairs + SIMPLE_AFTER, except the
 * paired group renders between `minUf` and `deltaCredAmort` (matching the sheet).
 */
const HEADER_SIMPLE_BEFORE_PAIRS = [
  "cuota",
  "fecha",
  "pagoClp",
  "pagoUf",
  "pctDiv",
  "ufDia",
  "mm",
  "yy",
  "tasaPlus",
  "creditoUf",
  "pctCred",
  "restanteClp",
  "deltaCredito",
  "valorNetoUf",
  "valorNetoClp",
  "pagadoNetoUf",
  "deltaVnClp",
  "viviendaUf",
  "viviendaClp",
  "minUf",
] as const;

const HEADER_PAIRED_COLS = [
  "incendio",
  "desgravamen",
  "totalSeguros",
  "amortizacion",
  "amortExt",
  "interes",
] as const;

const HEADER_SIMPLE_AFTER_PAIRS = [
  "deltaCredAmort",
  "intOculto",
  "intOcultoB",
  "intReal",
  "intCalcUf",
  "amortInt",
  "pagoAcum",
  "amortAcum",
  "intAcum",
] as const;

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
          <Trans
            i18nKey="accountDetail.mortgageSheet.tasaNote"
            components={{ 1: <strong />, 3: <strong /> }}
          />
        )}
      </p>
      {m && !isMortgageView && (
        <div className={cn("cards", styles.cardsBelow)}>
          <div className="card">
            <div className="label">{i18n.t("accountDetail.mortgageSheet.cards.viviendaHoja")}</div>
            <div className="value mono">{cellUf(m.valor_vivienda_uf)}</div>
          </div>
          <div className="card">
            <div className="label">{i18n.t("accountDetail.mortgageSheet.cards.hipotecaTrasPie")}</div>
            <div className="value mono">{cellUf(m.hipoteca_tras_pie_uf)}</div>
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
              {HEADER_SIMPLE_BEFORE_PAIRS.map((key) => (
                <th key={key} rowSpan={2} className="desktop-only">
                  {colLabel(key)}
                </th>
              ))}
              {HEADER_PAIRED_COLS.map((key) => (
                <th key={key} colSpan={2} className="desktop-only">
                  {colLabel(key)}
                </th>
              ))}
              {HEADER_SIMPLE_AFTER_PAIRS.map((key) => (
                <th key={key} rowSpan={2} className="desktop-only">
                  {colLabel(key)}
                </th>
              ))}
            </tr>
            <tr>
              {HEADER_PAIRED_COLS.map((key) => (
                <PairedClpUfSubHeaders key={key} />
              ))}
            </tr>
            <tr>
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

function PairedClpUfSubHeaders() {
  return (
    <>
      <th className="desktop-only">{colLabel("clp")}</th>
      <th className="desktop-only">{colLabel("uf")}</th>
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
