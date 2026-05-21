import { useDeferredValue, useLayoutEffect, useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import { CcInstallmentHistoryChart } from "../components/CcInstallmentHistoryChart";
import { MonthlyPerformanceComboChart } from "../components/MonthlyPerformanceComboChart";
import { AccountFlowsTable } from "../components/AccountFlowsTable";
import { MonthlyPerfDetailTable } from "../components/MonthlyPerfDetailTable";
import { Table } from "../components/Table";
import {
  filterPointsThroughAsOfDate,
  trailingZeroTailClipLastVisibleDate,
} from "../components/AppLineChart";
import {
  buildLineChartTailClipOptions,
  LineChartPanel,
  trimLeadingInactivePoints,
} from "../components/ValuationLineCharts";
import { useAccountDetailBundle, useAccountMonthlyPerformance, useDashboardBundle, useSidebarNav } from "../queries/hooks";
import { useDisplayPreferences } from "../context/DisplayPreferencesContext";
import { filterAccountFlowsPersonalOnly, accountMovementsToFlowRows } from "../accountFlows";
import { chartStrokeFromRgbTriplet } from "../chartColors";
import { CompactEntityCard } from "../components/CompactEntityCard";
import { DashboardCardGroupMetrics } from "../components/DashboardCardGroupMetrics";
import { PortfolioEntityCardsStrip } from "../components/PortfolioEntityCardsStrip";
import { PortfolioNavChildDetailCards } from "../components/PortfolioNavChildDetailCards";
import { useTranslation } from "../i18n";
import type {
  AccountCcInstallmentsResponse,
  AccountMortgageLedgerResponse,
  DeptoPaymentScenarioRow,
  DeptoPaymentScenarioTerm,
} from "../types";
import { findNavTreeNodeByAccountId } from "../portfolioNavFromApi";
import type { EntityColorTarget } from "../entityColor";
import { PageTitleRow } from "../components/PageTitleRow";
import {
  accountCardTitleBalanceDelta,
  cardGroupMetricsFromAccounts,
} from "../dashboardCardBreakdown";
import {
  formatClp,
  formatInstrumentUnits,
  formatUfUnits,
  formatUfUnitsFine,
} from "../format";

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

const CC_EXTRA_OFFSET_LS = "nw-credit-card-extra-offsets";

function persistExtraCcOffsets(accountId: number, next: Record<string, number>) {
  try {
    localStorage.setItem(`${CC_EXTRA_OFFSET_LS}:${accountId}`, JSON.stringify(next));
  } catch {
    /* ignore */
  }
}

function formatYmEs(ym: string): string {
  const [ys, ms] = ym.split("-");
  const m = Number(ms);
  const names = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
  const label = m >= 1 && m <= 12 ? names[m - 1] : ym;
  return `${label} ${ys}`;
}

function CreditCardInstallmentsSection({
  ledger,
  extraOffsets,
  accountId,
  onExtraOffsetsChange,
}: {
  ledger: AccountCcInstallmentsResponse;
  extraOffsets: Record<string, number>;
  accountId: number;
  onExtraOffsetsChange: (next: Record<string, number>) => void;
}) {
  const m = ledger.meta;
  const fromDb = ledger.source === "db";
  const hist = ledger.installment_history_months ?? [];
  const purchasesCompleted = ledger.purchases_completed ?? [];

  const purchasesActiveSorted = useMemo(() => {
    const list = [...ledger.purchases];
    list.sort((a, b) => {
      const d = a.remaining_installments - b.remaining_installments;
      if (d !== 0) return d;
      return a.label.localeCompare(b.label, "es");
    });
    return list;
  }, [ledger.purchases]);

  const allPurchasesForBreakdown = useMemo(
    () => [...purchasesActiveSorted, ...purchasesCompleted],
    [purchasesActiveSorted, purchasesCompleted]
  );

  const purchasesCompletedSorted = useMemo(() => {
    const list = [...purchasesCompleted];
    list.sort((a, b) => {
      const ya = a.last_paid_month ?? "";
      const yb = b.last_paid_month ?? "";
      if (ya === yb) return a.label.localeCompare(b.label, "es");
      if (!ya) return 1;
      if (!yb) return -1;
      return yb.localeCompare(ya);
    });
    return list;
  }, [purchasesCompleted]);

  const renderPurchaseRows = (
    rows: typeof ledger.purchases,
    opts: { dueColumn: "next" | "last" | "none" }
  ) =>
    rows.map((p) => (
      <tr key={p.purchase_id}>
        <td>
          <div>{p.label}</div>
          <div className="mono muted" style={{ fontSize: "0.72rem" }}>
            {p.purchase_id}
          </div>
          {p.note ? <div className="muted" style={{ fontSize: "0.72rem" }}>{p.note}</div> : null}
        </td>
        <td className="mono">{p.installment_count}</td>
        <td className="mono">{p.installments_paid}</td>
        <td className="mono">{p.remaining_installments}</td>
        <td className="mono">{formatClp(p.principal_clp)}</td>
        {!fromDb ? (
          <td className="mono">{p.annual_interest_pct.toFixed(2).replace(".", ",")}</td>
        ) : null}
        <td className="mono">{p.purchase_month ?? "—"}</td>
        <td className="mono">{p.first_due_month}</td>
        {!fromDb ? <td className="mono">{p.schedule_offset_months}</td> : null}
        {!fromDb ? (
          <td>
            <input
              type="number"
              step={1}
              className="mono"
              style={{ width: "4.5rem", padding: "0.2rem 0.35rem" }}
              value={extraOffsets[p.purchase_id] ?? 0}
              onChange={(e) => {
                const raw = e.target.value;
                const n = raw === "" || raw === "-" ? 0 : Math.trunc(Number(raw));
                const v = Number.isFinite(n) ? n : 0;
                const next = { ...extraOffsets, [p.purchase_id]: v };
                persistExtraCcOffsets(accountId, next);
                onExtraOffsetsChange(next);
              }}
              aria-label={`Meses de offset adicionales para ${p.label}`}
            />
          </td>
        ) : null}
        <td className="mono">{formatClp(p.cuota_clp)}</td>
        <td className="mono">{formatClp(p.remaining_principal_clp)}</td>
        {opts.dueColumn !== "none" ? (
          <td className="mono">
            {opts.dueColumn === "last"
              ? p.last_paid_month
                ? `${p.last_paid_month} (${formatYmEs(p.last_paid_month)})`
                : "—"
              : p.next_due_month
                ? `${p.next_due_month} (${formatYmEs(p.next_due_month)})`
                : "—"}
          </td>
        ) : null}
      </tr>
    ));

  return (
    <>
      <h2 style={{ marginTop: "1.5rem" }}>Cupos en cuotas (tarjeta)</h2>
      {fromDb ? (
        <p className="muted" style={{ fontSize: "0.85rem", marginBottom: "0.65rem", maxWidth: "58rem" }}>
          Datos importados a la base desde los PDF de estado de cuenta (cuotas).{" "}
          {m?.db_purchase_count != null && m?.db_payment_count != null ? (
            <>
              <span className="mono">{m.db_purchase_count}</span> compras en cuotas,{" "}
              <span className="mono">{m.db_payment_count}</span> pagos de cuota registrados.
            </>
          ) : null}{" "}
          {m?.pay_by_rule ? (
            <span style={{ display: "block", marginTop: "0.35rem", fontSize: "0.78rem" }}>
              {m.pay_by_rule}
            </span>
          ) : null}
        </p>
      ) : (
        <>
          <p className="muted" style={{ fontSize: "0.85rem", marginBottom: "0.65rem", maxWidth: "58rem" }}>
            Datos desde <span className="mono">{m?.csv_path ?? "cfraser/credit-card-installments.csv"}</span>. Tasa anual
            nominal por compra (por defecto <strong>0%</strong> = cuota fija); si en el futuro cargas cupos con interés,
            el saldo restante usa amortización mensual estándar. El campo <strong>Offset UI</strong> suma meses solo en
            esta vista (y en el navegador) para correr el calendario si el estado de cuenta llegó un mes después; el offset
            persistente va en la columna CSV <span className="mono">schedule_offset_months</span>.
          </p>
          {m && (
            <p className="muted" style={{ fontSize: "0.8rem", marginBottom: "0.75rem" }}>
              Archivo:{" "}
              <span className="mono" style={{ wordBreak: "break-all" }}>
                {m.csv_absolute_path}
              </span>
              {m.csv_file_exists === false ? " (no encontrado)" : null}
            </p>
          )}
        </>
      )}
      {ledger.source === "none" &&
      ledger.purchases.length === 0 &&
      (ledger.purchases_completed?.length ?? 0) === 0 ? (
        <p className="muted" style={{ marginBottom: "1rem" }}>
          No hay datos en la base ni CSV de cupos. Opciones: importar PDF parseados con{" "}
          <span className="mono">npm run import:cc-parsed -w nw-tracker-server -- --account-id=…</span>, o crear{" "}
          <span className="mono">cfraser/credit-card-installments.csv</span> con cabecera{" "}
          <span className="mono">
            purchase_id;label;principal_clp;installment_count;installments_paid;cuota_clp;annual_interest_pct;first_due_month;schedule_offset_months;purchase_month;note
          </span>
          .
        </p>
      ) : ledger.source === "csv" &&
        ledger.purchases.length === 0 &&
        (ledger.purchases_completed?.length ?? 0) === 0 ? (
        <p className="muted" style={{ marginBottom: "1rem" }}>
          El CSV existe pero no hay filas válidas: revisa cabecera y números (principal positivo, cuotas ≥ 1,{" "}
          <span className="mono">first_due_month</span> en formato <span className="mono">YYYY-MM</span>, pagadas ≤
          total).
        </p>
      ) : (
        <>
          <div className="cards" style={{ marginBottom: "0.75rem" }}>
            <div className="card">
              <div className="label">Total cupos restantes (aprox.)</div>
              <div className="value mono">{formatClp(ledger.totals.total_remaining_principal_clp)}</div>
            </div>
            <div className="card">
              <div className="label">Próximo mes con cargos</div>
              <div className="value mono" style={{ fontSize: "0.95rem" }}>
                {ledger.totals.next_calendar_month
                  ? `${formatYmEs(ledger.totals.next_calendar_month)} · ${formatClp(ledger.totals.next_calendar_month_total_clp ?? 0)}`
                  : "—"}
              </div>
            </div>
          </div>

          {fromDb && hist.length > 0 ? (
            <>
              <h3 style={{ fontSize: "1.05rem", marginBottom: "0.35rem" }}>Historial (cuotas)</h3>
              <p className="muted" style={{ fontSize: "0.8rem", marginBottom: "0.4rem", maxWidth: "58rem" }}>
                Línea: <strong>cierre mensual</strong> desde el ledger de estados de cuenta parseados (misma serie que
                el gráfico «Valorización y aportes» y el rendimiento mensual de esta página). Barras: suma de cuotas
                cuyo <strong>PAGAR HASTA</strong> cae en ese mes calendario.
              </p>
              {m?.remaining_balance_line_rule ? (
                <p className="muted" style={{ fontSize: "0.75rem", marginBottom: "0.35rem", maxWidth: "58rem" }}>
                  {m.remaining_balance_line_rule}
                </p>
              ) : null}
              <CcInstallmentHistoryChart rows={hist} />
            </>
          ) : null}

          <h3 style={{ fontSize: "1.05rem", marginBottom: "0.35rem" }}>Compras activas (cuotas pendientes)</h3>
          <Table
            wrapStyle={{ marginBottom: "1.25rem" }}
            tableStyle={{ fontSize: "0.82rem" }}
            header={
              <thead>
                <tr>
                  <th>Compra</th>
                  <th>Cuotas</th>
                  <th>Pagadas</th>
                  <th>Restan</th>
                  <th>Principal</th>
                  {!fromDb ? <th>Tasa % anual</th> : null}
                  <th>Mes compra</th>
                  <th>1.ª cuota (MES)</th>
                  {!fromDb ? <th>Offset CSV (meses)</th> : null}
                  {!fromDb ? <th>Offset UI (meses)</th> : null}
                  <th>Cuota CLP</th>
                  <th>Restante CLP</th>
                </tr>
              </thead>
            }
          >
            {ledger.purchases.length === 0 ? (
              <tr>
                <td colSpan={fromDb ? 8 : 12} className="muted">
                  No hay compras en cuotas con saldo pendiente.
                </td>
              </tr>
            ) : (
              renderPurchaseRows(purchasesActiveSorted, { dueColumn: "none" })
            )}
          </Table>

          <h3 style={{ fontSize: "1.05rem", marginBottom: "0.35rem" }}>Compras completadas (histórico)</h3>
          <p className="muted" style={{ fontSize: "0.78rem", marginBottom: "0.4rem", maxWidth: "58rem" }}>
            Incluye contratos cuyo total pagado alcanzó el principal (incl. última cuota en el PDF aunque{" "}
            <span className="mono">nro_cuota_current</span> falte en filas resumen tipo{" "}
            <span className="mono">03 CUOTAS COMERC</span>).
          </p>
          <Table
            key={`cc-completed-${accountId}`}
            collapsedVisibleRows={5}
            wrapStyle={{ marginBottom: "1.25rem" }}
            tableStyle={{ fontSize: "0.82rem" }}
            header={
              <thead>
                <tr>
                  <th>Compra</th>
                  <th>Cuotas</th>
                  <th>Pagadas</th>
                  <th>Restan</th>
                  <th>Principal</th>
                  {!fromDb ? <th>Tasa % anual</th> : null}
                  <th>Mes compra</th>
                  <th>1.ª cuota (MES)</th>
                  {!fromDb ? <th>Offset CSV (meses)</th> : null}
                  {!fromDb ? <th>Offset UI (meses)</th> : null}
                  <th>Cuota CLP</th>
                  <th>Restante CLP</th>
                  <th>Mes último pago</th>
                </tr>
              </thead>
            }
          >
            {purchasesCompletedSorted.length === 0 ? (
              <tr>
                <td colSpan={fromDb ? 9 : 13} className="muted">
                  No hay compras en cuotas liquidadas en el ledger.
                </td>
              </tr>
            ) : (
              renderPurchaseRows(purchasesCompletedSorted, { dueColumn: "last" })
            )}
          </Table>

          <h3 style={{ fontSize: "1.05rem", marginBottom: "0.35rem" }}>Proyección por mes (una fila por mes)</h3>
          <Table
            tableStyle={{ fontSize: "0.82rem" }}
            header={
              <thead>
                <tr>
                  <th>Mes</th>
                  <th>Total CLP</th>
                  <th>Acumulado en período</th>
                  <th>Detalle</th>
                </tr>
              </thead>
            }
          >
            {ledger.months.length === 0 ? (
              <tr>
                <td colSpan={4} className="muted">
                  Sin cuotas pendientes en el calendario.
                </td>
              </tr>
            ) : (
              (() => {
                let cum = 0;
                return ledger.months.map((row) => {
                  cum += row.total_clp;
                  return (
                    <tr key={row.month}>
                      <td className="mono">
                        {row.month} ({formatYmEs(row.month)})
                      </td>
                      <td className="mono">{formatClp(row.total_clp)}</td>
                      <td className="mono muted">{formatClp(cum)}</td>
                      <td>
                        <ul style={{ margin: 0, paddingLeft: "1.1rem" }}>
                          {row.breakdown.map((b, i) => (
                            <li key={`${b.purchase_id}-${b.installment_index}-${i}`} className="mono muted">
                              {b.label}: {formatClp(b.amount_clp)} (cuota {b.installment_index + 1} de{" "}
                              {allPurchasesForBreakdown.find((x) => x.purchase_id === b.purchase_id)?.installment_count ?? "?"})
                            </li>
                          ))}
                        </ul>
                      </td>
                    </tr>
                  );
                });
              })()
            )}
          </Table>
        </>
      )}
    </>
  );
}

function MortgageDividendosTable({
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
      <h2 style={{ marginTop: "1.5rem" }}>
        {isMortgageView ? "Dividendos hipoteca (hoja depto)" : "Hipoteca / dividendos (hoja depto)"}
      </h2>
      <p className="muted" style={{ fontSize: "0.85rem", marginBottom: "0.65rem", maxWidth: "58rem" }}>
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
        <div className="cards" style={{ marginBottom: "0.75rem" }}>
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
            <div className="value mono" style={{ fontSize: "0.95rem" }}>
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
        tableClassName="mortgage-sheet"
        tableStyle={{ fontSize: "0.78rem" }}
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

function DeptoPaymentScenarioTable({ rows }: { rows: DeptoPaymentScenarioRow[] }) {
  if (!rows.length) return null;
  const terms: DeptoPaymentScenarioTerm[] = [30, 25, 20, 15, 12, 10, 5, "max"];
  return (
    <>
      <h3 style={{ marginTop: "1.25rem", marginBottom: "0.35rem", fontSize: "1.05rem" }}>
        Referencia: cuota mín / máx (UF)
      </h3>
      <p className="muted" style={{ fontSize: "0.85rem", marginBottom: "0.5rem", maxWidth: "58rem" }}>
        Escenarios de la hoja depto (no son movimientos), en fechas del calendario hipotecario (día 11 de cada mes).
        La primera fila es la próxima cuota proyectada. El pago mínimo (30 años) es editable en Numbers; el máximo
        (~80 UF) aproxima amortizar en 5 años al inicio del crédito.
      </p>
      <Table
        tableStyle={{ fontSize: "0.78rem" }}
        header={
          <thead>
            <tr>
              <th>Cuota</th>
              <th>Fecha</th>
              {terms.map((t) => (
                <th key={String(t)} style={{ whiteSpace: "nowrap" }}>
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
                  <span className="muted" style={{ display: "block", fontSize: "0.72rem" }}>
                    próx.
                  </span>
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
                  <td key={String(t)} className="mono" style={{ whiteSpace: "nowrap" }}>
                    {cell.uf != null ? formatUfUnitsFine(cell.uf) : "—"}
                    {cell.clp != null ? (
                      <span className="muted" style={{ display: "block", fontSize: "0.72rem" }}>
                        {formatClp(cell.clp)}
                      </span>
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

function movementUnitsKind(categorySlug: string | null | undefined): "shares" | "coin" {
  if (categorySlug === "bitcoin" || categorySlug === "eth") return "coin";
  return "shares";
}

type ChartGranularity = "monthly" | "daily";

/** Default visible rows in “Detalle por mes” (newest first); rest behind “Mostrar más”. */
const MONTHLY_PERF_COLLAPSED = 12;
const ACCOUNT_FLOWS_COLLAPSED = 10;

export function AccountDetailPage() {
  const { t } = useTranslation();
  const { id } = useParams();
  const [extraCcOffsets, setExtraCcOffsets] = useState<Record<string, number>>({});
  const { displayUnit, metricsPeriod } = useDisplayPreferences();
  const [chartGranularity, setChartGranularity] = useState<ChartGranularity>("monthly");
  const [movementsOnlyPersonalDeposits, setMovementsOnlyPersonalDeposits] = useState(false);

  const deferredCcOffsets = useDeferredValue(extraCcOffsets);

  const {
    data: detail,
    error: detailError,
    isPending: detailPending,
  } = useAccountDetailBundle(id, displayUnit, chartGranularity, deferredCcOffsets);
  const {
    data: monthlyPerf,
    error: monthlyPerfError,
  } = useAccountMonthlyPerformance(id, displayUnit);

  const { data: sidebarNav } = useSidebarNav();
  const { data: dashBundle } = useDashboardBundle(displayUnit);
  const dash = dashBundle?.dash ?? null;
  const overviewPoints = dashBundle?.ts?.overview?.points ?? [];

  const summary = detail?.summary ?? null;
  const movements = detail?.movements ?? [];
  const ts = detail?.ts ?? null;
  const depositInflows = detail?.depositInflows ?? null;
  const mortgageLedger = detail?.mortgageLedger ?? null;
  const ccLedger = detail?.ccLedger ?? null;
  const invNavAccounts = detail?.invNavAccounts ?? null;
  const err =
    detailError instanceof Error
      ? detailError.message
      : detailError
        ? "Failed to load"
        : null;
  const monthlyPerfErr =
    monthlyPerfError instanceof Error
      ? monthlyPerfError.message
      : monthlyPerfError
        ? "No se pudo cargar el rendimiento mensual."
        : null;

  const valuationTailClipEndDate = useMemo(() => {
    if (!ts?.accounts?.points?.length) return null;
    const block = trimLeadingInactivePoints(ts.accounts, true);
    const opts = buildLineChartTailClipOptions(block, true);
    if (!opts) return null;
    return trailingZeroTailClipLastVisibleDate(block.points, opts);
  }, [ts?.accounts]);

  const monthlyPerfRows = useMemo(
    () => filterPointsThroughAsOfDate(monthlyPerf?.monthly ?? [], valuationTailClipEndDate),
    [monthlyPerf?.monthly, valuationTailClipEndDate]
  );

  const ytdChartPoints = useMemo(() => {
    if (!monthlyPerfRows.length) return [];
    return [...monthlyPerfRows].reverse().map((r) => ({
      as_of_date: r.as_of_date,
      nominal_pl: r.nominal_pl ?? 0,
      ytd_nominal_pl: r.ytd_nominal_pl ?? 0,
    }));
  }, [monthlyPerfRows]);

  const accChartPoints = useMemo(() => {
    if (!monthlyPerfRows.length) return [];
    return [...monthlyPerfRows].reverse().map((r) => ({
      as_of_date: r.as_of_date,
      delta_month: r.nominal_pl ?? 0,
      accumulated_earnings: r.cumulative_nominal_pl ?? 0,
    }));
  }, [monthlyPerfRows]);

  const allFlows = useMemo(() => accountMovementsToFlowRows(movements), [movements]);

  const displayedFlows = useMemo(() => {
    if (!movementsOnlyPersonalDeposits) return allFlows;
    return filterAccountFlowsPersonalOnly(allFlows);
  }, [allFlows, movementsOnlyPersonalDeposits]);

  useLayoutEffect(() => {
    if (!id) return;
    try {
      setExtraCcOffsets(JSON.parse(localStorage.getItem(`${CC_EXTRA_OFFSET_LS}:${id}`) || "{}"));
    } catch {
      setExtraCcOffsets({});
    }
  }, [id]);

  const navSelf = useMemo(() => {
    const accountId = summary?.account_id ?? (id ? Number(id) : NaN);
    if (!Number.isFinite(accountId) || accountId <= 0) return null;
    return findNavTreeNodeByAccountId(sidebarNav?.main ?? [], accountId);
  }, [sidebarNav?.main, summary?.account_id, id]);

  /** From `GET /api/accounts/:id/valuation-timeseries` (`accounts.color_rgb` in DB). */
  const accountColorRgb = useMemo(() => {
    if (summary == null || ts == null) return null;
    return (
      ts.accounts.accounts?.find((a) => a.account_id === summary.account_id)?.color_rgb ?? null
    );
  }, [summary, ts?.accounts.accounts]);

  const pageColorTarget = useMemo((): EntityColorTarget | undefined => {
    const accountId = summary?.account_id ?? (id ? Number(id) : NaN);
    if (!Number.isFinite(accountId) || accountId <= 0) return undefined;
    return { kind: "account", accountId };
  }, [summary?.account_id, id]);

  const accountChartTheme = useMemo(
    () => ({
      bar: chartStrokeFromRgbTriplet(accountColorRgb),
      areaStroke: "#64748b",
      areaFill: "rgba(148, 163, 184, 0.22)",
    }),
    [accountColorRgb]
  );

  if (detailPending) {
    return (
      <main>
        <p className="muted">Loading…</p>
      </main>
    );
  }

  if (err) {
    return (
      <main>
        <p className="error">{err}</p>
      </main>
    );
  }

  if (!summary || !ts || !depositInflows || !mortgageLedger || !ccLedger || invNavAccounts == null) {
    return (
      <main>
        <p className="muted">Loading…</p>
      </main>
    );
  }

  const showMonthlyPerformance =
    summary.category_slug !== "cuenta_corriente" && summary.category_slug !== "cuenta_ahorro_vivienda";
  const isAfpAccount = summary.category_slug === "afp";
  const isMortgageAccount = summary.category_slug === "mortgage";
  const ccChartsFromParsedLedger =
    summary.category_slug === "credit_card" && ccLedger.source === "db";
  const lastChartRow =
    ts.accounts.points.length > 0 ? ts.accounts.points[ts.accounts.points.length - 1]! : null;
  const accountDataKey = String(summary.account_id);
  const chartUsdVal =
    displayUnit === "usd" &&
    lastChartRow &&
    typeof lastChartRow[accountDataKey] === "number" &&
    Number.isFinite(lastChartRow[accountDataKey] as number)
      ? (lastChartRow[accountDataKey] as number)
      : null;

  const accountDashRow =
    dash?.accounts.find((a) => a.account_id === summary.account_id) ?? null;
  const accountTitleDelta =
    accountDashRow != null
      ? accountCardTitleBalanceDelta(accountDashRow, metricsPeriod, displayUnit === "usd")
      : null;
  const accountMetricsAgg = cardGroupMetricsFromAccounts(
    accountDashRow ? [accountDashRow] : [],
    metricsPeriod
  );
  const accountNavChildren = navSelf?.children?.filter((c) => c.route_path?.trim()) ?? [];

  return (
    <main>
      <PageTitleRow
        title={ts.name}
        colorRgb={accountColorRgb}
        colorTarget={pageColorTarget}
      />
      <PortfolioEntityCardsStrip
        compactSlot={
          <CompactEntityCard
            label={ts.name}
            balanceDelta={accountTitleDelta}
            showUsd={displayUnit === "usd"}
            clp={
              displayUnit === "usd"
                ? 0
                : accountDashRow?.current_value_clp ?? summary.latest_valuation_clp ?? 0
            }
            apiUsd={
              displayUnit === "usd"
                ? accountDashRow?.current_value_usd ?? chartUsdVal
                : null
            }
            cardSlug={`acc-${summary.account_id}-hero`}
            animated
            stripInner
            valueVariant="main"
            metrics={
              <DashboardCardGroupMetrics
                metrics={accountMetricsAgg}
                showUsd={displayUnit === "usd"}
                period={metricsPeriod}
                cardSlug={`acc-${summary.account_id}-hero`}
                animated
              />
            }
          />
        }
        detailSlots={
          dash && accountNavChildren.length > 0 ? (
            <PortfolioNavChildDetailCards
              dash={dash}
              overviewPoints={overviewPoints}
              navChildren={accountNavChildren}
              showUsd={displayUnit === "usd"}
              metricsPeriod={metricsPeriod}
              animated
            />
          ) : null
        }
      />

      {summary.position != null && (
        <div style={{ marginTop: "0.75rem" }}>
          <h2 style={{ marginBottom: "0.35rem" }}>Posición (ticker y cuotas)</h2>
          <p className="muted" style={{ fontSize: "0.85rem", marginBottom: "0.5rem" }}>
            Acciones: cuotas desde <span className="mono">cfraser/net worth-stocks.csv</span> (columna valor
            acción). Cripto: saldo neto de moneda desde notas de movimientos del import.
            {isAfpAccount ? (
              <>
                {" "}
                AFP UNO Fondo A: cuotas totales desde <span className="mono">movements.units_delta</span> (certificado
                en <span className="mono">cfraser/afp-uno-certificado-cotizaciones.csv</span> o{" "}
                <span className="mono">.txt</span> al correr{" "}
                <span className="mono">import:excel</span>
                , o <span className="mono">npm run afp:uno:cert-sync</span>).
              </>
            ) : null}
          </p>
          <Table
            header={
              <thead>
                <tr>
                  <th>Ticker</th>
                  <th>Cuotas / unidades</th>
                  <th>Depositado (CLP)</th>
                  <th>Valor hoy (CLP)</th>
                  <th>Fecha valor</th>
                  <th>Valor / unidad (CLP)</th>
                </tr>
              </thead>
            }
          >
            <tr>
              <td className="mono">{summary.position.ticker}</td>
              <td className="mono">
                {summary.position.units != null && Number.isFinite(summary.position.units)
                  ? formatInstrumentUnits(summary.position.units, summary.position.units_kind)
                  : "—"}
              </td>
              <td className="mono">{formatClp(summary.position.deposited_clp)}</td>
              <td className="mono">
                {summary.position.value_clp != null ? formatClp(summary.position.value_clp) : "—"}
              </td>
              <td className="muted">{summary.position.value_as_of ?? "—"}</td>
              <td className="mono">
                {summary.position.value_per_unit_clp != null
                  ? formatClp(summary.position.value_per_unit_clp)
                  : "—"}
              </td>
            </tr>
          </Table>
        </div>
      )}

      <div className="toggle-row">
        <span className="muted">{t("accountDetail.chart.seriesLabel")} </span>
        <label>
          <input
            type="radio"
            name="gran"
            checked={chartGranularity === "monthly"}
            onChange={() => setChartGranularity("monthly")}
          />{" "}
          {t("accountDetail.chart.monthlyEnd")}
        </label>
        <label>
          <input
            type="radio"
            name="gran"
            checked={chartGranularity === "daily"}
            onChange={() => setChartGranularity("daily")}
          />{" "}
          {t("accountDetail.chart.daily")}
        </label>
      </div>
      {chartGranularity === "daily" && ts.granularity === "monthly" ? (
        <p className="muted" style={{ fontSize: "0.85rem", marginTop: "0.35rem" }}>
          Serie diaria no disponible para esta cuenta (solo SPY/VEA con unidades en bolsa e import Yahoo).
        </p>
      ) : null}

      <div className="chart-grid chart-grid--full-line" style={{ marginTop: "0.75rem" }}>
        <LineChartPanel title="Valorización y aportes" block={ts.accounts} displayUnit={displayUnit} />
      </div>

      {showMonthlyPerformance ? (
        <>
          <h2 style={{ marginTop: "1.25rem" }}>Rendimiento mensual (calculado)</h2>
          <p className="muted" style={{ fontSize: "0.85rem", marginBottom: "0.5rem", maxWidth: "58rem" }}>
            Dos gráficos: (1) P/L mensual vs <strong>YTD</strong> (área reinicia cada enero). (2) mismo Δ mensual con
            área <strong>Accumulated earnings</strong> (continua desde el primer mes, sin franjas por año). La tabla
            conserva el detalle.
            {isMortgageAccount ? (
              <>
                {" "}
                En hipoteca, <strong>P/L mes</strong> = aportes netos − baja de saldo en CLP (coste UF + intereses vs
                amortización visible), no la fórmula de inversión.
              </>
            ) : null}
            {ccChartsFromParsedLedger ? (
              <>
                {" "}
                Las valorizaciones mensuales de esta cuenta se escriben en la base al importar el CSV del PDF; las
                pestañas de clase (p. ej. Liabilities) leen la misma tabla.
              </>
            ) : (
              <> Misma base que valorización y aportes.</>
            )}{" "}
            Unidad: <strong>{displayUnit === "usd" ? "USD" : "CLP"}</strong>
            {chartGranularity === "daily" ? (
              <> La serie mensual no sigue la vista diaria (aportes solo en mensual).</>
            ) : null}
          </p>
          {monthlyPerfErr ? (
            <p className="error" style={{ fontSize: "0.9rem" }}>
              {monthlyPerfErr}
            </p>
          ) : monthlyPerf == null ? (
            <p className="muted">Cargando rendimiento…</p>
          ) : monthlyPerfRows.length === 0 ? (
            <p className="muted">
              Sin suficientes meses de valorización mensual para calcular variaciones (o la cuenta solo tiene un
              punto).
            </p>
          ) : (
            <>
              <h3 style={{ marginTop: "0.35rem", marginBottom: "0.35rem", fontSize: "1.05rem" }}>
                YTD (año calendario)
              </h3>
              <div className="chart-grid chart-grid--full-line" style={{ marginTop: 0 }}>
                <MonthlyPerformanceComboChart
                  title="P/L mensual vs YTD"
                  titleAs="h3"
                  points={ytdChartPoints}
                  displayUnit={displayUnit}
                  barSeries={[
                    {
                      dataKey: "nominal_pl",
                      name: isMortgageAccount ? "Coste financiero mes" : "Δ mes (P/L nominal)",
                      color: accountChartTheme.bar,
                    },
                  ]}
                  areaKey="ytd_nominal_pl"
                  areaName="YTD"
                  areaFill={accountChartTheme.areaFill}
                  areaStroke={accountChartTheme.areaStroke}
                />
              </div>
              <h3 style={{ marginTop: "1.35rem", marginBottom: "0.35rem", fontSize: "1.05rem" }}>
                Accumulated earnings
              </h3>
              <div className="chart-grid chart-grid--full-line" style={{ marginTop: 0 }}>
                <MonthlyPerformanceComboChart
                  title="Monthly Δ y accumulated earnings"
                  titleAs="h3"
                  points={accChartPoints}
                  displayUnit={displayUnit}
                  barSeries={[
                    {
                      dataKey: "delta_month",
                      name: isMortgageAccount ? "Coste financiero mes" : "Monthly Δ",
                      color: accountChartTheme.bar,
                    },
                  ]}
                  areaKey="accumulated_earnings"
                  areaName="Accumulated earnings"
                  areaFill={accountChartTheme.areaFill}
                  areaStroke={accountChartTheme.areaStroke}
                  alternateYearAreaStripes={false}
                />
              </div>
              <h3 style={{ marginTop: "1.25rem", marginBottom: "0.35rem", fontSize: "1.05rem" }}>
                {t("accountDetail.monthlyDetailTitle")}
              </h3>
              <MonthlyPerfDetailTable
                key={`${id}-${displayUnit}-mp-detail`}
                rows={monthlyPerfRows}
                displayUnit={displayUnit}
                collapsedVisibleRows={MONTHLY_PERF_COLLAPSED}
                isMortgageAccount={isMortgageAccount}
                isAfpAccount={isAfpAccount}
                movementUnitsKind={movementUnitsKind}
              />
            </>
          )}
        </>
      ) : null}

      {mortgageLedger.source === "csv" && mortgageLedger.rows.length > 0 ? (
        <>
          <MortgageDividendosTable
            ledger={mortgageLedger}
            variant={isMortgageAccount ? "mortgage" : "property"}
          />
          {mortgageLedger.payment_scenarios && mortgageLedger.payment_scenarios.length > 0 ? (
            <DeptoPaymentScenarioTable rows={mortgageLedger.payment_scenarios} />
          ) : null}
        </>
      ) : mortgageLedger.source === "csv" ? (
        <p className="muted" style={{ marginTop: "1rem" }}>
          No hay filas con pago CLP en <span className="mono">cfraser/depto-dividendos.csv</span>
          {mortgageLedger.meta?.csv_absolute_path ? (
            <>
              . El servidor leyó{" "}
              <span className="mono" style={{ wordBreak: "break-all" }}>
                {mortgageLedger.meta.csv_absolute_path}
              </span>
              {mortgageLedger.meta.csv_file_exists === false ? " (archivo no encontrado)" : ""}.
            </>
          ) : null}{" "}
          Re-exporta la hoja dividendos desde Numbers o revisa <span className="mono">CFRASER_CSV_DIR</span> si apunta
          a otra carpeta.
        </p>
      ) : null}

      {summary.category_slug === "credit_card" && ccLedger ? (
        <CreditCardInstallmentsSection
          ledger={ccLedger}
          extraOffsets={extraCcOffsets}
          accountId={summary.account_id}
          onExtraOffsetsChange={setExtraCcOffsets}
        />
      ) : null}

      <div className="cards" style={{ marginTop: "1.5rem" }}>
        <div className="card">
          <div className="label">Flujo neto (mov + bolsa)</div>
          <div className="value mono">{formatClp(summary.deposits_clp)}</div>
          {depositInflows != null &&
          Math.abs(depositInflows.display_total_clp - depositInflows.total_clp) > 0.5 ? (
            <div className="muted" style={{ fontSize: "0.8rem", marginTop: "0.35rem" }}>
              Propios: <span className="mono">{formatClp(depositInflows.display_total_clp)}</span>
              {" · "}
              Estatal: <span className="mono">{formatClp(depositInflows.state_contribution_total_clp)}</span>
            </div>
          ) : null}
        </div>
        <div className="card">
          <div className="label">Withdrawals</div>
          <div className="value mono">{formatClp(summary.withdrawals_clp)}</div>
        </div>
        <div className="card">
          <div className="label">Latest valuation</div>
          <div className="value mono">
            {summary.latest_valuation_clp != null ? formatClp(summary.latest_valuation_clp) : "—"}
          </div>
          <div className="muted" style={{ fontSize: "0.8rem", marginTop: "0.35rem" }}>
            {summary.latest_valuation_date ?? ""}
          </div>
        </div>
      </div>

      {depositInflows != null && depositInflows.state_contribution_events.length > 0 ? (
        <>
          <h2 style={{ marginTop: "1.5rem" }}>Aporte estatal APV-A</h2>
          <p className="muted" style={{ marginBottom: "0.5rem", fontSize: "0.85rem" }}>
            Bonificación del Estado (~15% de tus depósitos del año anterior, con tope). Total acumulado:{" "}
            <span className="mono">{formatClp(depositInflows.state_contribution_total_clp)}</span>
          </p>
          <Table
            header={
              <thead>
                <tr>
                  <th>Fecha</th>
                  <th>Monto CLP</th>
                  <th>Acumulado CLP</th>
                </tr>
              </thead>
            }
          >
            {depositInflows.state_contribution_events.map((e, idx) => (
              <tr key={`state-${e.occurred_on}-${idx}`}>
                <td>{e.occurred_on}</td>
                <td className="mono">{formatClp(e.amt_clp)}</td>
                <td className="mono muted">{formatClp(e.cumulative_clp)}</td>
              </tr>
            ))}
          </Table>
        </>
      ) : null}

      <h2>{t("accountDetail.flowsTitle")}</h2>
      <p className="muted" style={{ fontSize: "0.85rem", marginBottom: "0.5rem" }}>
        Un solo listado por cuenta: aportes, retiros, compras, dividendos, cuotas, etc. Todo en{" "}
        <span className="mono">movements</span> (SPY/VEA usan <span className="mono">flow_kind</span>, ticker y USD).
        Altas: <span className="mono">POST /api/accounts/{id}/movements</span>.
      </p>
      <label
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          marginBottom: "0.65rem",
          fontSize: "0.9rem",
          cursor: "pointer",
        }}
      >
        <input
          type="checkbox"
          checked={movementsOnlyPersonalDeposits}
          onChange={(e) => setMovementsOnlyPersonalDeposits(e.target.checked)}
        />
        {t("accountDetail.flowsPersonalOnly")}
      </label>
      <AccountFlowsTable
        rows={displayedFlows.map((row) => ({
          ...row,
          category_slug: summary.category_slug ?? undefined,
        }))}
        collapsedVisibleRows={ACCOUNT_FLOWS_COLLAPSED}
        movementUnitsKind={movementUnitsKind}
        totalCount={allFlows.length}
      />
    </main>
  );
}
