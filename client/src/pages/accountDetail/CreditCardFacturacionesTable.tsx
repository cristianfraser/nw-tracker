import { useCallback, useMemo, useState } from "react";
import { useDisplayPreferences } from "../../context/DisplayPreferencesContext";
import { useTranslation } from "../../i18n";
import { formatOrDash, formatMoney, formatPct } from "../../format";
import { formatCardBillingPesos } from "../../formatNative";
import { cn } from "../../cn";
import { Loadable } from "../../components/ui/Loadable";
import { Modal } from "../../components/ui/Modal";
import { useModalPeriodNav } from "../../periodModalNav";
import { useFlowsExpenses } from "../../queries/hooks";
import { formatYearMonthLabel } from "../../formatDateLabel";
import type {
  CcFacturacionDto,
  CcPendingCuotaPurchaseDto,
  CcProxyFacturacionAggregate,
} from "../../types";
import { PaginatedTable, useClientPagination } from "../../components/ui/PaginatedTable";
import { Table } from "../../components/ui/Table";
import { Button } from "@crfrsr/ui";
import { CreditCardFacturacionModalSections } from "../../components/credit-card/CreditCardFacturacionModalSections";
import {
  buildFacturacionModalBucket,
  emptyFacturacionModalBucket,
} from "../../components/credit-card/buildFacturacionModalBucket";
import { flowLinesForFacturacionMonth } from "../../components/credit-card/flowLinesForStatementMonth";
import {
  TableMobileCard,
  TableMobileCardRow,
  TableMobileCardSection,
} from "../../components/ui/TableMobileCard";
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
      return f.clp == null || !Number.isFinite(f.clp) ? amount : `${amount} (${formatCardBillingPesos(f.clp)})`;
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
  if (t.blended_return_pct == null) return formatCardBillingPesos(Math.round(t.total_gain_clp));
  const sign = t.total_gain_clp >= 0 ? "+" : "";
  return `${sign}${formatCardBillingPesos(Math.round(t.total_gain_clp))} (${t.blended_return_pct >= 0 ? "+" : ""}${formatPct(t.blended_return_pct, 1)})`;
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
        ≈ {row.close_date}
      </span>
    );
  }
  if (row.close_date_source === "announced") {
    return <span title={t("accountDetail.creditCard.closeDateAnnouncedHint")}>{row.close_date}</span>;
  }
  return <>{row.close_date}</>;
}

/** Pay-by with its provenance: one derived from the close (no statement prints it yet) reads «≈». */
function PayByCell({ row }: { row: CcFacturacionDto }) {
  const { t } = useTranslation();
  if (row.pay_by == null) return <>—</>;
  if (row.pay_by_source === "derived") {
    return (
      <span className="muted" title={t("accountDetail.creditCard.payByDerivedHint")}>
        ≈ {row.pay_by}
      </span>
    );
  }
  return <>{row.pay_by}</>;
}

/** A bare asterisk next to a month closed at the bank whose statement is not imported yet. */
function ProvisionalMark({ row }: { row: CcFacturacionDto }) {
  const { t } = useTranslation();
  if (!row.is_provisional_close) return null;
  const estimate =
    row.provisional_estimate_total_clp != null
      ? ` ${t("accountDetail.creditCard.provisionalEstimateHint", {
          amount: formatCardBillingPesos(row.provisional_estimate_total_clp),
        })}`
      : "";
  return (
    <span className="muted" title={`${t("accountDetail.creditCard.provisionalCloseHint")}${estimate}`}>
      *
    </span>
  );
}

