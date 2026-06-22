import { useMemo } from "react";
import { useTranslation } from "../../i18n";
import { PaginatedTable } from "../../components/ui/PaginatedTable";
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

function rowsByOccurredOnYear<T extends { occurred_on: string }>(rows: readonly T[]) {
  const byYear = new Map<string, T[]>();
  for (const row of rows) {
    const year = row.occurred_on.slice(0, 4);
    const bucket = byYear.get(year) ?? [];
    bucket.push(row);
    byYear.set(year, bucket);
  }
  const yearsAsc = [...byYear.keys()].sort((a, b) => Number(a) - Number(b));
  return yearsAsc.map((year, pageNumber) => ({
    pageNumber,
    data: byYear.get(year) ?? [],
  }));
}

function MortgageDividendosMobileCard({ row }: { row: DeptoMortgageSheetRow }) {
  return (
    <TableMobileCard title={`${row.cuota} · ${row.occurred_on}`}>
      <TableMobileCardSection>
        <TableMobileCardRow label="Pago CLP" value={cellClp(row.pago_clp)} />
        <TableMobileCardRow label="Pago UF" value={formatUfUnitsFine(row.pago_uf)} />
      </TableMobileCardSection>
      <TableMobileCardSection>
        <TableMobileCardRow label="% div." value={cellTxt(row.pct_dividendo)} />
        <TableMobileCardRow
          label="UF día"
          value={row.uf_clp_day != null ? formatClpUfDay(row.uf_clp_day) : "—"}
        />
        <TableMobileCardRow label="m/m" value={cellTxt(row.mm_pct)} />
        <TableMobileCardRow label="y/y" value={cellTxt(row.yy_pct)} />
      </TableMobileCardSection>
      <TableMobileCardSection>
        <TableMobileCardRow label="+ tasa" value={tasaPlusLabel(row.tasa_plus)} />
        <TableMobileCardRow
          label="Crédito UF"
          value={row.credito_restante_uf != null ? formatUfUnits(row.credito_restante_uf) : "—"}
        />
        <TableMobileCardRow label="Restante CLP" value={cellClp(row.restante_clp)} />
        <TableMobileCardRow label="Valor neto CLP" value={cellClp(row.valor_neto_clp)} />
        <TableMobileCardRow
          label="Amortización CLP"
          value={cellClp(row.amortizacion_clp)}
        />
        <TableMobileCardRow label="Interés CLP" value={cellClp(row.interes_clp)} />
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
      <td className="mono desktop-only">
        {row.credito_restante_uf != null ? formatUfUnits(row.credito_restante_uf) : "—"}
      </td>
      <td className="mono muted desktop-only">{cellTxt(row.pct_credito_uf)}</td>
      <td className="mono desktop-only">{cellClp(row.restante_clp)}</td>
      <td className="mono desktop-only">{cellClp(row.delta_credito_clp)}</td>
      <td className="mono desktop-only">
        {row.valor_neto_uf != null ? formatUfUnits(row.valor_neto_uf) : "—"}
      </td>
      <td className="mono desktop-only">{cellClp(row.valor_neto_clp)}</td>
      <td className="mono desktop-only">{formatUfUnitsFine(row.pagado_neto_uf)}</td>
      <td className="mono desktop-only">{cellClp(row.delta_valor_neto_clp)}</td>
      <td className="mono desktop-only">
        {row.valor_vivienda_uf != null ? formatUfUnits(row.valor_vivienda_uf) : "—"}
      </td>
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

export function MortgageDividendosTable({
  ledger,
  variant = "property",
}: {
  ledger: AccountMortgageLedgerResponse;
  /** `property` = inmueble (incl. pie); `mortgage` = pasivo (solo cuotas / prepagos). */
  variant?: "property" | "mortgage";
}) {
  const { t } = useTranslation();
  const m = ledger.meta;
  const isMortgageView = variant === "mortgage";
  // Display newest payments first. `occurred_on` is ISO-like (`YYYY-MM-DD`), so lexicographic
  // order matches chronological order.
  const rowsSorted = useMemo(
    () => [...ledger.rows].sort((a, b) => String(b.occurred_on).localeCompare(String(a.occurred_on))),
    [ledger.rows]
  );
  const pages = useMemo(() => rowsByOccurredOnYear(rowsSorted), [rowsSorted]);

  return (
    <>
      <h2 className={styles.sectionTitle}>
        {isMortgageView ? "Dividendos hipoteca (hoja depto)" : "Hipoteca / dividendos (hoja depto)"}
      </h2>
      <p className={cn("muted", styles.proseMuted)}>
        Tabla leída desde el libro hipoteca en SQLite (<span className="mono">depto_dividendos_sheet_rows</span>): cada
        fila con monto CLP es un pago (puede haber varios en un mes).
        {isMortgageView ? (
          <> El <strong>pie</strong> está en la cuenta inmueble (suecia), no en el pasivo hipotecario.</>
        ) : (
          <>
            {" "}
            La tasa anual del crédito en el modelo es <strong>4,95%</strong>; la columna <strong>+ tasa</strong> del CSV
            incluye inflación y el spread de la hoja.
          </>
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
      <PaginatedTable
        pages={pages}
        collapsedVisibleRows={12}
        showMoreLabel={(hiddenCount) => t("table.showMoreMonths", { count: hiddenCount })}
        showLessLabel={t("table.showLessMonths")}
        tableClassName={cn("mortgage-sheet", "table--parallel-mobile", styles.tableMortgage)}
        getPageLabel={(page) => page.data[0]?.occurred_on.slice(0, 4) ?? "—"}
        header={
          <thead>
            <tr>
              <th rowSpan={2} className="desktop-only">
                Cuota
              </th>
              <th rowSpan={2} className="desktop-only">
                Fecha
              </th>
              <th rowSpan={2} className="desktop-only">
                Pago CLP
              </th>
              <th rowSpan={2} className="desktop-only">
                Pago UF
              </th>
              <th rowSpan={2} className="desktop-only">
                % div.
              </th>
              <th rowSpan={2} className="desktop-only">
                UF día
              </th>
              <th rowSpan={2} className="desktop-only">
                m/m
              </th>
              <th rowSpan={2} className="desktop-only">
                y/y
              </th>
              <th rowSpan={2} className="desktop-only">
                + tasa
              </th>
              <th rowSpan={2} className="desktop-only">
                Crédito UF
              </th>
              <th rowSpan={2} className="desktop-only">
                % créd.
              </th>
              <th rowSpan={2} className="desktop-only">
                Restante CLP
              </th>
              <th rowSpan={2} className="desktop-only">
                Δ crédito
              </th>
              <th rowSpan={2} className="desktop-only">
                Valor neto UF
              </th>
              <th rowSpan={2} className="desktop-only">
                Valor neto CLP
              </th>
              <th rowSpan={2} className="desktop-only">
                Pagado neto UF
              </th>
              <th rowSpan={2} className="desktop-only">
                Δ VN CLP
              </th>
              <th rowSpan={2} className="desktop-only">
                Vivienda UF
              </th>
              <th rowSpan={2} className="desktop-only">
                Vivienda CLP
              </th>
              <th rowSpan={2} className="desktop-only">
                Min UF
              </th>
              <th colSpan={2} className="desktop-only">
                Incendio
              </th>
              <th colSpan={2} className="desktop-only">
                Desgravamen
              </th>
              <th colSpan={2} className="desktop-only">
                Total seguros
              </th>
              <th colSpan={2} className="desktop-only">
                Amortización
              </th>
              <th colSpan={2} className="desktop-only">
                Amort. ext
              </th>
              <th colSpan={2} className="desktop-only">
                Interés
              </th>
              <th rowSpan={2} className="desktop-only">
                Δ créd. (amort)
              </th>
              <th rowSpan={2} className="desktop-only">
                Int. oculto
              </th>
              <th rowSpan={2} className="desktop-only">
                Int. oculto B
              </th>
              <th rowSpan={2} className="desktop-only">
                Int. real
              </th>
              <th rowSpan={2} className="desktop-only">
                Int. calc UF
              </th>
              <th rowSpan={2} className="desktop-only">
                amort/int
              </th>
              <th rowSpan={2} className="desktop-only">
                Pago acum.
              </th>
              <th rowSpan={2} className="desktop-only">
                Amort acum
              </th>
              <th rowSpan={2} className="desktop-only">
                Int acum
              </th>
            </tr>
            <tr>
              <th className="desktop-only">CLP</th>
              <th className="desktop-only">UF</th>
              <th className="desktop-only">CLP</th>
              <th className="desktop-only">UF</th>
              <th className="desktop-only">CLP</th>
              <th className="desktop-only">UF</th>
              <th className="desktop-only">CLP</th>
              <th className="desktop-only">UF</th>
              <th className="desktop-only">CLP</th>
              <th className="desktop-only">UF</th>
              <th className="desktop-only">CLP</th>
              <th className="desktop-only">UF</th>
            </tr>
            <tr>
              <th className="mobile-only" aria-hidden="true" />
            </tr>
          </thead>
        }
        renderBody={(pageRows) =>
          pageRows.map((row, idx) => (
            <tr key={`${row.cuota}-${row.occurred_on}-${idx}`}>
              <MortgageDividendosDesktopRow row={row} />
              <td className="mobile-only">
                <MortgageDividendosMobileCard row={row} />
              </td>
            </tr>
          ))
        }
      />
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
      {row.is_next_payment ? <span className={cn("muted", styles.cellSub)}> próx.</span> : null}
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
  const { t } = useTranslation();
  const rowsDisplay = useMemo(() => [...rows].reverse(), [rows]);
  const pages = useMemo(() => rowsByOccurredOnYear(rowsDisplay), [rowsDisplay]);

  if (!rows.length) return null;

  return (
    <>
      <h3 className={styles.subsectionTitleMid}>Referencia: cuota mín / máx (UF)</h3>
      <p className={cn("muted", styles.proseMutedXs)}>
        Escenarios de la hoja depto (no son movimientos), en fechas del calendario hipotecario (día 11 de cada mes).
        La primera fila es la próxima cuota proyectada. El pago mínimo (30 años) es editable en Numbers; el máximo
        (~80 UF) aproxima amortizar en 5 años al inicio del crédito.
      </p>
      <PaginatedTable
        pages={pages}
        collapsedVisibleRows={12}
        showMoreLabel={(hiddenCount) => t("table.showMoreMonths", { count: hiddenCount })}
        showLessLabel={t("table.showLessMonths")}
        tableClassName={cn("table--parallel-mobile", styles.tableScenario)}
        getPageLabel={(page) => page.data[0]?.occurred_on.slice(0, 4) ?? "—"}
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
        renderBody={(pageRows) =>
          pageRows.map((row) => {
            const byTerm = new Map(row.scenarios.map((s) => [s.term, s]));
            return (
              <tr key={`${row.cuota}-${row.occurred_on}`}>
                <td className="mono desktop-only">
                  {row.cuota}
                  {row.is_next_payment ? (
                    <span className={cn("muted", styles.cellSub)}>próx.</span>
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
          })
        }
      />
    </>
  );
}
