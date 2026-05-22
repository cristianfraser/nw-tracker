import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "../../api";
import { queryKeys } from "../../queries/keys";
import { Table } from "../../components/Table";
import type { AccountCcInstallmentsResponse } from "../../types";
import { formatClp } from "../../format";
import { cn } from "../../cn";
import { useTranslation } from "../../i18n";
import { formatYmEs, persistExtraCcOffsets } from "./shared";
import { CreditCardFacturacionesTable } from "./CreditCardFacturacionesTable";
import styles from "../AccountDetailPage.module.css";

function CreditCardInstallmentsSection({
  ledger,
  extraOffsets,
  accountId,
  onExtraOffsetsChange,
  displayUnit,
}: {
  ledger: AccountCcInstallmentsResponse;
  extraOffsets: Record<string, number>;
  accountId: number;
  onExtraOffsetsChange: (next: Record<string, number>) => void;
  displayUnit: "clp" | "usd";
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const m = ledger.meta;
  const fromDb = ledger.source === "db";
  const statements = ledger.statements ?? [];
  const facturaciones = ledger.facturaciones ?? [];
  const [manualOpen, setManualOpen] = useState(false);
  const [manualBusy, setManualBusy] = useState(false);
  const [manualForm, setManualForm] = useState({
    purchase_date: "",
    total_amount_clp: "",
    cuotas_totales: "",
    merchant: "",
  });

  const refreshLedger = () => {
    void queryClient.invalidateQueries({
      queryKey: queryKeys.accountDetail(
        String(accountId),
        displayUnit,
        "monthly",
        JSON.stringify(extraOffsets)
      ),
    });
  };

  const submitManualPurchase = async () => {
    setManualBusy(true);
    try {
      await api.createCcPurchase(accountId, {
        purchase_date: manualForm.purchase_date,
        total_amount_clp: Number(manualForm.total_amount_clp.replace(/\./g, "")),
        cuotas_totales: Number(manualForm.cuotas_totales),
        merchant: manualForm.merchant || undefined,
      });
      setManualOpen(false);
      setManualForm({ purchase_date: "", total_amount_clp: "", cuotas_totales: "", merchant: "" });
      refreshLedger();
    } finally {
      setManualBusy(false);
    }
  };
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
          <div className={cn("mono", "muted", styles.purchaseMeta)}>{p.purchase_id}</div>
          {p.purchase_source === "manual" ? (
            <div className={cn("muted", styles.purchaseMeta)}>{t("account.creditCard.sourceManual")}</div>
          ) : fromDb ? (
            <div className={cn("muted", styles.purchaseMeta)}>{t("account.creditCard.sourcePdf")}</div>
          ) : null}
          {p.note ? <div className={cn("muted", styles.purchaseMeta)}>{p.note}</div> : null}
          {fromDb && p.purchase_source === "manual" && p.purchase_db_id != null ? (
            <button
              type="button"
              className={cn("muted", styles.purchaseMeta)}
              disabled={manualBusy}
              onClick={async () => {
                setManualBusy(true);
                try {
                  await api.deleteCcPurchase(accountId, p.purchase_db_id!);
                  refreshLedger();
                } finally {
                  setManualBusy(false);
                }
              }}
            >
              {t("account.creditCard.manualDelete")}
            </button>
          ) : null}
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
              className={cn("mono", styles.offsetInput)}
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
      <h2 className={styles.sectionTitle}>Cupos en cuotas (tarjeta)</h2>
      {fromDb ? (
        <p className={cn("muted", styles.proseMuted)}>
          Datos importados a la base desde los PDF de estado de cuenta (cuotas).{" "}
          {m?.db_purchase_count != null && m?.db_payment_count != null ? (
            <>
              <span className="mono">{m.db_purchase_count}</span> compras en cuotas,{" "}
              <span className="mono">{m.db_payment_count}</span> pagos de cuota registrados.
            </>
          ) : null}{" "}
          {m?.pay_by_rule ? (
            <span className={cn("muted", styles.stateNote)}>{m.pay_by_rule}</span>
          ) : null}
        </p>
      ) : (
        <>
          <p className={cn("muted", styles.proseMuted)}>
            Datos desde <span className="mono">{m?.csv_path ?? "cfraser/credit-card-installments.csv"}</span>. Tasa anual
            nominal por compra (por defecto <strong>0%</strong> = cuota fija); si en el futuro cargas cupos con interés,
            el saldo restante usa amortización mensual estándar. El campo <strong>Offset UI</strong> suma meses solo en
            esta vista (y en el navegador) para correr el calendario si el estado de cuenta llegó un mes después; el offset
            persistente va en la columna CSV <span className="mono">schedule_offset_months</span>.
          </p>
          {m && (
            <p className={cn("muted", styles.proseSm)}>
              Archivo:{" "}
              <span className={cn("mono", styles.breakAll)}>
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
        <p className={cn("muted", styles.marginBottomBase)}>
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
        <p className={cn("muted", styles.marginBottomBase)}>
          El CSV existe pero no hay filas válidas: revisa cabecera y números (principal positivo, cuotas ≥ 1,{" "}
          <span className="mono">first_due_month</span> en formato <span className="mono">YYYY-MM</span>, pagadas ≤
          total).
        </p>
      ) : (
        <>
          <div className={cn("cards", styles.cardsBelow)}>
            <div className="card">
              <div className="label">Total cupos restantes (aprox.)</div>
              <div className="value mono">{formatClp(ledger.totals.total_remaining_principal_clp)}</div>
            </div>
            <div className="card">
              <div className="label">Próximo mes con cargos</div>
              <div className={cn("value", "mono", styles.cardValueSecondary)}>
                {ledger.totals.next_calendar_month
                  ? `${formatYmEs(ledger.totals.next_calendar_month)} · ${formatClp(ledger.totals.next_calendar_month_total_clp ?? 0)}`
                  : "—"}
              </div>
            </div>
          </div>

          {fromDb && facturaciones.length > 0 ? (
            <>
              <h3 className={styles.subsectionTitle}>{t("accountDetail.creditCard.facturacionesTitle")}</h3>
              <p className={cn("muted", styles.proseSmTight)}>{t("accountDetail.creditCard.facturacionesHint")}</p>
              <CreditCardFacturacionesTable rows={facturaciones} statements={statements} />
            </>
          ) : null}

          {fromDb ? (
            <div className={styles.marginBottomBase}>
              {!manualOpen ? (
                <button type="button" onClick={() => setManualOpen(true)}>
                  {t("account.creditCard.manualAdd")}
                </button>
              ) : (
                <div className={cn("card", styles.cardsBelow)}>
                  <div className="label">{t("account.creditCard.manualAdd")}</div>
                  <div className={styles.manualFormGrid}>
                    <label>
                      {t("account.creditCard.manualDate")}
                      <input
                        type="date"
                        value={manualForm.purchase_date}
                        onChange={(e) =>
                          setManualForm((f) => ({ ...f, purchase_date: e.target.value }))
                        }
                      />
                    </label>
                    <label>
                      {t("account.creditCard.manualPrincipal")}
                      <input
                        type="text"
                        className="mono"
                        value={manualForm.total_amount_clp}
                        onChange={(e) =>
                          setManualForm((f) => ({ ...f, total_amount_clp: e.target.value }))
                        }
                      />
                    </label>
                    <label>
                      {t("account.creditCard.manualCuotas")}
                      <input
                        type="number"
                        min={1}
                        className="mono"
                        value={manualForm.cuotas_totales}
                        onChange={(e) =>
                          setManualForm((f) => ({ ...f, cuotas_totales: e.target.value }))
                        }
                      />
                    </label>
                    <label>
                      {t("account.creditCard.manualMerchant")}
                      <input
                        type="text"
                        value={manualForm.merchant}
                        onChange={(e) => setManualForm((f) => ({ ...f, merchant: e.target.value }))}
                      />
                    </label>
                  </div>
                  <div className={styles.manualFormActions}>
                    <button type="button" disabled={manualBusy} onClick={() => void submitManualPurchase()}>
                      {t("account.creditCard.manualSubmit")}
                    </button>
                    <button type="button" disabled={manualBusy} onClick={() => setManualOpen(false)}>
                      {t("account.creditCard.manualCancel")}
                    </button>
                  </div>
                </div>
              )}
            </div>
          ) : null}


          <h3 className={styles.subsectionTitle}>Compras activas (cuotas pendientes)</h3>
          <Table
            wrapClassName={styles.tableWrapSpaced}
            tableClassName={styles.tableCompact}
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

          <h3 className={styles.subsectionTitle}>Compras completadas (histórico)</h3>
          <p className={cn("muted", styles.caption)}>
            Incluye contratos cuyo total pagado alcanzó el principal (incl. última cuota en el PDF aunque{" "}
            <span className="mono">nro_cuota_current</span> falte en filas resumen tipo{" "}
            <span className="mono">03 CUOTAS COMERC</span>).
          </p>
          <Table
            key={`cc-completed-${accountId}`}
            collapsedVisibleRows={5}
            wrapClassName={styles.tableWrapSpaced}
            tableClassName={styles.tableCompact}
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

          <h3 className={styles.subsectionTitle}>Proyección por mes (una fila por mes)</h3>
          <Table
            tableClassName={styles.tableCompact}
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
                        <ul className={styles.nestedList}>
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

export function CreditCardDetailSections(props: Parameters<typeof CreditCardInstallmentsSection>[0]) {
  return <CreditCardInstallmentsSection {...props} />;
}

