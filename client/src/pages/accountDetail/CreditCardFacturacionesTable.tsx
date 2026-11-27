import { useCallback, useMemo, useState } from "react";
import { useDisplayPreferences } from "../../context/DisplayPreferencesContext";
import { useTranslation } from "../../i18n";
import { formatOrDash, formatMoney, formatPct } from "../../format";
import { formatCardBillingPesos } from "../../formatNative";
import { cn } from "../../cn";
import { Loadable } from "../../components/ui/Loadable";
import { Modal } from "../../components/ui/Modal";
import { useModalPeriodNav } from "../../periodModalNav";
import { useHeldFlowsExpenseLines } from "../../queries/hooks";
import { formatYearMonthLabel } from "../../formatDateLabel";
import type {
  CcFacturacionDto,
  CcPendingCuotaPurchaseDto,
  CcProxyFacturacionAggregate,
} from "../../types";
import { PaginatedTable, useClientPagination } from "../../components/ui/PaginatedTable";
import { ColumnTable, type TableColumn } from "../../components/ui/ColumnTable";
import { Button } from "@crfrsr/ui";
import { CreditCardFacturacionModalSections } from "../../components/credit-card/CreditCardFacturacionModalSections";
import { ExpenseLinesUnitScope } from "../../components/credit-card/CreditCardExpenseLinesTable";
import {
  buildFacturacionModalBucket,
  emptyFacturacionModalBucket,
} from "../../components/credit-card/buildFacturacionModalBucket";
import styles from "../AccountDetailPage.module.css";

/**
 * «US$ X ($Y)» — each foreign currency the facturación billed with its CLP equivalent, in one cell
 * (desktop column and mobile row alike); «—» when it billed in none.
 */
function formatFacturadoForeignCell(row: CcFacturacionDto): string {
  const parts = row.facturado_foreign
    .filter((f) => f.amount != null && Number.isFinite(f.amount))
    .map((f) => {
      const amount = formatMoney({ value: f.amount!, currency: f.currency });
      return f.billing_amount == null || !Number.isFinite(f.billing_amount) ? amount : `${amount} (${formatCardBillingPesos(f.billing_amount)})`;
    });
  return parts.length > 0 ? parts.join(" · ") : "—";
}

function formatProxyCell(
  proxy: CcProxyFacturacionAggregate | undefined,
  inlineTicker: string
): string {
  // «—» only without a proxy at all; a facturación that floated nothing reads a bare «$0».
  if (!proxy) return "—";
  const t = proxy.by_ticker[inlineTicker];
  if (!t) return "—";
  if (t.blended_return_pct == null) return formatCardBillingPesos(Math.round(t.total_gain));
  const sign = t.total_gain >= 0 ? "+" : "";
  return `${sign}${formatCardBillingPesos(Math.round(t.total_gain))} (${t.blended_return_pct >= 0 ? "+" : ""}${formatPct(t.blended_return_pct, 1)})`;
}

/**
 * Close date with its provenance: an estimated close reads «≈», a close announced
 * by the previous statement carries a hint; a statement or feed close is plain.
 */
function CloseDateCell({ row }: { row: CcFacturacionDto }) {
  const { t } = useTranslation();
  if (row.close_date_source === "estimated") {
    return (
      <span className="muted" title={t("accountDetail.creditCard.closeDateEstimatedHint")}>
        ≈ {row.close_date_iso}
      </span>
    );
  }
  if (row.close_date_source === "announced") {
    return <span title={t("accountDetail.creditCard.closeDateAnnouncedHint")}>{row.close_date_iso}</span>;
  }
  return <>{row.close_date_iso}</>;
}

/** Pay-by with its provenance: one derived from the close (no statement prints it yet) reads «≈». */
function PayByCell({ row }: { row: CcFacturacionDto }) {
  const { t } = useTranslation();
  if (row.pay_by_iso == null) return <>—</>;
  if (row.pay_by_source === "derived") {
    return (
      <span className="muted" title={t("accountDetail.creditCard.payByDerivedHint")}>
        ≈ {row.pay_by_iso}
      </span>
    );
  }
  return <>{row.pay_by_iso}</>;
}

/** A bare asterisk next to a month closed at the bank whose statement is not imported yet. */
function ProvisionalMark({ row }: { row: CcFacturacionDto }) {
  const { t } = useTranslation();
  if (!row.is_provisional_close) return null;
  const estimate =
    row.provisional_estimate_total != null
      ? ` ${t("accountDetail.creditCard.provisionalEstimateHint", {
          amount: formatCardBillingPesos(row.provisional_estimate_total),
        })}`
      : "";
  return (
    <span className="muted" title={`${t("accountDetail.creditCard.provisionalCloseHint")}${estimate}`}>
      *
    </span>
  );
}

