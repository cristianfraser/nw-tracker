import { useMemo } from "react";
import { useTranslation } from "../../i18n";
import { flowPeriodLabel, formatFlowMoney, type FlowChartGranularity } from "../../flowsDisplay";
import type { DisplayUnit } from "../../queries/keys";
import type { FlowIncomeMonthRow } from "../../types";
import { paginateMonthRowsByYear } from "../../incomeAggregates";
import { PaginatedTable } from "../ui/PaginatedTable";

export function IncomeMonthTable({
  rows,
  collapsedVisibleRows = 12,
  displayUnit = "clp",
  periodGranularity = "month",
}: {
  rows: readonly FlowIncomeMonthRow[];
  collapsedVisibleRows?: number;
  displayUnit?: DisplayUnit;
  periodGranularity?: FlowChartGranularity;
}) {
  const { t } = useTranslation();

  const pages = useMemo(() => paginateMonthRowsByYear(rows), [rows]);

  if (rows.length === 0) {
    return <p className="muted">{t("income.emptyMonths")}</p>;
  }

  return (
    <PaginatedTable
      pages={pages}
      collapsedVisibleRows={collapsedVisibleRows}
      showMoreLabel={(hiddenCount) => t("table.showMoreMonths", { count: hiddenCount })}
      showLessLabel={t("table.showLessMonths")}
      tableStyle={{ fontSize: "0.85rem" }}
      getPageLabel={(page) => page.data[0]?.period_month.slice(0, 4) ?? String(page.pageNumber)}
      header={
        <thead>
          <tr>
            <th>{t("accountDetail.monthCloseColumn")}</th>
            <th>{t("income.colMonthCartola")}</th>
            <th>{t("income.colMonthManual")}</th>
            <th>{t("income.colTotal")}</th>
            <th>{t("income.colCumulative")}</th>
            <th>{t("expenses.creditCard.colLineCount")}</th>
          </tr>
        </thead>
      }
      renderBody={(pageRows) => (
        <>
          {pageRows.map((row) => (
            <tr key={row.period_month}>
              <td className="mono">
                {row.as_of_date} ({flowPeriodLabel(row.period_month, periodGranularity)})
              </td>
              <td className="mono">{formatFlowMoney(row.cartola_clp, displayUnit)}</td>
              <td className="mono muted">{formatFlowMoney(row.manual_clp, displayUnit)}</td>
              <td className="mono">{formatFlowMoney(row.total_clp, displayUnit)}</td>
              <td className="mono muted">{formatFlowMoney(row.cumulative_clp, displayUnit)}</td>
              <td className="muted">{row.line_count}</td>
            </tr>
          ))}
        </>
      )}
    />
  );
}
