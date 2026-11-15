import { useMemo, type ReactNode } from "react";
import { useTranslation } from "../../i18n";
import { formatOrDash } from "../../format";
import { formatCardBillingPesos } from "../../formatNative";
import { formatYearMonthLabel } from "../../formatDateLabel";
import { cn } from "../../cn";
import styles from "../AccountDetailPage.module.css";
import type { CcBillingDetailMonthDto } from "../../types";
import { rollupCcBillingDetailYearly } from "../../ccYearlyRollup";
import { PaginatedTable, pageForFirstMatch, useClientPagination } from "../../components/ui/PaginatedTable";
import { ColumnTable, type TableColumn } from "../../components/ui/ColumnTable";

const PAGE_SIZE = 12;

function renderFacturado(row: CcBillingDetailMonthDto, projectedHint: string): ReactNode {
  if (row.total_facturado_clp != null) {
    return formatOrDash(row.total_facturado_clp, formatCardBillingPesos);
  }
  return (
    <span className="muted" title={projectedHint}>
      ≈ {formatCardBillingPesos(row.cuota_a_pagar_next_mes_clp)}
    </span>
  );
}

/**
 * A bare asterisk on a month closed at the bank whose statement is not imported yet — the same
 * mark the projected rows carry; the hover hint says which it is.
 */
function ProvisionalMark({ row }: { row: CcBillingDetailMonthDto }) {
  const { t } = useTranslation();
  if (!row.provisional) return null;
  return (
    <span className="muted" title={t("accountDetail.creditCard.provisionalCloseHint")}>
      *
    </span>
  );
}

function periodLabel(row: CcBillingDetailMonthDto, isYearly: boolean): string {
  return isYearly ? row.billing_month.slice(0, 4) : formatYearMonthLabel(row.billing_month);
}

export function CreditCardDetallePorMesTable({
  rows,
  period,
}: {
  rows: readonly CcBillingDetailMonthDto[];
  /** The table's own Período control (M/Y — billing detail has no day-grain form). */
  period: "month" | "year";
}) {
  const { t } = useTranslation();
  const isYearly = period === "year";

  const projectedHint = isYearly
    ? t("accountDetail.creditCard.colTotalFacturadoProjectedHintYearly")
    : t("accountDetail.creditCard.colTotalFacturadoProjectedHint");
  const columns: TableColumn<CcBillingDetailMonthDto>[] = [
    {
      key: "period",
      header: isYearly ? t("accountDetail.yearColumn") : t("account.creditCard.colBillingMonth"),
      className: cn("mono", styles.nowrap),
      cell: (row) => (
        <>
          {periodLabel(row, isYearly)}
          {row.as_of_kind === "manual" ? <span className="muted">*</span> : null}
          <ProvisionalMark row={row} />
        </>
      ),
      title: true,
    },
    {
      key: "facturado",
      header: t("accountDetail.creditCard.colTotalFacturado"),
      className: "mono",
      cell: (row) => renderFacturado(row, projectedHint),
    },
    {
      key: "cupo",
      header: t("accountDetail.creditCard.colCupoEnCuotas"),
      className: "mono",
      cell: (row) => formatOrDash(row.cupo_en_cuotas_clp, formatCardBillingPesos),
    },
    {
      key: "balance",
      header: t("accountDetail.creditCard.colBalanceTotal"),
      className: "mono",
      cell: (row) => formatOrDash(row.balance_total_clp, formatCardBillingPesos),
    },
  ];

  const displayRows = useMemo(
    () => (isYearly ? rollupCcBillingDetailYearly(rows) : rows),
    [rows, isYearly]
  );

  const sortedRows = useMemo(
    () => [...displayRows].sort((a, b) => b.billing_month.localeCompare(a.billing_month)),
    [displayRows]
  );

  // Rows are newest-first with future plan projections appended; land on the open/live billing
  // month — the first non-projected row (settled cards have none → page 1). In yearly mode a
  // year row is projected only when plan-only, so the landing row is the current year.
  const defaultPage = useMemo(
    () => pageForFirstMatch(sortedRows, PAGE_SIZE, (r) => !r.projected),
    [sortedRows]
  );

  const { page, setPage, pageRows, total } = useClientPagination(sortedRows, PAGE_SIZE, defaultPage);

  return (
    <PaginatedTable page={page} pageSize={PAGE_SIZE} total={total} onPageChange={setPage}>
      <ColumnTable
        rows={pageRows}
        columns={columns}
        rowKey={(row) => `${row.billing_month}-${row.as_of_date}`}
      />
    </PaginatedTable>
  );
}
