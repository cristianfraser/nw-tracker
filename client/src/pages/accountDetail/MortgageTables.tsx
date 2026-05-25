import { Table } from "../../components/ui/Table";
import type { AccountMortgageLedgerResponse, DeptoPaymentScenarioRow, DeptoPaymentScenarioTerm } from "../../types";
import { formatClp, formatUfUnits, formatUfUnitsFine } from "../../format";
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
  return (
    <>
      <h2 className={styles.sectionTitle}>
        {isMortgageView ? "Dividendos hipoteca (hoja depto)" : "Hipoteca / dividendos (hoja depto)"}
      </h2>
      <p className={cn("muted", styles.proseMuted)}>
        Tabla leída directamente de <span className="mono">{m?.csv_path ?? "cfraser/depto-dividendos.csv"}</span>: cada
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
      <Table
        tableClassName={`mortgage-sheet ${styles.tableMortgage}`}
        header={
          <thead>
            <tr>
              <th rowSpan={2}>Cuota</th>
              <th rowSpan={2}>Fecha</th>
              <th rowSpan={2}>Pago CLP</th>
              <th rowSpan={2}>Pago UF</th>
              <th rowSpan={2}>% div.</th>
              <th rowSpan={2}>UF día</th>
              <th rowSpan={2}>m/m</th>
              <th rowSpan={2}>y/y</th>
              <th rowSpan={2}>+ tasa</th>
              <th rowSpan={2}>Crédito UF</th>
              <th rowSpan={2}>% créd.</th>
              <th rowSpan={2}>Restante CLP</th>
              <th rowSpan={2}>Δ crédito</th>
              <th rowSpan={2}>Valor neto UF</th>
              <th rowSpan={2}>Valor neto CLP</th>
              <th rowSpan={2}>Pagado neto UF</th>
              <th rowSpan={2}>Δ VN CLP</th>
              <th rowSpan={2}>Vivienda UF</th>
              <th rowSpan={2}>Vivienda CLP</th>
              <th rowSpan={2}>Min UF</th>
              <th colSpan={2}>Incendio</th>
              <th colSpan={2}>Desgravamen</th>
              <th colSpan={2}>Total seguros</th>
              <th colSpan={2}>Amortización</th>
              <th colSpan={2}>Amort. ext</th>
              <th colSpan={2}>Interés</th>
              <th rowSpan={2}>Δ créd. (amort)</th>
              <th rowSpan={2}>Int. oculto</th>
              <th rowSpan={2}>Int. oculto B</th>
              <th rowSpan={2}>Int. real</th>
              <th rowSpan={2}>Int. calc UF</th>
              <th rowSpan={2}>amort/int</th>
              <th rowSpan={2}>Pago acum.</th>
              <th rowSpan={2}>Amort acum</th>
              <th rowSpan={2}>Int acum</th>
            </tr>
            <tr>
              <th>CLP</th>
              <th>UF</th>
              <th>CLP</th>
              <th>UF</th>
              <th>CLP</th>
              <th>UF</th>
              <th>CLP</th>
              <th>UF</th>
              <th>CLP</th>
              <th>UF</th>
              <th>CLP</th>
              <th>UF</th>
            </tr>
          </thead>
        }
      >
        {ledger.rows.map((row, idx) => (
          <tr key={`${row.cuota}-${row.occurred_on}-${idx}`}>
            <td className="mono">{row.cuota}</td>
            <td>{row.occurred_on}</td>
            <td className="mono">{cellClp(row.pago_clp)}</td>
            <td className="mono">{formatUfUnitsFine(row.pago_uf)}</td>
            <td className="mono muted">{cellTxt(row.pct_dividendo)}</td>
            <td className="mono">{row.uf_clp_day != null ? formatClp(Math.round(row.uf_clp_day)) : "—"}</td>
            <td className="mono muted">{cellTxt(row.mm_pct)}</td>
            <td className="mono muted">{cellTxt(row.yy_pct)}</td>
            <td className="mono muted">{tasaPlusLabel(row.tasa_plus)}</td>
            <td className="mono">{row.credito_restante_uf != null ? formatUfUnits(row.credito_restante_uf) : "—"}</td>
            <td className="mono muted">{cellTxt(row.pct_credito_uf)}</td>
            <td className="mono">{cellClp(row.restante_clp)}</td>
            <td className="mono">{cellClp(row.delta_credito_clp)}</td>
            <td className="mono">{row.valor_neto_uf != null ? formatUfUnits(row.valor_neto_uf) : "—"}</td>
            <td className="mono">{cellClp(row.valor_neto_clp)}</td>
            <td className="mono">{formatUfUnitsFine(row.pagado_neto_uf)}</td>
            <td className="mono">{cellClp(row.delta_valor_neto_clp)}</td>
            <td className="mono">{row.valor_vivienda_uf != null ? formatUfUnits(row.valor_vivienda_uf) : "—"}</td>
            <td className="mono">{cellClp(row.valor_vivienda_clp)}</td>
            <td className="mono">{formatUfUnitsFine(row.min_uf)}</td>
            <td className="mono">{cellClp(row.incendio_clp)}</td>
            <td className="mono">{formatUfUnitsFine(row.incendio_uf)}</td>
            <td className="mono">{cellClp(row.desgravamen_clp)}</td>
            <td className="mono">{formatUfUnitsFine(row.desgravamen_uf)}</td>
            <td className="mono">{cellClp(row.total_seguros_clp)}</td>
            <td className="mono">{formatUfUnitsFine(row.total_seguros_uf)}</td>
            <td className="mono">{cellClp(row.amortizacion_clp)}</td>
            <td className="mono">{formatUfUnitsFine(row.amortizacion_uf)}</td>
            <td className="mono">{cellClp(row.amortizacion_ext_clp)}</td>
            <td className="mono">{formatUfUnitsFine(row.amortizacion_ext_uf)}</td>
            <td className="mono">{cellClp(row.interes_clp)}</td>
            <td className="mono">{formatUfUnitsFine(row.interes_uf)}</td>
            <td className="mono">{cellClp(row.delta_credito_amort_clp)}</td>
            <td className="mono">{cellClp(row.interes_oculto_clp)}</td>
            <td className="mono">{cellClp(row.interes_oculto_b_clp)}</td>
            <td className="mono">{cellClp(row.interes_real_clp)}</td>
            <td className="mono">{formatUfUnitsFine(row.interes_calculado_uf)}</td>
            <td className="mono muted">{cellTxt(row.amort_interes_text)}</td>
            <td className="mono muted">{cellClp(row.pago_acumulado_clp)}</td>
            <td className="mono muted">{cellClp(row.amort_acum_clp)}</td>
            <td className="mono muted">{cellClp(row.interes_acum_clp)}</td>
          </tr>
        ))}
      </Table>
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

export function DeptoPaymentScenarioTable({ rows }: { rows: DeptoPaymentScenarioRow[] }) {
  if (!rows.length) return null;
  const terms: DeptoPaymentScenarioTerm[] = [30, 25, 20, 15, 12, 10, 5, "max"];
  return (
    <>
      <h3 className={styles.subsectionTitleMid}>Referencia: cuota mín / máx (UF)</h3>
      <p className={cn("muted", styles.proseMutedXs)}>
        Escenarios de la hoja depto (no son movimientos), en fechas del calendario hipotecario (día 11 de cada mes).
        La primera fila es la próxima cuota proyectada. El pago mínimo (30 años) es editable en Numbers; el máximo
        (~80 UF) aproxima amortizar en 5 años al inicio del crédito.
      </p>
      <Table
        tableClassName={styles.tableScenario}
        header={
          <thead>
            <tr>
              <th>Cuota</th>
              <th>Fecha</th>
              {terms.map((t) => (
                <th key={String(t)} className={styles.nowrap}>
                  {SCENARIO_TERM_LABELS[t]}
                </th>
              ))}
            </tr>
          </thead>
        }
      >
        {[...rows].reverse().map((row) => {
          const byTerm = new Map(row.scenarios.map((s) => [s.term, s]));
          return (
            <tr key={`${row.cuota}-${row.occurred_on}`}>
              <td className="mono">
                {row.cuota}
                {row.is_next_payment ? (
                  <span className={cn("muted", styles.cellSub)}>próx.</span>
                ) : null}
              </td>
              <td className="mono">{row.occurred_on}</td>
              {terms.map((t) => {
                const cell =
                  t === 30
                    ? {
                        uf: row.min_payment_uf,
                        clp: row.min_payment_clp,
                      }
                    : {
                        uf: byTerm.get(t)?.payment_uf ?? null,
                        clp: byTerm.get(t)?.payment_clp ?? null,
                      };
                return (
                  <td key={String(t)} className={cn("mono", styles.nowrap)}>
                    {cell.uf != null ? formatUfUnitsFine(cell.uf) : "—"}
                    {cell.clp != null ? (
                      <span className={cn("muted", styles.cellSub)}>{formatClp(cell.clp)}</span>
                    ) : null}
                  </td>
                );
              })}
            </tr>
          );
        })}
      </Table>
    </>
  );
}
