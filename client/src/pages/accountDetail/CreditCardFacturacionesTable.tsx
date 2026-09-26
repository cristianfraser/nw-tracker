import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "../../i18n";
import { formatClp, formatOrDash, formatPct, formatUsdFine } from "../../format";
import { cn } from "../../cn";
import { Modal } from "../../components/ui/Modal";
import { useModalPeriodNav } from "../../periodModalNav";
import { useFlowsCreditCardExpenses } from "../../queries/hooks";
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
import type { DisplayUnit } from "../../queries/keys";
import {
  TableMobileCard,
  TableMobileCardRow,
  TableMobileCardSection,
} from "../../components/ui/TableMobileCard";
import styles from "../AccountDetailPage.module.css";

function fmtUsd(n: number | null | undefined) {
  if (n == null || !Number.isFinite(n)) return "—";
  return formatUsdFine(n);
}

/** «US$ X ($Y)» — the USD facturado with its CLP equivalent in one cell. */
function formatFacturadoUsdCell(row: CcFacturacionDto): string {
  const usd = fmtUsd(row.facturado_usd);
  if (row.facturado_usd_clp == null || !Number.isFinite(row.facturado_usd_clp)) return usd;
  return `${usd} (${formatClp(row.facturado_usd_clp)})`;
}

function formatProxyCell(
  proxy: CcProxyFacturacionAggregate | undefined,
  inlineTicker: string
): string {
  if (!proxy) return "—";
  const t = proxy.by_ticker[inlineTicker];
  if (!t) return "—";
  const sign = t.total_gain_clp >= 0 ? "+" : "";
  return `${sign}${formatClp(Math.round(t.total_gain_clp))} (${t.blended_return_pct >= 0 ? "+" : ""}${formatPct(t.blended_return_pct, 1)})`;
}

/**
 * Close date with its provenance: an estimate from the config cycle reads «≈», a close announced
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

/** «provisoria» next to a month closed at the bank whose statement is not imported yet. */
function ProvisionalMark({ row }: { row: CcFacturacionDto }) {
  const { t } = useTranslation();
  if (!row.is_provisional_close) return null;
  const estimate =
    row.provisional_estimate_total_clp != null
      ? ` ${t("accountDetail.creditCard.provisionalEstimateHint", {
          amount: formatClp(row.provisional_estimate_total_clp),
        })}`
      : "";
  return (
    <span className="muted" title={`${t("accountDetail.creditCard.provisionalCloseHint")}${estimate}`}>
      {" "}
      {t("accountDetail.creditCard.provisionalClose")}
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
        <TableMobileCardRow label={labels.payBy} value={row.pay_by ?? "—"} />
      </TableMobileCardSection>
      <TableMobileCardSection>
        <TableMobileCardRow
          label={labels.facturado}
          value={formatOrDash(row.facturado_clp, formatClp)}
        />
        <TableMobileCardRow label={labels.facturadoUsd} value={formatFacturadoUsdCell(row)} />
        <TableMobileCardRow
          label={labels.facturadoTotal}
          value={formatOrDash(row.facturado_total_clp, formatClp)}
        />
        <TableMobileCardRow
          label={labels.cuotaAPagar}
          value={formatOrDash(row.cuota_a_pagar_clp, formatClp)}
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
              <span className="mono">{formatClp(p.amount_clp)}</span>
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
  displayUnit,
  facturacionProxy,
  proxyTickers,
  pendingCuotaPurchases = [],
}: {
  rows: readonly CcFacturacionDto[];
  accountId: number;
  displayUnit: DisplayUnit;
  facturacionProxy?: readonly CcProxyFacturacionAggregate[];
  proxyTickers?: readonly string[];
  pendingCuotaPurchases?: readonly CcPendingCuotaPurchaseDto[];
}) {
  const { t } = useTranslation();
  const { data: flows } = useFlowsCreditCardExpenses();
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

  // Web-paste / card-feed lines are the only ones the server lets the modal delete.
  const deletableLineIds = useMemo(
    () => new Set(scopedLines.filter((ln) => ln.web_paste).map((ln) => ln.statement_line_id)),
    [scopedLines]
  );

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
        <> · {t("account.creditCard.colFacturadoTotal")}: {formatOrDash(selected.facturado_total_clp, formatClp)}</>
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
        wrapClassName={styles.tableWrapSpaced}
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
                <td className={cn("mono", "desktop-only", styles.nowrap)}>{row.pay_by ?? "—"}</td>
                <td className="mono desktop-only">{formatOrDash(row.facturado_clp, formatClp)}</td>
                <td className={cn("mono", "desktop-only", styles.nowrap)}>{formatFacturadoUsdCell(row)}</td>
                <td className="mono desktop-only">{formatOrDash(row.facturado_total_clp, formatClp)}</td>
                <td className="mono desktop-only">{formatOrDash(row.cuota_a_pagar_clp, formatClp)}</td>
                <td className="mono desktop-only">{formatProxyCell(proxy, inlineTicker)}</td>
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
        {facturacionLineCount === 0 ? (
          <p className="muted">{t("accountDetail.creditCard.facturacionModalEmpty")}</p>
        ) : (
          <CreditCardFacturacionModalSections
            bucket={facturacionBucket}
            categories={categories}
            accountId={accountId}
            displayUnit={displayUnit}
            deletableLineIds={deletableLineIds}
          />
        )}
      </Modal>
    </>
  );
}
