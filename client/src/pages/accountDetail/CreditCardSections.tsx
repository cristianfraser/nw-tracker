import { DEMO_EDITS_LIMITED } from "../../demoEdits";
import { useMemo, useState } from "react";
import { Table } from "../../components/ui/Table";
import { Loadable } from "../../components/ui/Loadable";
import { PageGridTile } from "../../components/layout/PageGridTile";
import { PaginatedTable } from "../../components/ui/PaginatedTable";
import type {
  AccountCcInstallmentsResponse,
  CcInstallmentMonthBreakdown,
  CcInstallmentPurchaseComputed,
} from "../../types";
import { formatCardBillingPesos } from "../../formatNative";
import { cn } from "../../cn";
import { Trans, useTranslation } from "../../i18n";
import { formatYearMonthLabel } from "../../formatDateLabel";
import { CreditCardCuotaProgress } from "./CreditCardCuotaProgress";
import { CreditCardFacturacionesTable } from "./CreditCardFacturacionesTable";
import { CreditCardPurchaseVendor, purchaseVendorSource } from "./CreditCardPurchaseVendor";
import { ExpenseVendorLabel } from "../../components/credit-card/ExpenseVendorLabel";
import {
  ACTIVE_PURCHASE_TABLE_COL_SPAN,
  CreditCardPurchaseMobileCard,
} from "./CreditCardPurchaseMobileCard";
import { TableMobileCardSection } from "../../components/ui/TableMobileCard";
import { ColumnTable, type TableColumn } from "../../components/ui/ColumnTable";
import { useDeleteCcPurchaseMutation } from "../../queries/hooks";
import styles from "../AccountDetailPage.module.css";

