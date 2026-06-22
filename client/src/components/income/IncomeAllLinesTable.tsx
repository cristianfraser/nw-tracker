import { useMemo } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "../../i18n";
import { formatFlowMoney } from "../../flowsDisplay";
import type { DisplayUnit } from "../../queries/keys";
import type { IncomeDisplayRow } from "../../incomeAggregates";
import {
  incomeCartolaAmount,
  incomeManualAmount,
  paginateRowsByYear,
} from "../../incomeAggregates";
import { PaginatedTable } from "../ui/PaginatedTable";

export function IncomeAllLinesTable({
  rows,
  collapsedVisibleRows = 15,
  displayUnit = "clp",
}: {
  rows: readonly IncomeDisplayRow[];
  collapsedVisibleRows?: number;
  displayUnit?: DisplayUnit;
}) {
  const { t } = useTranslation();

  const pages = useMemo(() => paginateRowsByYear(rows), [rows]);

  if (rows.length === 0) {
    return (
      <p className="muted">
        {t("income.empty")} <span className="mono">{t("income.manualApiHint")}</span>
      </p>
    );
  }

  return (
    <PaginatedTable
      pages={pages}
      collapsedVisibleRows={collapsedVisibleRows}
      showMoreLabel={(hiddenCount) => t("table.showMoreLines", { count: hiddenCount })}
      showLessLabel={t("table.showLess")}
      tableStyle={{ fontSize: "0.85rem" }}
      getPageLabel={(page) => page.data[0]?.received_on.slice(0, 4) ?? String(page.pageNumber)}
      header={
        <thead>
          <tr>
            <th>{t("income.colDate")}</th>
            <th>{t("income.colAmount")}</th>
            <th>{t("income.colDescription")}</th>
            <th>{t("income.colAccount")}</th>
            <th>{t("income.colOrigin")}</th>
          </tr>
        </thead>
      }
      renderBody={(pageRows) => (
        <>
          {pageRows.map((row) => {
            if (row.kind === "checking") {
              return (
                <tr key={`checking-${row.movement_id}`}>
                  <td className="mono">{row.received_on}</td>
                  <td className="mono">
                    {formatFlowMoney(incomeCartolaAmount(row, displayUnit), displayUnit)}
                  </td>
                  <td>{row.description}</td>
                  <td>
                    <Link to={`/account/${row.account_id}`}>{row.account_label}</Link>
                  </td>
                  <td>{t("income.originChecking")}</td>
                </tr>
              );
            }
            return (
              <tr key={`manual-${row.id}`}>
                <td className="mono">{row.received_on}</td>
                <td className="mono">
                  {formatFlowMoney(incomeManualAmount(row, displayUnit), displayUnit)}
                </td>
                <td>{row.source ?? "—"}</td>
                <td className="muted">{row.note ?? "—"}</td>
                <td>{t("income.originManual")}</td>
              </tr>
            );
          })}
        </>
      )}
    />
  );
}
