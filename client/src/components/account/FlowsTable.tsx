import { useMemo } from "react";
import { useTranslation } from "../../i18n";
import {
  accountFlowsShowCounterpartColumn,
  accountFlowsShowTickerColumn,
  accountFlowsShowUsdColumn,
  type FlowsTableRow,
} from "../../accountFlows";
import { formatClp, formatInstrumentUnits, formatUsdFine } from "../../format";
import { PaginatedTable } from "../ui/PaginatedTable";
import {
  TableMobileCard,
  TableMobileCardRow,
  TableMobileCardSection,
} from "../ui/TableMobileCard";

function formatFlowUnits(
  row: FlowsTableRow,
  movementUnitsKind?: (slug: string) => "shares" | "coin"
): string {
  if (
    row.units_delta == null ||
    !Number.isFinite(row.units_delta) ||
    Math.abs(row.units_delta) <= 1e-12
  ) {
    return "—";
  }
  return formatInstrumentUnits(
    row.units_delta,
    row.ticker != null ? "shares" : (movementUnitsKind?.(row.category_slug ?? "") ?? "shares")
  );
}

function formatFlowClp(amount: number | null): string {
  return amount != null && Number.isFinite(amount) ? formatClp(amount) : "—";
}

function formatFlowUsd(amount: number | null): string {
  return amount != null && Number.isFinite(amount) ? formatUsdFine(amount) : "—";
}

function flowsColumnCount(
  showAccountColumn: boolean,
  showFlowTickerCol: boolean,
  showFlowUsdCol: boolean,
  showUnitsColumn: boolean,
  showCounterpartCol: boolean
): number {
  return (
    4 +
    (showAccountColumn ? 1 : 0) +
    (showFlowTickerCol ? 1 : 0) +
    (showFlowUsdCol ? 1 : 0) +
    (showUnitsColumn ? 1 : 0) +
    (showCounterpartCol ? 1 : 0) +
    1
  );
}

function FlowsMobileCard({
  row,
  labels,
  showAccountColumn,
  showFlowTickerCol,
  showFlowUsdCol,
  showUnitsColumn,
  movementUnitsKind,
}: {
  row: FlowsTableRow;
  labels: {
    account: string;
    type: string;
    date: string;
    ticker: string;
    amountClp: string;
    amountUsd: string;
    units: string;
    note: string;
  };
  showAccountColumn: boolean;
  showFlowTickerCol: boolean;
  showFlowUsdCol: boolean;
  showUnitsColumn: boolean;
  movementUnitsKind?: (slug: string) => "shares" | "coin";
}) {
  const note = row.note?.trim() ? row.note : null;

  return (
    <TableMobileCard title={row.flow_type_label}>
      <TableMobileCardSection>
        <TableMobileCardRow label={labels.date} value={row.occurred_on} />
        {showAccountColumn ? (
          <TableMobileCardRow
            label={labels.account}
            value={row.account_name ?? "—"}
            truncateValue
            valueTitle={row.account_name ?? undefined}
          />
        ) : null}
        {showFlowTickerCol ? (
          <TableMobileCardRow label={labels.ticker} value={row.ticker ?? "—"} />
        ) : null}
      </TableMobileCardSection>

      <TableMobileCardSection>
        <TableMobileCardRow label={labels.amountClp} value={formatFlowClp(row.amount_clp)} />
        {showFlowUsdCol ? (
          <TableMobileCardRow label={labels.amountUsd} value={formatFlowUsd(row.amount_usd)} />
        ) : null}
        {showUnitsColumn ? (
          <TableMobileCardRow
            label={labels.units}
            value={formatFlowUnits(row, movementUnitsKind)}
          />
        ) : null}
      </TableMobileCardSection>

      {note ? (
        <TableMobileCardSection>
          <div className="table-mobile-card__note">
            <span className="table-mobile-card__label">{labels.note}</span>
            <p className="table-mobile-card__note-text">{note}</p>
          </div>
        </TableMobileCardSection>
      ) : null}
    </TableMobileCard>
  );
}

