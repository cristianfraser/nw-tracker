import { useMemo, useState } from "react";
import { Table } from "../../components/ui/Table";
import { Loadable } from "../../components/ui/Loadable";
import { PaginatedTable } from "../../components/ui/PaginatedTable";
import type {
  AccountCcInstallmentsResponse,
  CcInstallmentMonthBreakdown,
  CcInstallmentPurchaseComputed,
} from "../../types";
import { formatClp, formatGroupedDecimal } from "../../format";
import { cn } from "../../cn";
import { Trans, useTranslation } from "../../i18n";
import { formatYearMonthLabel } from "../../formatDateLabel";
import { CreditCardCuotaProgress } from "./CreditCardCuotaProgress";
import { CreditCardFacturacionesTable } from "./CreditCardFacturacionesTable";
import { CreditCardPurchaseVendor, purchaseVendorSource } from "./CreditCardPurchaseVendor";
import { ExpenseVendorLabel } from "../../components/credit-card/ExpenseVendorLabel";
import {
  CreditCardPurchaseMobileCard,
  purchaseTableColSpan,
} from "./CreditCardPurchaseMobileCard";
import {
  TableMobileCard,
  TableMobileCardRow,
  TableMobileCardSection,
} from "../../components/ui/TableMobileCard";
import { useDeleteCcPurchaseMutation } from "../../queries/hooks";
import styles from "../AccountDetailPage.module.css";