const PAGE_SIZE = 12;

const billingMonthKeyOf = (row: CcFacturacionDto) => row.billing_month;

/**
 * Feed-typed cuota purchases whose count is not known yet: until it is, the app carries each one as
 * installment debt for its full amount. Each opens its facturación's modal, where the line offers
 * «¿cuántas cuotas?» (the ordinary line → plan conversion).
 */
function PendingCuotaPurchasesNotice({
  purchases,
  openMonth,
}: {
  purchases: readonly CcPendingCuotaPurchaseDto[];
  /** Opens the facturación modal for a month; null when the month has no facturación row. */
  openMonth: (billingMonth: string) => (() => void) | null;
}) {
  const { t } = useTranslation();
  if (purchases.length === 0) return null;
  return (
    <div className={cn("card", styles.pendingCuotaNotice)} role="status">
      <div className="label">{t("accountDetail.creditCard.pendingCuotaPurchasesTitle")}</div>
      <p className={cn("muted", styles.proseSmTight)}>{t("accountDetail.creditCard.pendingCuotaPurchasesHint")}</p>
      <ul className={styles.pendingCuotaList}>
        {purchases.map((p) => {
          const open = openMonth(p.billing_month);
          return (
            <li key={p.statement_line_id}>
              <span className="mono">{p.purchase_date}</span> · {p.merchant ?? "—"} ·{" "}
              <span className="mono">{formatCardBillingPesos(p.amount)}</span>
              {open ? (
                <>
                  {" "}
                  <Button variant="link" onClick={open}>
                    {t("accountDetail.creditCard.pendingCuotaPurchasesAction")}
                  </Button>
                </>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export function CreditCardFacturacionesTable({
  rows,
  accountId,
  facturacionProxy,
  proxyTickers,
  pendingCuotaPurchases = [],
}: {
  rows: readonly CcFacturacionDto[];
  accountId: number;
  facturacionProxy?: readonly CcProxyFacturacionAggregate[];
  proxyTickers?: readonly string[];
  pendingCuotaPurchases?: readonly CcPendingCuotaPurchaseDto[];
}) {
  const { t } = useTranslation();
  const { displayUnit } = useDisplayPreferences();
  const [modalOpen, setModalOpen] = useState(false);
  const [selected, setSelected] = useState<CcFacturacionDto | null>(null);
  // The facturación's lines (the server's rule for which lines a facturación lists), while open.
  const facturacionLines = useHeldFlowsExpenseLines(
    displayUnit,
    selected ? { kind: "facturacion", account_id: accountId, billing_month: selected.billing_month } : null,
    modalOpen
  );
  const flows = facturacionLines.data;
  const flowsPending = selected != null && flows == null && !facturacionLines.error;
  // Held across a unit switch while open (dimmed, in its own unit).
  const flowsHeld = facturacionLines.loading && flows != null;
  const categories = flows?.categories ?? [];

  const proxyByMonth = useMemo(() => {
    const map = new Map<string, CcProxyFacturacionAggregate>();
    for (const agg of facturacionProxy ?? []) map.set(agg.billing_month, agg);
    return map;
  }, [facturacionProxy]);

  const inlineTicker = proxyTickers?.[0] ?? "fintual_cert_reserva2";

  const closeModal = useCallback(() => {
    setModalOpen(false);
    setSelected(null);
  }, []);

  const openFacturacion = useCallback((row: CcFacturacionDto) => {
    setSelected(row);
    setModalOpen(true);
  }, []);

  const scopedLines = useMemo(() => (selected && flows ? flows.lines : []), [flows, selected]);

  const facturacionLineCount = useMemo(() => scopedLines.length, [scopedLines]);

  const facturacionBucket = useMemo(() => {
    if (!selected) return emptyFacturacionModalBucket();
    return buildFacturacionModalBucket(scopedLines);
  }, [scopedLines, selected]);

  const modalSubtitle = selected ? (
    <>
      <span className="mono">{selected.billing_month}</span>
      {selected.close_date_iso ? (
        <>
          {" "}
          · {t("accountDetail.creditCard.colCloseDate")}: {selected.close_date_iso}
        </>
      ) : null}
      {selected.pay_by_iso ? (
        <>
          {" "}
          · {t("accountDetail.creditCard.colPayBy")}: {selected.pay_by_iso}
        </>
      ) : null}
      {selected.facturado_total != null ? (
        <> · {t("account.creditCard.colFacturadoTotal")}: {formatOrDash(selected.facturado_total, formatCardBillingPesos)}</>
      ) : null}
    </>
  ) : null;

  const sortedRows = useMemo(
    () => [...rows].sort((a, b) => b.billing_month.localeCompare(a.billing_month)),
    [rows]
  );

  const { page, setPage, pageRows, total } = useClientPagination(sortedRows, PAGE_SIZE);

  const titleNav = useModalPeriodNav({
    rows: sortedRows,
    selectedKey: selected?.billing_month ?? null,
    keyOf: billingMonthKeyOf,
    onSelect: setSelected,
    labels: { prev: t("common.modalPrevPeriod"), next: t("common.modalNextPeriod") },
  });

  const openMonth = useCallback(
    (billingMonth: string) => {
      const row = rows.find((r) => r.billing_month === billingMonth);
      return row ? () => openFacturacion(row) : null;
    },
    [rows, openFacturacion]
  );

  const pesos = (
    key: string,
    header: string,
    value: (row: CcFacturacionDto) => number | null,
    extra: Partial<TableColumn<CcFacturacionDto>> = {}
  ): TableColumn<CcFacturacionDto> => ({
    key,
    header,
    className: "mono",
    section: 1,
    cell: (row) => formatOrDash(value(row), formatCardBillingPesos),
    ...extra,
  });
  const nowrapMono = cn("mono", styles.nowrap);
  const columns: TableColumn<CcFacturacionDto>[] = [
    {
      key: "month",
      header: t("account.creditCard.colBillingMonth"),
      className: nowrapMono,
      cell: (row) => (
        <>
          <Button variant="link" onClick={() => openFacturacion(row)}>
            {formatYearMonthLabel(row.billing_month)}
          </Button>
          <ProvisionalMark row={row} />
        </>
      ),
      title: true,
    },
    {
      key: "close",
      header: t("accountDetail.creditCard.colCloseDate"),
      className: nowrapMono,
      cell: (row) => <CloseDateCell row={row} />,
    },
    {
      key: "payBy",
      header: t("accountDetail.creditCard.colPayBy"),
      className: nowrapMono,
      cell: (row) => <PayByCell row={row} />,
    },
    pesos("facturado", t("account.creditCard.colFacturado"), (row) => row.facturado),
    {
      key: "facturadoForeign",
      header: t("accountDetail.creditCard.colFacturadoUsd"),
      className: nowrapMono,
      section: 1,
      cell: formatFacturadoForeignCell,
    },
    pesos("facturadoTotal", t("account.creditCard.colFacturadoTotal"), (row) => row.facturado_total, {
      // The card has always read the page's own key (same copy as the header's).
      label: t("accountDetail.creditCard.colFacturadoTotal"),
    }),
    pesos("cuotaAPagar", t("accountDetail.creditCard.colCuotaAPagar"), (row) => row.cuota_a_pagar),
    pesos(
      "deudaEnCuotas",
      t("accountDetail.creditCard.colDeudaEnCuotasFacturacion"),
      (row) => row.deuda_en_cuotas,
      { headerProps: { title: t("accountDetail.creditCard.colDeudaEnCuotasFacturacionHint") } }
    ),
    {
      key: "proxy",
      header: t("accountDetail.creditCard.colProxyEarnings"),
      headerProps: { title: t("accountDetail.creditCard.proxyEarningsHint") },
      className: nowrapMono,
      section: 1,
      cell: (row) => formatProxyCell(proxyByMonth.get(row.billing_month), inlineTicker),
    },
  ];

  return (
    <>
      <PendingCuotaPurchasesNotice purchases={pendingCuotaPurchases} openMonth={openMonth} />
      <PaginatedTable
        page={page}
        pageSize={PAGE_SIZE}
        total={total}
        onPageChange={setPage}
      >
        <ColumnTable
          rows={pageRows}
          columns={columns}
          rowKey={(row) => row.billing_month}
          tableClassName={styles.tableCompact}
        />
      </PaginatedTable>

      <Modal
        open={modalOpen}
        onClose={closeModal}
        closeAriaLabel={t("accountDetail.creditCard.facturacionModalClose")}
        titleNav={titleNav}
        title={
          selected
            ? t("accountDetail.creditCard.facturacionModalTitle", {
                month: formatYearMonthLabel(selected.billing_month),
              })
            : ""
        }
        subtitle={modalSubtitle}
      >
        {facturacionLines.error ? (
          <p className="error">{t("common.loadFailed")}</p>
        ) : flowsPending ? (
          // The lines are not in yet: an empty dimmed body, never the «no lines» copy.
          <Loadable loading />
        ) : facturacionLineCount === 0 ? (
          <p className="muted">{t("accountDetail.creditCard.facturacionModalEmpty")}</p>
        ) : (
          <Loadable loading={flowsHeld}>
            <ExpenseLinesUnitScope unit={flows?.unit}>
              <CreditCardFacturacionModalSections bucket={facturacionBucket} categories={categories} />
            </ExpenseLinesUnitScope>
          </Loadable>
        )}
      </Modal>
    </>
  );
}
