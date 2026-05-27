import { useMemo } from "react";
import { useTranslation } from "../../i18n";
import {
  accountFlowsShowTickerColumn,
  accountFlowsShowUsdColumn,
  type AccountFlowsTableRow,
} from "../../accountFlows";
import { formatClp, formatInstrumentUnits, formatUsdFine } from "../../format";
import { PaginatedTable } from "../ui/PaginatedTable";

export function AccountFlowsTable({
  rows,
  collapsedVisibleRows = 10,
  showAccountColumn = false,
  showUnitsColumn = true,
  movementUnitsKind,
  emptyMessage,
  filteredEmptyMessage,
  totalCount,
}: {
  rows: readonly AccountFlowsTableRow[];
  collapsedVisibleRows?: number;
  showAccountColumn?: boolean;
  /** Off for consolidated group tables (mixed instruments). */
  showUnitsColumn?: boolean;
  movementUnitsKind?: (slug: string) => "shares" | "coin";
  emptyMessage?: string;
  filteredEmptyMessage?: string;
  totalCount?: number;
}) {
  const { t } = useTranslation();
  const showFlowTickerCol = accountFlowsShowTickerColumn(rows);
  const showFlowUsdCol = accountFlowsShowUsdColumn(rows);
  const allCount = totalCount ?? rows.length;

  const pages = useMemo(() => {
    if (rows.length === 0) return [];

    const byYear = new Map<string, AccountFlowsTableRow[]>();
    for (const row of rows) {
      const year = row.occurred_on.slice(0, 4);
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
      showMoreLabel={(hiddenCount) => t("table.showMoreFlows", { count: hiddenCount })}
      showLessLabel={t("table.showLessFlows")}
      getPageLabel={(page) => page.data[0]?.occurred_on.slice(0, 4) ?? "—"}
      header={
        <thead>
          <tr>
            {showAccountColumn ? <th>{t("groupPage.flowsAccountColumn")}</th> : null}
            <th>{t("accountDetail.flowTypeColumn")}</th>
            <th>{t("accountDetail.flowDateColumn")}</th>
            {showFlowTickerCol ? <th>{t("accountDetail.flowTickerColumn")}</th> : null}
            <th>{t("accountDetail.flowAmountClpColumn")}</th>
            {showFlowUsdCol ? <th>{t("accountDetail.flowAmountUsdColumn")}</th> : null}
            {showUnitsColumn ? <th>{t("accountDetail.flowUnitsColumn")}</th> : null}
            <th>{t("accountDetail.flowNoteColumn")}</th>
          </tr>
        </thead>
      }
      renderBody={(pageRows) =>
        pageRows.length === 0 ? (
          <tr>
            <td
              colSpan={
                4 +
                (showAccountColumn ? 1 : 0) +
                (showFlowTickerCol ? 1 : 0) +
                (showFlowUsdCol ? 1 : 0) +
                (showUnitsColumn ? 1 : 0)
              }
              className="muted"
            >
              {allCount === 0
                ? (emptyMessage ?? t("accountDetail.flowsEmpty"))
                : (filteredEmptyMessage ?? t("accountDetail.flowsFilteredEmpty"))}
            </td>
          </tr>
        ) : (
          pageRows.map((row) => (
            <tr key={row.key}>
              {showAccountColumn ? <td>{row.account_name ?? "—"}</td> : null}
              <td>{row.flow_type_label}</td>
              <td>{row.occurred_on}</td>
              {showFlowTickerCol ? <td>{row.ticker ?? "—"}</td> : null}
              <td className="mono">
                {row.amount_clp != null && Number.isFinite(row.amount_clp)
                  ? formatClp(row.amount_clp)
                  : "—"}
              </td>
              {showFlowUsdCol ? (
                <td className="mono">
                  {row.amount_usd != null && Number.isFinite(row.amount_usd)
                    ? formatUsdFine(row.amount_usd)
                    : "—"}
                </td>
              ) : null}
              {showUnitsColumn ? (
                <td className="mono">
                  {row.units_delta != null &&
                  Number.isFinite(row.units_delta) &&
                  Math.abs(row.units_delta) > 1e-12
                    ? formatInstrumentUnits(
                        row.units_delta,
                        row.ticker != null
                          ? "shares"
                          : (movementUnitsKind?.(row.category_slug ?? "") ?? "shares")
                      )
                    : "—"}
                </td>
              ) : null}
              <td className="muted">{row.note ?? "—"}</td>
            </tr>
          ))
        )
      }
    />
  );
}
