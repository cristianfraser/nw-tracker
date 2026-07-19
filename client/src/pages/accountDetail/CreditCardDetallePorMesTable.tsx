import { useMemo, type ReactNode } from "react";
import { useTranslation } from "../../i18n";
import { formatClp, formatOrDash } from "../../format";
import { formatYmEs } from "./shared";
import { cn } from "../../cn";
import styles from "../AccountDetailPage.module.css";
import type { CcBillingDetailMonthDto } from "../../types";
import { rollupCcBillingDetailYearly } from "../../ccYearlyRollup";
import { useDisplayPreferences } from "../../context/DisplayPreferencesContext";
import { PaginatedTable, pageForFirstMatch, useClientPagination } from "../../components/ui/PaginatedTable";
import { Table } from "../../components/ui/Table";
import {
  TableMobileCard,
  TableMobileCardRow,
  TableMobileCardSection,
} from "../../components/ui/TableMobileCard";

const PAGE_SIZE = 12;

function renderFacturado(row: CcBillingDetailMonthDto, projectedHint: string): ReactNode {
  if (row.total_facturado_clp != null) {
    return formatOrDash(row.total_facturado_clp, formatClp);
  }
  return (
    <span className="muted" title={projectedHint}>
      ≈ {formatClp(row.cuota_a_pagar_next_mes_clp)}
    </span>
  );
}

function periodLabel(row: CcBillingDetailMonthDto, isYearly: boolean): string {
  return isYearly ? row.billing_month.slice(0, 4) : formatYmEs(row.billing_month);
}

function CreditCardDetallePorMesMobileCard({
  row,
  isYearly,
  labels,
}: {
  row: CcBillingDetailMonthDto;
  isYearly: boolean;
  labels: {
    totalFacturado: string;
    cupoEnCuotas: string;
    balanceTotal: string;
    projectedHint: string;
  };
}) {
  const title = (
    <>
      {periodLabel(row, isYearly)}
      {row.as_of_kind === "manual" ? <span className="muted">*</span> : null}
    </>
  );

  return (
    <TableMobileCard title={title}>
      <TableMobileCardSection>
        <TableMobileCardRow
          label={labels.totalFacturado}
          value={renderFacturado(row, labels.projectedHint)}
        />
        <TableMobileCardRow label={labels.cupoEnCuotas} value={formatClp(row.cupo_en_cuotas_clp)} />
        <TableMobileCardRow label={labels.balanceTotal} value={formatClp(row.balance_total_clp)} />
      </TableMobileCardSection>
    </TableMobileCard>
  );
}

export function CreditCardDetallePorMesTable({
  rows,
}: {
  rows: readonly CcBillingDetailMonthDto[];
}) {
  const { t } = useTranslation();
  const { metricsPeriod } = useDisplayPreferences();
  const isYearly = metricsPeriod === "year";

  const projectedHint = isYearly
    ? t("accountDetail.creditCard.colTotalFacturadoProjectedHintYearly")
    : t("accountDetail.creditCard.colTotalFacturadoProjectedHint");
  const mobileLabels = {
    totalFacturado: t("accountDetail.creditCard.colTotalFacturado"),
    cupoEnCuotas: t("accountDetail.creditCard.colCupoEnCuotas"),
    balanceTotal: t("accountDetail.creditCard.colBalanceTotal"),
    projectedHint,
  };

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
      <Table
        tableClassName="table--parallel-mobile"
        header={
          <thead>
            <tr>
              <th className="desktop-only">
                {isYearly ? t("accountDetail.yearColumn") : t("account.creditCard.colBillingMonth")}
              </th>
              <th className="desktop-only">{t("accountDetail.creditCard.colTotalFacturado")}</th>
              <th className="desktop-only">{t("accountDetail.creditCard.colCupoEnCuotas")}</th>
              <th className="desktop-only">{t("accountDetail.creditCard.colBalanceTotal")}</th>
              <th className="mobile-only" aria-hidden="true" />
            </tr>
          </thead>
        }
      >
        {pageRows.map((row) => (
          <tr key={`${row.billing_month}-${row.as_of_date}`}>
            <td className={cn("mono", "desktop-only", styles.nowrap)}>
              {periodLabel(row, isYearly)}
              {row.as_of_kind === "manual" ? <span className="muted">*</span> : null}
            </td>
            <td className="mono desktop-only">{renderFacturado(row, projectedHint)}</td>
            <td className="mono desktop-only">{formatClp(row.cupo_en_cuotas_clp)}</td>
            <td className="mono desktop-only">{formatClp(row.balance_total_clp)}</td>
            <td className="mobile-only">
              <CreditCardDetallePorMesMobileCard row={row} isYearly={isYearly} labels={mobileLabels} />
            </td>
          </tr>
        ))}
      </Table>
    </PaginatedTable>
  );
}