function CreditCardInstallmentsSection({
  ledger,
  accountId,
  displayUnit,
  loading = false,
}: {
  ledger: AccountCcInstallmentsResponse;
  accountId: number;
  displayUnit: "clp" | "usd";
  /** The ledger is a placeholder or held prior data: the section keeps its frame, dimmed, with no «empty» copy. */
  loading?: boolean;
}) {
  const { t } = useTranslation();
  const deletePurchase = useDeleteCcPurchaseMutation({ accountId, displayUnit });
  const m = ledger.meta;
  const hasData =
    ledger.has_installment_ledger ||
    ledger.has_imported_statements ||
    ledger.purchases.length > 0 ||
    (ledger.purchases_completed?.length ?? 0) > 0;
  // A placeholder ledger (loading, nothing in it) states no installment ledger yet: frame the
  // ledger layout, not the legacy columns.
  const hasLedger = ledger.has_installment_ledger || (loading && !hasData);
  const facturaciones = ledger.facturaciones ?? [];
  const manualBusy = deletePurchase.isPending;
  const purchasesCompleted = ledger.purchases_completed ?? [];

  // The server orders `purchases` (plan finishing soonest first, ties by billing month —
  // `ccActivePurchaseOrder.ts`); the client only picks.
  const purchasesActiveSorted = useMemo(() => [...ledger.purchases], [ledger.purchases]);

  // The progress bars of the active table share one segment width: 1/(longest plan) of the row.
  const maxActiveInstallments = useMemo(
    () => purchasesActiveSorted.reduce((m, p) => Math.max(m, p.installment_count), 0),
    [purchasesActiveSorted]
  );

  const purchaseById = useMemo(() => {
    const map = new Map<string, CcInstallmentPurchaseComputed>();
    for (const p of [...purchasesActiveSorted, ...purchasesCompleted]) {
      map.set(p.purchase_id, p);
    }
    return map;
  }, [purchasesActiveSorted, purchasesCompleted]);

  const renderMonthCuotasBreakdown = (
    breakdown: readonly CcInstallmentMonthBreakdown[],
    listClassName: string
  ) => (
    <ul className={listClassName}>
      {breakdown.map((b, i) => (
        <li key={`${b.purchase_id}-${b.installment_index}-${i}`} className="mono muted">
          <Trans
            i18nKey="account.creditCard.monthCuotasBreakdownLine"
            values={{
              amount: formatClp(b.amount_clp),
              current: b.installment_index + 1,
              total:
                b.installment_count ??
                purchaseById.get(b.purchase_id)?.installment_count ??
                "?",
            }}
            components={{ name: <CuotaVendor breakdown={b} purchase={purchaseById.get(b.purchase_id)} /> }}
          />
        </li>
      ))}
    </ul>
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

  // Only a hand-entered plan can be deleted (a statement plan comes back with the next import).
  const deleteManual = (p: CcInstallmentPurchaseComputed) =>
    hasLedger && p.origin === "manual" && p.purchase_db_id != null
      ? () => deletePurchase.mutate(p.purchase_db_id!)
      : undefined;

  const purchaseVendor = (p: CcInstallmentPurchaseComputed) => (
    <CreditCardPurchaseVendor
      purchase={p}
      accountId={accountId}
      onDeleteManual={deleteManual(p)}
      deleteBusy={manualBusy}
    />
  );

  const activePurchaseTableHeader = (
    <thead>
      <tr className={styles.activePurchaseRow}>
        <th className="desktop-only">{t("account.creditCard.colPurchase")}</th>
        <th className="desktop-only">{t("account.creditCard.colInstallments")}</th>
        <th className="mobile-only" aria-hidden="true" />
      </tr>
    </thead>
  );

  // One row per plan: the date over the vendor (`merchant · note · link ⓘ ⋯`, as its expense
  // lines read) on the left, the progress bar on the right — under it on a narrow desktop (`.activePurchaseRow`), and on
  // mobile the card stacks the same pieces.
  const renderActivePurchaseRows = (rows: ReadonlyArray<CcInstallmentPurchaseComputed>) =>
    rows.map((p) => (
      <tr key={p.purchase_id} className={styles.activePurchaseRow}>
        <td className="desktop-only">
          <div className="mono">
            {p.purchase_date ?? "—"}
            {p.cuota_progress ? null : ` · ${formatClp(p.cuota_clp)}`}
          </div>
          {purchaseVendor(p)}
        </td>
        <td className="desktop-only">
          {p.cuota_progress ? (
            <CreditCardCuotaProgress
              progress={p.cuota_progress}
              cuotaClp={p.cuota_clp}
              maxInstallments={maxActiveInstallments}
            />
          ) : null}
        </td>
        <td className="mobile-only">
          <CreditCardPurchaseMobileCard
            purchase={p}
            accountId={accountId}
            hasLedger={hasLedger}
            dueColumn="none"
            manualBusy={manualBusy}
            onDeleteManual={deleteManual(p)}
            maxInstallments={maxActiveInstallments}
          />
        </td>
      </tr>
    ));

  const completedPurchaseTableHeader = (
    <thead>
      <tr>
        <th className="desktop-only">{t("account.creditCard.colPurchase")}</th>
        <th className="desktop-only">{t("account.creditCard.colInstallments")}</th>
        <th className="desktop-only">{t("account.creditCard.colPrincipal")}</th>
        {!hasLedger ? <th className="desktop-only">{t("account.creditCard.colAnnualRate")}</th> : null}
        <th className="desktop-only">{t("account.creditCard.colPurchaseDate")}</th>
        <th className="desktop-only">{t("account.creditCard.colPurchaseBillingMonth")}</th>
        {!hasLedger ? <th className="desktop-only">{t("account.creditCard.colOffsetCsv")}</th> : null}
        <th className="desktop-only">{t("account.creditCard.colCuotaClp")}</th>
        <th className="desktop-only">{t("account.creditCard.colLastPaid")}</th>
        <th className="mobile-only" aria-hidden="true" />
      </tr>
    </thead>
  );

  const renderCompletedPurchaseRows = (rows: ReadonlyArray<CcInstallmentPurchaseComputed>) =>
    rows.map((p) => (
      <tr key={p.purchase_id}>
        <td className="desktop-only">
          {purchaseVendor(p)}
        </td>
        <td className="mono desktop-only">{p.installment_count}</td>
        <td className="mono desktop-only">{formatClp(p.principal_clp)}</td>
        {!hasLedger ? (
          <td className="mono desktop-only">{formatGroupedDecimal(p.annual_interest_pct, 2)}</td>
        ) : null}
        <td className="mono desktop-only">{p.purchase_date ?? "—"}</td>
        <td className="mono desktop-only">{p.purchase_billing_month ?? p.purchase_month ?? "—"}</td>
        {!hasLedger ? <td className="mono desktop-only">{p.schedule_offset_months}</td> : null}
        <td className="mono desktop-only">{formatClp(p.cuota_clp)}</td>
        <td className="mono desktop-only">
          {p.last_paid_month ? formatYearMonthLabel(p.last_paid_month) : "—"}
        </td>
        <td className="mobile-only">
          <CreditCardPurchaseMobileCard
            purchase={p}
            accountId={accountId}
            hasLedger={hasLedger}
            dueColumn="last"
            manualBusy={manualBusy}
            onDeleteManual={deleteManual(p)}
            maxInstallments={maxActiveInstallments}
          />
        </td>
      </tr>
    ));

  const COMPLETED_PAGE_SIZE = 10;
  const [completedPage, setCompletedPage] = useState(1);

  const completedPageRows = useMemo(() => {
    const start = (completedPage - 1) * COMPLETED_PAGE_SIZE;
    return purchasesCompletedSorted.slice(start, start + COMPLETED_PAGE_SIZE);
  }, [purchasesCompletedSorted, completedPage]);

  return (
    <Loadable loading={loading}>
      <h2 className={styles.sectionTitle}>{t("account.creditCard.installmentsTitle")}</h2>
      {ledger.has_installment_ledger ? (
        <p className={cn("muted", styles.proseMuted)}>
          {m?.installment_purchase_count != null && m?.installment_payment_count != null ? (
            <Trans
              i18nKey="account.creditCard.installmentsCounts"
              values={{
                purchases: m.installment_purchase_count,
                payments: m.installment_payment_count,
              }}
              components={{ 1: <span className="mono" />, 2: <span className="mono" /> }}
            />
          ) : null}{" "}
          {m?.pay_by_rule_i18n_key ? (
            <span className={cn("muted", styles.stateNote)}>{t(m.pay_by_rule_i18n_key)}</span>
          ) : null}
        </p>
      ) : null}
      {!hasData && !loading ? (
        <p className={cn("muted", styles.marginBottomBase)}>{t("account.creditCard.installmentsEmpty")}</p>
      ) : (
        <>
          <div className={cn("cards", styles.cardsBelow)}>
            <div className="card">
              <div className="label">{t("account.creditCard.totalRemainingLabel")}</div>
              <div className="value mono">{formatClp(ledger.totals.total_remaining_principal_clp)}</div>
            </div>
            <div className="card">
              <div className="label">{t("account.creditCard.nextMonthWithCharges")}</div>
              <div className={cn("value", "mono", styles.cardValueSecondary)}>
                {ledger.totals.next_calendar_month
                  ? `${formatYearMonthLabel(ledger.totals.next_calendar_month)} · ${formatClp(ledger.totals.next_calendar_month_total_clp ?? 0)}`
                  : "—"}
              </div>
            </div>
          </div>

          {(ledger.has_installment_ledger && facturaciones.length > 0) || loading ? (
            <>
              <h3 className={styles.subsectionTitle}>{t("accountDetail.creditCard.facturacionesTitle")}</h3>
              <CreditCardFacturacionesTable
                rows={facturaciones}
                accountId={accountId}
                displayUnit={displayUnit}
                facturacionProxy={ledger.facturacion_proxy}
                proxyTickers={ledger.proxy_tickers}
                pendingCuotaPurchases={ledger.pending_cuota_purchases}
              />
            </>
          ) : null}

          <h3 className={styles.subsectionTitle}>{t("account.creditCard.activePurchasesTitle")}</h3>
          <Table
            wrapClassName={styles.tableWrapSpaced}
            tableClassName={cn(styles.tableCompact, "table--parallel-mobile")}
            header={activePurchaseTableHeader}
          >
            {ledger.purchases.length === 0 ? (
              loading ? null : (
                <tr>
                  <td colSpan={purchaseTableColSpan(hasLedger, "none")} className="muted">
                    {t("account.creditCard.activePurchasesEmpty")}
                  </td>
                </tr>
              )
            ) : (
              renderActivePurchaseRows(purchasesActiveSorted)
            )}
          </Table>

          <h3 className={styles.subsectionTitle}>{t("account.creditCard.completedPurchasesTitle")}</h3>
          <PaginatedTable
            key={`cc-completed-${accountId}`}
            page={completedPage}
            pageSize={COMPLETED_PAGE_SIZE}
            total={purchasesCompletedSorted.length}
            onPageChange={setCompletedPage}
            wrapClassName={styles.tableWrapSpaced}
          >
            <Table
              tableClassName={cn(styles.tableCompact, "table--parallel-mobile")}
              header={completedPurchaseTableHeader}
            >
              {purchasesCompletedSorted.length === 0 ? (
                loading ? null : (
                  <tr>
                    <td colSpan={purchaseTableColSpan(hasLedger, "last")} className="muted">
                      {t("account.creditCard.completedPurchasesEmpty")}
                    </td>
                  </tr>
                )
              ) : (
                renderCompletedPurchaseRows(completedPageRows)
              )}
            </Table>
          </PaginatedTable>

          <h3 className={styles.subsectionTitle}>{t("account.creditCard.monthCuotasTitle")}</h3>
          <Table
            tableClassName={cn(styles.tableCompact, "table--parallel-mobile")}
            header={
              <thead>
                <tr>
                  <th className="desktop-only">{t("account.creditCard.colFacturacionPayBy")}</th>
                  <th className="desktop-only">{t("account.creditCard.colMonthCuotaTotal")}</th>
                  <th className="desktop-only">{t("account.creditCard.colDebtAfterPayment")}</th>
                  <th className="desktop-only">{t("account.creditCard.colMonthBreakdown")}</th>
                  <th className="mobile-only" aria-hidden="true" />
                </tr>
              </thead>
            }
          >
            {ledger.months.length === 0 ? (
              loading ? null : (
                <tr>
                  <td colSpan={5} className="muted">
                    {t("account.creditCard.monthCuotasEmpty")}
                  </td>
                </tr>
              )
            ) : (
              ledger.months.map((row) => {
                return (
                  <tr key={row.month}>
                    <td className="mono desktop-only">
                      {formatYearMonthLabel(row.month)}{" "}
                      <span className="muted">({row.pay_by_date})</span>
                    </td>
                    <td className="mono desktop-only">{formatClp(row.total_clp)}</td>
                    <td className="mono muted desktop-only">{formatClp(row.debt_after_clp)}</td>
                    <td className="desktop-only">
                      {renderMonthCuotasBreakdown(row.breakdown, styles.nestedList)}
                    </td>
                    <td className="mobile-only">
                      <TableMobileCard title={`${formatYearMonthLabel(row.month)} (${row.pay_by_date})`}>
                        <TableMobileCardSection>
                          <TableMobileCardRow
                            label={t("account.creditCard.colMonthCuotaTotal")}
                            value={formatClp(row.total_clp)}
                          />
                          <TableMobileCardRow
                            label={t("account.creditCard.colDebtAfterPayment")}
                            value={<span className="muted">{formatClp(row.debt_after_clp)}</span>}
                          />
                        </TableMobileCardSection>
                        {row.breakdown.length > 0 ? (
                          <TableMobileCardSection>
                            <div className="table-mobile-card__label">
                              {t("account.creditCard.colMonthBreakdown")}
                            </div>
                            {renderMonthCuotasBreakdown(row.breakdown, styles.nestedList)}
                          </TableMobileCardSection>
                        ) : null}
                      </TableMobileCard>
                    </td>
                  </tr>
                );
              })
            )}
          </Table>
        </>
      )}
    </Loadable>
  );
}

export function CreditCardDetailSections(props: Parameters<typeof CreditCardInstallmentsSection>[0]) {
  return <CreditCardInstallmentsSection {...props} />;
}


/**
 * A cuota of the cuotas-por-facturación detail, named as its purchase row names it (name · note ·
 * link ⓘ); a cuota whose purchase the page does not list keeps the bank's text.
 */
function CuotaVendor({
  breakdown,
  purchase,
}: {
  breakdown: CcInstallmentMonthBreakdown;
  purchase: CcInstallmentPurchaseComputed | undefined;
}) {
  if (!purchase) return <span>{breakdown.label}</span>;
  return <ExpenseVendorLabel source={purchaseVendorSource(purchase)} note={purchase.purchase_notes} inline />;
}
