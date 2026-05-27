import { useMemo } from "react";
import { useTranslation } from "../../i18n";
import { formatClp } from "../../format";
import { formatYmEs } from "./shared";
import type { CcBillingDetailMonthDto } from "../../types";
import { PaginatedTable } from "../../components/ui/PaginatedTable";

export function CreditCardDetallePorMesTable({
  rows,
  collapsedVisibleRows = 12,
}: {
  rows: readonly CcBillingDetailMonthDto[];
  collapsedVisibleRows?: number;
}) {
  const { t } = useTranslation();

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
      getPageLabel={(page) => page.data[0]?.billing_month.slice(0, 4) ?? "—"}
      header={
        <thead>
          <tr>
            <th>{t("account.creditCard.colBillingMonth")}</th>
            <th>{t("accountDetail.creditCard.colTotalFacturado")}</th>
            <th>{t("accountDetail.creditCard.colCupoEnCuotas")}</th>
            <th>{t("accountDetail.creditCard.colBalanceTotal")}</th>
          </tr>
        </thead>
      }
      renderBody={(pageRows) => (
        <>
          {pageRows.map((row) => (
            <tr key={`${row.billing_month}-${row.as_of_date}`}>
              <td className="mono">
                {row.billing_month} ({formatYmEs(row.billing_month)})
                {row.as_of_kind === "manual" ? (
                  <span className="muted"> · {t("accountDetail.creditCard.manualRowNote")}</span>
                ) : null}
              </td>
              <td className="mono">
                {row.total_facturado_clp != null ? formatClp(row.total_facturado_clp) : "—"}
              </td>
              <td className="mono">{formatClp(row.cupo_en_cuotas_clp)}</td>
              <td className="mono">{formatClp(row.balance_total_clp)}</td>
            </tr>
          ))}
        </>
      )}
    />
  );
}