function FacturacionMobileCard({
  row,
  proxy,
  inlineTicker,
  labels,
  onOpen,
}: {
  row: CcFacturacionDto;
  proxy?: CcProxyFacturacionAggregate;
  inlineTicker: string;
  labels: {
    closeDate: string;
    payBy: string;
    facturado: string;
    facturadoUsd: string;
    facturadoTotal: string;
    cuotaAPagar: string;
    deudaEnCuotas: string;
    proxyEarnings: string;
  };
  onOpen: (row: CcFacturacionDto) => void;
}) {
  const title = (
    <>
      <Button variant="link" onClick={() => onOpen(row)}>
        {formatYearMonthLabel(row.billing_month)}
      </Button>
      <ProvisionalMark row={row} />
    </>
  );

  return (
    <TableMobileCard title={title}>
      <TableMobileCardSection>
        <TableMobileCardRow label={labels.closeDate} value={<CloseDateCell row={row} />} />
        <TableMobileCardRow label={labels.payBy} value={<PayByCell row={row} />} />
      </TableMobileCardSection>
      <TableMobileCardSection>
        <TableMobileCardRow
          label={labels.facturado}
          value={formatOrDash(row.facturado_clp, formatCardBillingPesos)}
        />
        <TableMobileCardRow label={labels.facturadoUsd} value={formatFacturadoForeignCell(row)} />
        <TableMobileCardRow
          label={labels.facturadoTotal}
          value={formatOrDash(row.facturado_total_clp, formatCardBillingPesos)}
        />
        <TableMobileCardRow
          label={labels.cuotaAPagar}
          value={formatOrDash(row.cuota_a_pagar_clp, formatCardBillingPesos)}
        />
        <TableMobileCardRow
          label={labels.deudaEnCuotas}
          value={formatOrDash(row.deuda_en_cuotas_clp, formatCardBillingPesos)}
        />
        <TableMobileCardRow
          label={labels.proxyEarnings}
          value={formatProxyCell(proxy, inlineTicker)}
        />
      </TableMobileCardSection>
    </TableMobileCard>
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
              <span className="mono">{formatCardBillingPesos(p.amount_clp)}</span>
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
  const { data: flows, isPending: flowsPending } = useFlowsExpenses(displayUnit);
  const categories = flows?.categories ?? [];
  const [modalOpen, setModalOpen] = useState(false);
  const [selected, setSelected] = useState<CcFacturacionDto | null>(null);

  const proxyByMonth = useMemo(() => {
    const map = new Map<string, CcProxyFacturacionAggregate>();
    for (const agg of facturacionProxy ?? []) map.set(agg.billing_month, agg);
    return map;
  }, [facturacionProxy]);

  const inlineTicker = proxyTickers?.[0] ?? "fintual_cert_reserva2";

  const mobileLabels = {
    closeDate: t("accountDetail.creditCard.colCloseDate"),
    payBy: t("accountDetail.creditCard.colPayBy"),
    facturado: t("account.creditCard.colFacturado"),
    facturadoUsd: t("accountDetail.creditCard.colFacturadoUsd"),
    facturadoTotal: t("accountDetail.creditCard.colFacturadoTotal"),
    cuotaAPagar: t("accountDetail.creditCard.colCuotaAPagar"),
    deudaEnCuotas: t("accountDetail.creditCard.colDeudaEnCuotasFacturacion"),
    proxyEarnings: t("accountDetail.creditCard.colProxyEarnings"),
  };

  const closeModal = useCallback(() => {
    setModalOpen(false);
    setSelected(null);
  }, []);

  const openFacturacion = useCallback((row: CcFacturacionDto) => {
    setSelected(row);
    setModalOpen(true);
  }, []);

  const scopedLines = useMemo(() => {
    if (!selected || !flows) return [];
    return flowLinesForFacturacionMonth(flows.lines, accountId, selected);
  }, [accountId, flows, selected]);

  const facturacionLineCount = useMemo(() => scopedLines.length, [scopedLines]);

  const facturacionBucket = useMemo(() => {
    if (!selected) return emptyFacturacionModalBucket();
    return buildFacturacionModalBucket(scopedLines);
  }, [scopedLines, selected]);

  const modalSubtitle = selected ? (
    <>
      <span className="mono">{selected.billing_month}</span>
      {selected.close_date ? (
        <>
          {" "}
          · {t("accountDetail.creditCard.colCloseDate")}: {selected.close_date}
        </>
      ) : null}
      {selected.pay_by ? (
        <>
          {" "}
          · {t("accountDetail.creditCard.colPayBy")}: {selected.pay_by}
        </>
      ) : null}
      {selected.facturado_total_clp != null ? (
        <> · {t("account.creditCard.colFacturadoTotal")}: {formatOrDash(selected.facturado_total_clp, formatCardBillingPesos)}</>
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

  return (
    <>
      <PendingCuotaPurchasesNotice purchases={pendingCuotaPurchases} openMonth={openMonth} />
      <PaginatedTable
        page={page}
        pageSize={PAGE_SIZE}
        total={total}
        onPageChange={setPage}
      >
        <Table
          tableClassName={cn(styles.tableCompact, "table--parallel-mobile")}
          header={
            <thead>
              <tr>
                <th className="desktop-only">{t("account.creditCard.colBillingMonth")}</th>
                <th className="desktop-only">{t("accountDetail.creditCard.colCloseDate")}</th>
                <th className="desktop-only">{t("accountDetail.creditCard.colPayBy")}</th>
                <th className="desktop-only">{t("account.creditCard.colFacturado")}</th>
                <th className="desktop-only">{t("accountDetail.creditCard.colFacturadoUsd")}</th>
                <th className="desktop-only">{t("account.creditCard.colFacturadoTotal")}</th>
                <th className="desktop-only">{t("accountDetail.creditCard.colCuotaAPagar")}</th>
                <th
                  className="desktop-only"
                  title={t("accountDetail.creditCard.colDeudaEnCuotasFacturacionHint")}
                >
                  {t("accountDetail.creditCard.colDeudaEnCuotasFacturacion")}
                </th>
                <th className="desktop-only" title={t("accountDetail.creditCard.proxyEarningsHint")}>
                  {t("accountDetail.creditCard.colProxyEarnings")}
                </th>
                <th className="mobile-only" aria-hidden="true" />
              </tr>
            </thead>
          }
        >
          {pageRows.map((row) => {
            const proxy = proxyByMonth.get(row.billing_month);
            return (
              <tr key={row.billing_month}>
                <td className={cn("mono", "desktop-only", styles.nowrap)}>
                  <Button variant="link" onClick={() => openFacturacion(row)}>
                    {formatYearMonthLabel(row.billing_month)}
                  </Button>
                  <ProvisionalMark row={row} />
                </td>
                <td className={cn("mono", "desktop-only", styles.nowrap)}>
                  <CloseDateCell row={row} />
                </td>
                <td className={cn("mono", "desktop-only", styles.nowrap)}>
                  <PayByCell row={row} />
                </td>
                <td className="mono desktop-only">{formatOrDash(row.facturado_clp, formatCardBillingPesos)}</td>
                <td className={cn("mono", "desktop-only", styles.nowrap)}>{formatFacturadoForeignCell(row)}</td>
                <td className="mono desktop-only">{formatOrDash(row.facturado_total_clp, formatCardBillingPesos)}</td>
                <td className="mono desktop-only">{formatOrDash(row.cuota_a_pagar_clp, formatCardBillingPesos)}</td>
                <td className="mono desktop-only">{formatOrDash(row.deuda_en_cuotas_clp, formatCardBillingPesos)}</td>
                <td className={cn("mono", "desktop-only", styles.nowrap)}>{formatProxyCell(proxy, inlineTicker)}</td>
                <td className="mobile-only">
                  <FacturacionMobileCard
                    row={row}
                    proxy={proxy}
                    inlineTicker={inlineTicker}
                    labels={mobileLabels}
                    onOpen={openFacturacion}
                  />
                </td>
              </tr>
            );
          })}
        </Table>
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
        {flowsPending ? (
          // The lines are not in yet: an empty dimmed body, never the «no lines» copy.
          <Loadable loading />
        ) : facturacionLineCount === 0 ? (
          <p className="muted">{t("accountDetail.creditCard.facturacionModalEmpty")}</p>
        ) : (
          <CreditCardFacturacionModalSections
            bucket={facturacionBucket}
            categories={categories}
          />
        )}
      </Modal>
    </>
  );
}