export function FlowsTable({
  rows,
  collapsedVisibleRows = 10,
  showAccountColumn = false,
  showUnitsColumn = true,
  movementUnitsKind,
  emptyMessage,
  filteredEmptyMessage,
  totalCount,
}: {
  rows: readonly FlowsTableRow[];
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
  const showCounterpartCol = accountFlowsShowCounterpartColumn(rows);
  const allCount = totalCount ?? rows.length;

  const mobileLabels = {
    account: t("groupPage.flowsAccountColumn"),
    type: t("accountDetail.flowTypeColumn"),
    date: t("accountDetail.flowDateColumn"),
    ticker: t("accountDetail.flowTickerColumn"),
    amountClp: t("accountDetail.flowAmountClpColumn"),
    amountUsd: t("accountDetail.flowAmountUsdColumn"),
    units: t("accountDetail.flowUnitsColumn"),
    note: t("accountDetail.flowNoteColumn"),
    counterpart: t("accountDetail.movements.counterpartAccount"),
  };

  const pages = useMemo(() => {
    if (rows.length === 0) return [];

    const byYear = new Map<string, FlowsTableRow[]>();
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

  const colSpan = flowsColumnCount(
    showAccountColumn,
    showFlowTickerCol,
    showFlowUsdCol,
    showUnitsColumn,
    showCounterpartCol
  );

  return (
    <PaginatedTable
      pages={pages}
      collapsedVisibleRows={collapsedVisibleRows}
      showMoreLabel={(hiddenCount) => t("table.showMoreFlows", { count: hiddenCount })}
      showLessLabel={t("table.showLessFlows")}
      tableClassName="table--parallel-mobile flows-table"
      getPageLabel={(page) => page.data[0]?.occurred_on.slice(0, 4) ?? "—"}
      header={
        <thead>
          <tr>
            {showAccountColumn ? (
              <th className="desktop-only flows-table__account">
                {t("groupPage.flowsAccountColumn")}
              </th>
            ) : null}
            <th className="desktop-only">{t("accountDetail.flowTypeColumn")}</th>
            <th className="desktop-only">{t("accountDetail.flowDateColumn")}</th>
            {showFlowTickerCol ? (
              <th className="desktop-only">{t("accountDetail.flowTickerColumn")}</th>
            ) : null}
            <th className="desktop-only">{t("accountDetail.flowAmountClpColumn")}</th>
            {showFlowUsdCol ? (
              <th className="desktop-only">{t("accountDetail.flowAmountUsdColumn")}</th>
            ) : null}
            {showUnitsColumn ? (
              <th className="desktop-only">{t("accountDetail.flowUnitsColumn")}</th>
            ) : null}
            {showCounterpartCol ? (
              <th className="desktop-only">{t("accountDetail.movements.counterpartAccount")}</th>
            ) : null}
            <th className="desktop-only">{t("accountDetail.flowNoteColumn")}</th>
            <th className="mobile-only" aria-hidden="true" />
          </tr>
        </thead>
      }
      renderBody={(pageRows) =>
        pageRows.length === 0 ? (
          <tr>
            <td colSpan={colSpan} className="muted">
              {allCount === 0
                ? (emptyMessage ?? t("accountDetail.flowsEmpty"))
                : (filteredEmptyMessage ?? t("accountDetail.flowsFilteredEmpty"))}
            </td>
          </tr>
        ) : (
          pageRows.map((row) => (
            <tr key={row.key}>
              {showAccountColumn ? (
                <td
                  className="desktop-only flows-table__account"
                  title={row.account_name ?? undefined}
                >
                  {row.account_name ?? "—"}
                </td>
              ) : null}
              <td className="desktop-only">{row.flow_type_label}</td>
              <td className="desktop-only">{row.occurred_on}</td>
              {showFlowTickerCol ? (
                <td className="desktop-only">{row.ticker ?? "—"}</td>
              ) : null}
              <td className="mono desktop-only">{formatFlowClp(row.amount_clp)}</td>
              {showFlowUsdCol ? (
                <td className="mono desktop-only">{formatFlowUsd(row.amount_usd)}</td>
              ) : null}
              {showUnitsColumn ? (
                <td className="mono desktop-only">
                  {formatFlowUnits(row, movementUnitsKind)}
                </td>
              ) : null}
              {showCounterpartCol ? (
                <td className="desktop-only">{row.counterpart_account_name ?? "—"}</td>
              ) : null}
              <td className="muted desktop-only">{row.note ?? "—"}</td>
              <td className="mobile-only">
                <FlowsMobileCard
                  row={row}
                  labels={mobileLabels}
                  showAccountColumn={showAccountColumn}
                  showFlowTickerCol={showFlowTickerCol}
                  showFlowUsdCol={showFlowUsdCol}
                  showUnitsColumn={showUnitsColumn}
                  movementUnitsKind={movementUnitsKind}
                />
              </td>
            </tr>
          ))
        )
      }
    />
  );
}
