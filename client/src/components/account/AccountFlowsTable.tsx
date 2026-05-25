import { useTranslation } from "../../i18n";
import {
  accountFlowsShowTickerColumn,
  accountFlowsShowUsdColumn,
  type AccountFlowsTableRow,
} from "../../accountFlows";
import { formatClp, formatInstrumentUnits, formatUsdFine } from "../../format";
import { Table } from "../ui/Table";

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
  const hidden = Math.max(0, rows.length - collapsedVisibleRows);
  const allCount = totalCount ?? rows.length;

  return (
    <Table
      collapsedVisibleRows={collapsedVisibleRows}
      showMoreLabel={t("table.showMoreFlows", { count: hidden })}
      showLessLabel={t("table.showLessFlows")}
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
    >
      {rows.length === 0 ? (
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
        rows.map((row) => (
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
      )}
    </Table>
  );
}
