import { useMemo } from "react";
import { useTranslation } from "../../i18n";
import { formatClp } from "../../format";
import { formatYmEs } from "./shared";
import type { CcBillingDetailMonthDto } from "../../types";
import { PaginatedTable } from "../../components/ui/PaginatedTable";
import {
  TableMobileCard,
  TableMobileCardRow,
  TableMobileCardSection,
} from "../../components/ui/TableMobileCard";

function CreditCardDetallePorMesMobileCard({
  row,
  labels,
}: {
  row: CcBillingDetailMonthDto;
  labels: {
    totalFacturado: string;
    cupoEnCuotas: string;
    balanceTotal: string;
    manualNote: string;
  };
}) {
  const title = (
    <>
      {row.billing_month} ({formatYmEs(row.billing_month)})
      {row.as_of_kind === "manual" ? (
        <span className="muted"> · {labels.manualNote}</span>
      ) : null}
    </>
  );

  return (
    <TableMobileCard title={title}>
      <TableMobileCardSection>
        <TableMobileCardRow
          label={labels.totalFacturado}
          value={row.total_facturado_clp != null ? formatClp(row.total_facturado_clp) : "—"}
        />
        <TableMobileCardRow label={labels.cupoEnCuotas} value={formatClp(row.cupo_en_cuotas_clp)} />
        <TableMobileCardRow label={labels.balanceTotal} value={formatClp(row.balance_total_clp)} />
      </TableMobileCardSection>
    </TableMobileCard>
  );
}

export function CreditCardDetallePorMesTable({
  rows,
  collapsedVisibleRows = 12,
}: {
  rows: readonly CcBillingDetailMonthDto[];
  collapsedVisibleRows?: number;
}) {
  const { t } = useTranslation();

  const mobileLabels = {
    totalFacturado: t("accountDetail.creditCard.colTotalFacturado"),
    cupoEnCuotas: t("accountDetail.creditCard.colCupoEnCuotas"),
    balanceTotal: t("accountDetail.creditCard.colBalanceTotal"),
    manualNote: t("accountDetail.creditCard.manualRowNote"),
  };

  const pages = useMemo(() => {
    const byYear = new Map<string, CcBillingDetailMonthDto[]>();

    for (const row of rows) {
      const year = row.billing_month.slice(0, 4);
      const bucket = byYear.get(year) ?? [];
      bucket.push(row);
      byYear.set(year, bucket);
    }

    const yearsSorted = [...byYear.keys()].sort((a, b) => Number(a) - Number(b));

    return yearsSorted.map((year, pageNumber) => ({
      pageNumber,
      data: byYear.get(year) ?? [],
    }));
  }, [rows]);

  return (
    <PaginatedTable
      pages={pages}
      collapsedVisibleRows={collapsedVisibleRows}
      showMoreLabel={(hiddenCount) => t("table.showMoreMonths", { count: hiddenCount })}
      showLessLabel={t("table.showLessMonths")}
      tableClassName="table--parallel-mobile"
      getPageLabel={(page) => page.data[0]?.billing_month.slice(0, 4) ?? "—"}
      header={
        <thead>
          <tr>
            <th className="desktop-only">{t("account.creditCard.colBillingMonth")}</th>
            <th className="desktop-only">{t("accountDetail.creditCard.colTotalFacturado")}</th>
            <th className="desktop-only">{t("accountDetail.creditCard.colCupoEnCuotas")}</th>
            <th className="desktop-only">{t("accountDetail.creditCard.colBalanceTotal")}</th>
            <th className="mobile-only" aria-hidden="true" />
          </tr>
        </thead>
      }
      renderBody={(pageRows) => (
        <>
          {pageRows.map((row) => (
            <tr key={`${row.billing_month}-${row.as_of_date}`}>
              <td className="mono desktop-only">
                {row.billing_month} ({formatYmEs(row.billing_month)})
                {row.as_of_kind === "manual" ? (
                  <span className="muted"> · {t("accountDetail.creditCard.manualRowNote")}</span>
                ) : null}
              </td>
              <td className="mono desktop-only">
                {row.total_facturado_clp != null ? formatClp(row.total_facturado_clp) : "—"}
              </td>
              <td className="mono desktop-only">{formatClp(row.cupo_en_cuotas_clp)}</td>
              <td className="mono desktop-only">{formatClp(row.balance_total_clp)}</td>
              <td className="mobile-only">
                <CreditCardDetallePorMesMobileCard row={row} labels={mobileLabels} />
              </td>
            </tr>
          ))}
        </>
      )}
    />
  );
}
