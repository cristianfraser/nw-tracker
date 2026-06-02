import { Fragment, useMemo, useState } from "react";
import { Table } from "../../components/ui/Table";
import { PaginatedTable } from "../../components/ui/PaginatedTable";
import type { AccountCcInstallmentsResponse, CcInstallmentPurchaseComputed } from "../../types";
import { formatClp } from "../../format";
import { cn } from "../../cn";
import { useTranslation } from "../../i18n";
import { formatYmEs, persistExtraCcOffsets } from "./shared";
import { CreditCardFacturacionesTable } from "./CreditCardFacturacionesTable";
import {
  useCreateCcPurchaseMutation,
  useDeleteCcPurchaseMutation,
} from "../../queries/hooks";
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
  const mutationOpts = {
    accountId,
    displayUnit,
    extraCcOffsetsKey: JSON.stringify(extraOffsets),
  };
  const createPurchase = useCreateCcPurchaseMutation(mutationOpts);
  const deletePurchase = useDeleteCcPurchaseMutation(mutationOpts);
  const m = ledger.meta;
  const hasLedger = ledger.has_installment_ledger;
  const hasData =
    hasLedger ||
    ledger.has_imported_statements ||
    ledger.purchases.length > 0 ||
    (ledger.purchases_completed?.length ?? 0) > 0;
  const statements = ledger.statements ?? [];
  const facturaciones = ledger.facturaciones ?? [];
  const [manualOpen, setManualOpen] = useState(false);
  const [manualForm, setManualForm] = useState({
    purchase_date: "",
    total_amount_clp: "",
    cuotas_totales: "",
    merchant: "",
  });

  const manualBusy = createPurchase.isPending || deletePurchase.isPending;

  const submitManualPurchase = () => {
    createPurchase.mutate(
      {
        purchase_date: manualForm.purchase_date,
        total_amount_clp: Number(manualForm.total_amount_clp.replace(/\./g, "")),
        cuotas_totales: Number(manualForm.cuotas_totales),
        merchant: manualForm.merchant || undefined,
      },
      {
        onSuccess: () => {
          setManualOpen(false);
          setManualForm({ purchase_date: "", total_amount_clp: "", cuotas_totales: "", merchant: "" });
        },
      }
    );
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
    rows: ReadonlyArray<CcInstallmentPurchaseComputed>,
    opts: { dueColumn: "next" | "last" | "none" }
  ) =>
    rows.map((p) => {
      const detailColSpan = hasLedger ? (opts.dueColumn === "none" ? 9 : 10) : opts.dueColumn === "none" ? 12 : 13;
      return (
        <Fragment key={p.purchase_id}>
          <tr>
            <td>
              <div>{p.label}</div>
              <div className={cn("mono", "muted", styles.purchaseMeta)}>{p.purchase_id}</div>
              <div className={cn("muted", styles.purchaseMeta)}>
                {p.origin === "manual"
                  ? t("account.creditCard.originManual")
                  : t("account.creditCard.originImportDocument")}
              </div>
              {p.note ? <div className={cn("muted", styles.purchaseMeta)}>{p.note}</div> : null}
              {hasLedger && p.origin === "manual" && p.purchase_db_id != null ? (
                <button
                  type="button"
                  className={cn("muted", styles.purchaseMeta)}
                  disabled={manualBusy}
                  onClick={() => {
                    deletePurchase.mutate(p.purchase_db_id!);
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
            {!hasLedger ? (
              <td className="mono">{p.annual_interest_pct.toFixed(2).replace(".", ",")}</td>
            ) : null}
            <td className="mono">{p.purchase_month ?? "—"}</td>
            <td className="mono">{p.first_due_month}</td>
            {!hasLedger ? <td className="mono">{p.schedule_offset_months}</td> : null}
            {!hasLedger ? (
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
          {opts.dueColumn === "none" && p.payment_statements && p.payment_statements.length > 0 ? (
            <tr>
              <td colSpan={detailColSpan} className={cn("muted", styles.purchaseMeta)}>
                {p.merged_purchase_ids && p.merged_purchase_ids.length > 1 ? (
                  <div className="mono">
                    duplicate purchase ids merged: {p.merged_purchase_ids.join(", ")}
                  </div>
                ) : null}
                {p.merge_reason ? <div className="mono">merge reason: {p.merge_reason}</div> : null}
                {p.heuristic_hints && p.heuristic_hints.length > 0 ? (
                  <div className="mono">heuristics: {p.heuristic_hints.join(" | ")}</div>
                ) : null}
                <div>Estado(s) con cuota para esta compra:</div>
                {p.payment_statements.map((st, idx) => (
                  <div key={`${p.purchase_id}:st:${idx}`} className="mono">
                    {st.statement_date ?? "sin fecha estado"} · {st.source_pdf ?? "sin source_pdf"} · pay_by{" "}
                    {st.pay_by_date} · cuota {st.cuota_current ?? "?"} · {formatClp(st.amount_clp)}
                  </div>
                ))}
              </td>
            </tr>
          ) : null}
        </Fragment>
      );
    });

  const purchasesCompletedPages = useMemo(() => {
    const pageSize = 10;
    if (purchasesCompletedSorted.length === 0) {
      return [{ pageNumber: 0, data: [] as CcInstallmentPurchaseComputed[] }];
    }

    const chunks: CcInstallmentPurchaseComputed[][] = [];
    for (let i = 0; i < purchasesCompletedSorted.length; i += pageSize) {
      chunks.push(purchasesCompletedSorted.slice(i, i + pageSize));
    }

    const totalChunks = chunks.length;
    // PaginatedTable defaults to the last page; we want the last array element to be the newest chunk.
    // Keep `pageNumber` aligned with "Página {pageNumber + 1}" where Página 1 is the newest chunk.
    return chunks
      .reverse()
      .map((data, revIdx) => ({ pageNumber: totalChunks - 1 - revIdx, data }));
  }, [purchasesCompletedSorted]);

  return (
    <>
      <h2 className={styles.sectionTitle}>Cupos en cuotas (tarjeta)</h2>
      {hasLedger ? (
        <p className={cn("muted", styles.proseMuted)}>
          {t("account.creditCard.installmentsLedgerHint")}{" "}
          {m?.installment_purchase_count != null && m?.installment_payment_count != null ? (
            <>
              <span className="mono">{m.installment_purchase_count}</span> compras en cuotas,{" "}
              <span className="mono">{m.installment_payment_count}</span> pagos de cuota registrados.
            </>
          ) : null}{" "}
          {m?.pay_by_rule ? (
            <span className={cn("muted", styles.stateNote)}>{m.pay_by_rule}</span>
          ) : null}
        </p>
      ) : null}
      {!hasData ? (
        <p className={cn("muted", styles.marginBottomBase)}>{t("account.creditCard.installmentsEmpty")}</p>
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

          {hasLedger && facturaciones.length > 0 ? (
            <>
              <h3 className={styles.subsectionTitle}>{t("accountDetail.creditCard.facturacionesTitle")}</h3>
              <p className={cn("muted", styles.proseSmTight)}>{t("accountDetail.creditCard.facturacionesHint")}</p>
              <CreditCardFacturacionesTable
                rows={facturaciones}
                statements={statements}
                accountId={accountId}
                displayUnit={displayUnit}
                extraCcOffsetsKey={JSON.stringify(extraOffsets)}
              />
            </>
          ) : null}

          {hasLedger ? (
            <div className={styles.marginBottomBase}>
              {!manualOpen ? (
                <button type="button" onClick={() => setManualOpen(true)}>
                  {t("account.creditCard.manualAdd")}
                </button>
              ) : (
                <div className={cn("card", styles.cardsBelow)}>
                  <div className="label">{t("account.creditCard.manualAdd")}</div>
                  {ledger.open_billing_month ? (
                    <p className={cn("muted", styles.proseSmTight)}>
                      {t("account.creditCard.manualOpenBillingMonthHint", {
                        month: formatYmEs(ledger.open_billing_month),
                      })}
                    </p>
                  ) : null}
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
                    <button type="button" disabled={manualBusy} onClick={submitManualPurchase}>
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
                  {!hasLedger ? <th>Tasa % anual</th> : null}
                  <th>Mes compra</th>
                  <th>1.ª cuota (MES)</th>
                  {!hasLedger ? <th>Offset CSV (meses)</th> : null}
                  {!hasLedger ? <th>Offset UI (meses)</th> : null}
                  <th>Cuota CLP</th>
                  <th>Restante CLP</th>
                </tr>
              </thead>
            }
          >
            {ledger.purchases.length === 0 ? (
              <tr>
                <td colSpan={hasLedger ? 8 : 12} className="muted">
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
          <PaginatedTable
            key={`cc-completed-${accountId}`}
            pages={purchasesCompletedPages}
            collapsedVisibleRows={10}
            wrapClassName={styles.tableWrapSpaced}
            tableClassName={styles.tableCompact}
            getPageLabel={(page) => `${t("table.paginationPageAria")} ${page.pageNumber + 1}`}
            header={
              <thead>
                <tr>
                  <th>Compra</th>
                  <th>Cuotas</th>
                  <th>Pagadas</th>
                  <th>Restan</th>
                  <th>Principal</th>
                  {!hasLedger ? <th>Tasa % anual</th> : null}
                  <th>Mes compra</th>
                  <th>1.ª cuota (MES)</th>
                  {!hasLedger ? <th>Offset CSV (meses)</th> : null}
                  {!hasLedger ? <th>Offset UI (meses)</th> : null}
                  <th>Cuota CLP</th>
                  <th>Restante CLP</th>
                  <th>Mes último pago</th>
                </tr>
              </thead>
            }
            renderBody={(pageRows) =>
              purchasesCompletedSorted.length === 0 ? (
                <tr>
                  <td colSpan={hasLedger ? 9 : 13} className="muted">
                    No hay compras en cuotas liquidadas en el ledger.
                  </td>
                </tr>
              ) : (
                renderPurchaseRows(pageRows, { dueColumn: "last" })
              )
            }
          />

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

