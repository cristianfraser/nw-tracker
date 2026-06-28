import { useMemo } from "react";
import { useTranslation } from "../../i18n";
import { flowPeriodLabel, formatFlowMoney, type FlowChartGranularity } from "../../flowsDisplay";
import type { DisplayUnit } from "../../queries/keys";
import type { FlowIncomeMonthRow } from "../../types";
import { PaginatedTable, useClientPagination } from "../ui/PaginatedTable";
import { Table } from "../ui/Table";

const PAGE_SIZE = 12;

export function IncomeMonthTable({
  rows,
  displayUnit = "clp",
  periodGranularity = "month",
}: {
  rows: readonly FlowIncomeMonthRow[];
  displayUnit?: DisplayUnit;
  periodGranularity?: FlowChartGranularity;
}) {
  const { t } = useTranslation();

  const sortedRows = useMemo(
    () => [...rows].sort((a, b) => b.period_month.localeCompare(a.period_month)),
    [rows]
  );

  const { page, setPage, pageRows, total } = useClientPagination(sortedRows, PAGE_SIZE);

  if (rows.length === 0) {
    return <p className="muted">{t("income.emptyMonths")}</p>;
  }

  return (
    <PaginatedTable page={page} pageSize={PAGE_SIZE} total={total} onPageChange={setPage}>
      <Table
        header={
          <thead>
            <tr>
              <th>{t("accountDetail.monthCloseColumn")}</th>
              <th>{t("income.chart.salary")}</th>
              <th>{t("income.chart.severance")}</th>
              <th>{t("income.chart.parent_gift")}</th>
              <th>{t("income.chart.other")}</th>
              <th>{t("income.colTotal")}</th>
              <th>{t("income.colCumulative")}</th>
              <th>{t("expenses.creditCard.colLineCount")}</th>
            </tr>
          </thead>
        }
        tableStyle={{ fontSize: "0.85rem" }}
      >
        {pageRows.map((row) => (
          <tr key={row.period_month}>
            <td className="mono">
              {row.as_of_date} ({flowPeriodLabel(row.period_month, periodGranularity)})
            </td>
            <td className="mono">{formatFlowMoney(row.salary_clp, displayUnit)}</td>
            <td className="mono muted">{formatFlowMoney(row.severance_clp, displayUnit)}</td>
            <td className="mono muted">{formatFlowMoney(row.parent_gift_clp, displayUnit)}</td>
            <td className="mono muted">{formatFlowMoney(row.other_clp, displayUnit)}</td>
            <td className="mono">{formatFlowMoney(row.total_clp, displayUnit)}</td>
            <td className="mono muted">{formatFlowMoney(row.cumulative_clp, displayUnit)}</td>
            <td className="muted">{row.line_count}</td>
          </tr>
        ))}
      </Table>
    </PaginatedTable>
  );
}