function CreditCardInstallmentsSection({
  ledger,
  accountId,
  loading = false,
}: {
  ledger: AccountCcInstallmentsResponse;
  accountId: number;
  /** The ledger is a placeholder or held prior data: the section keeps its frame, dimmed, with no «empty» copy. */
  loading?: boolean;
}) {
  const { t } = useTranslation();
  const deletePurchase = useDeleteCcPurchaseMutation({ accountId });
  const m = ledger.meta;
  const hasData =
    ledger.has_installment_ledger ||
    ledger.has_imported_statements ||
    ledger.purchases.length > 0 ||
    ledger.purchases_completed.length > 0;
  // A placeholder ledger (loading, nothing in it) states no installment ledger yet: frame the
  // ledger layout, not the legacy columns.
  const hasLedger = ledger.has_installment_ledger || (loading && !hasData);
  const facturaciones = ledger.facturaciones ?? [];
  const manualBusy = deletePurchase.isPending;
  const purchasesCompleted = ledger.purchases_completed;

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
              amount: formatCardBillingPesos(b.amount),
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
    !DEMO_EDITS_LIMITED && hasLedger && p.origin === "manual" && p.purchase_db_id != null
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
  // lines read) on the left, the progress bar on the right (the table shows its cards when the two do not fit), and on
  // mobile the card stacks the same pieces.
  const renderActivePurchaseRows = (rows: ReadonlyArray<CcInstallmentPurchaseComputed>) =>
    rows.map((p) => (
      <tr key={p.purchase_id} className={styles.activePurchaseRow}>
        <td className="desktop-only">
          <div className="mono">
            {p.purchase_date ?? "—"}
            {p.cuota_progress ? null : ` · ${formatCardBillingPesos(p.cuota)}`}
          </div>
          {purchaseVendor(p)}
        </td>
        <td className="desktop-only">
          {p.cuota_progress ? (
            <CreditCardCuotaProgress
              progress={p.cuota_progress}
              cuotaClp={p.cuota}
              maxInstallments={maxActiveInstallments}
            />
          ) : null}
        </td>
        <td className="mobile-only">
          <CreditCardPurchaseMobileCard
            purchase={p}
            accountId={accountId}
            manualBusy={manualBusy}
            onDeleteManual={deleteManual(p)}
            maxInstallments={maxActiveInstallments}
          />
        </td>
      </tr>
    ));

  const completedColumns: TableColumn<CcInstallmentPurchaseComputed>[] = [
    { key: "purchase", header: t("account.creditCard.colPurchase"), cell: purchaseVendor, title: true },
    {
      key: "installments",
      header: t("account.creditCard.colInstallments"),
      className: "mono",
      cell: (p) => p.installment_count,
      card: (p) => String(p.installment_count),
    },
    {
      key: "principal",
      header: t("account.creditCard.colPrincipal"),
      className: "mono",
      cell: (p) => formatCardBillingPesos(p.principal),
    },
    {
      key: "purchaseDate",
      header: t("account.creditCard.colPurchaseDate"),
      className: "mono",
      section: 1,
      cell: (p) => p.purchase_date ?? "—",
    },
    {
      key: "billingMonth",
      header: t("account.creditCard.colPurchaseBillingMonth"),
      className: "mono",
      section: 1,
      cell: (p) => p.purchase_billing_month ?? p.purchase_month ?? "—",
    },
    // The card lists the cuota last, in a section of its own (after the last paid month).
    {
      key: "cuota",
      header: t("account.creditCard.colCuotaClp"),
      className: "mono",
      section: 2,
      cell: (p) => formatCardBillingPesos(p.cuota),
    },
    {
      key: "lastPaid",
      header: t("account.creditCard.colLastPaid"),
      className: "mono",
      section: 1,
      cell: (p) => (p.last_paid_month ? formatYearMonthLabel(p.last_paid_month) : "—"),
    },
  ];

  type MonthRow = (typeof ledger.months)[number];
  const monthColumns: TableColumn<MonthRow>[] = [
    {
      key: "month",
      header: t("account.creditCard.colFacturacionPayBy"),
      className: "mono",
      cell: (row) => (
        <>
          {formatYearMonthLabel(row.month)} <span className="muted">({row.pay_by_date})</span>
        </>
      ),
      title: (row) => `${formatYearMonthLabel(row.month)} (${row.pay_by_date})`,
    },
    {
      key: "total",
      header: t("account.creditCard.colMonthCuotaTotal"),
      className: "mono",
      cell: (row) => formatCardBillingPesos(row.total),
    },
    {
      key: "debtAfter",
      header: t("account.creditCard.colDebtAfterPayment"),
      className: "mono muted",
      cardClassName: "muted",
      cell: (row) => formatCardBillingPesos(row.debt_after),
    },
    // On the card the breakdown is a section of its own under a bare label (`cardTail`), and
    // only when the month has cuotas.
    {
      key: "breakdown",
      header: t("account.creditCard.colMonthBreakdown"),
      cell: (row) => renderMonthCuotasBreakdown(row.breakdown, styles.nestedList),
      desktopOnly: true,
    },
  ];

  const COMPLETED_PAGE_SIZE = 10;
  const [completedPage, setCompletedPage] = useState(1);

  const completedPageRows = useMemo(() => {
    const start = (completedPage - 1) * COMPLETED_PAGE_SIZE;
    return purchasesCompletedSorted.slice(start, start + COMPLETED_PAGE_SIZE);
  }, [purchasesCompletedSorted, completedPage]);

  // A page grid of its own (styles/page-grid.css): the summary and each table are tiles, so the
  // row gap is the only space between them; one dim marker for the whole section.
  return (
    <Loadable loading={loading} className="page-grid">
      <PageGridTile id="cc-installments">
        <h2>{t("account.creditCard.installmentsTitle")}</h2>
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
            ) : null}
          </p>
        ) : null}
        {!hasData && !loading ? (
          <p className="muted">{t("account.creditCard.installmentsEmpty")}</p>
        ) : (
          <div className="cards">
            <div className="card">
              <div className="label">{t("account.creditCard.totalRemainingLabel")}</div>
              <div className="value mono">{formatCardBillingPesos(ledger.totals.total_remaining_principal)}</div>
            </div>
            <div className="card">
              <div className="label">{t("account.creditCard.nextMonthWithCharges")}</div>
              <div className={cn("value", "mono", styles.cardValueSecondary)}>
                {ledger.totals.next_calendar_month
                  ? `${formatYearMonthLabel(ledger.totals.next_calendar_month)} · ${formatCardBillingPesos(ledger.totals.next_calendar_month_total ?? 0)}`
                  : "—"}
              </div>
            </div>
          </div>
        )}
      </PageGridTile>
      {!hasData && !loading ? null : (
        <>
          {(ledger.has_installment_ledger && facturaciones.length > 0) || loading ? (
            <PageGridTile id="cc-facturaciones">
              <h3>{t("accountDetail.creditCard.facturacionesTitle")}</h3>
              <CreditCardFacturacionesTable
                rows={facturaciones}
                accountId={accountId}
                facturacionProxy={ledger.facturacion_proxy}
                proxyTickers={ledger.proxy_tickers}
                pendingCuotaPurchases={ledger.pending_cuota_purchases}
              />
            </PageGridTile>
          ) : null}

          <PageGridTile id="cc-active-purchases">
            <h3>{t("account.creditCard.activePurchasesTitle")}</h3>
            <Table
              tableClassName={cn(styles.tableCompact, "table--parallel-mobile")}
              header={activePurchaseTableHeader}
            >
              {ledger.purchases.length === 0 ? (
                loading ? null : (
                  <tr>
                    <td colSpan={ACTIVE_PURCHASE_TABLE_COL_SPAN} className="muted">
                      {t("account.creditCard.activePurchasesEmpty")}
                    </td>
                  </tr>
                )
              ) : (
                renderActivePurchaseRows(purchasesActiveSorted)
              )}
            </Table>
          </PageGridTile>

          <PageGridTile id="cc-completed-purchases">
            <h3>{t("account.creditCard.completedPurchasesTitle")}</h3>
            <PaginatedTable
              key={`cc-completed-${accountId}`}
              page={completedPage}
              pageSize={COMPLETED_PAGE_SIZE}
              total={purchasesCompletedSorted.length}
              onPageChange={setCompletedPage}
            >
              <ColumnTable
                rows={completedPageRows}
                columns={completedColumns}
                rowKey={(p) => p.purchase_id}
                tableClassName={styles.tableCompact}
                emptyLabel={t("account.creditCard.completedPurchasesEmpty")}
                loading={loading}
              />
            </PaginatedTable>
          </PageGridTile>

          <PageGridTile id="cc-month-cuotas">
            <h3>{t("account.creditCard.monthCuotasTitle")}</h3>
            <ColumnTable
              rows={ledger.months}
              columns={monthColumns}
              rowKey={(row) => row.month}
              tableClassName={styles.tableCompact}
              emptyLabel={t("account.creditCard.monthCuotasEmpty")}
              loading={loading}
              cardTail={(row) =>
                row.breakdown.length > 0 ? (
                  <TableMobileCardSection>
                    <div className="table-mobile-card__label">{t("account.creditCard.colMonthBreakdown")}</div>
                    {renderMonthCuotasBreakdown(row.breakdown, styles.nestedList)}
                  </TableMobileCardSection>
                ) : null
              }
            />
          </PageGridTile>
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
