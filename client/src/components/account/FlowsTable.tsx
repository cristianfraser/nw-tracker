import { useTranslation } from "../../i18n";
import type { FlowsApiRow, FlowsFilterOptions } from "../../types";
import { formatClp, formatInstrumentUnits, formatOrDash, formatUsdFine } from "../../format";
import { PaginatedTable } from "../ui/PaginatedTable";
import { Table } from "../ui/Table";
import {
  TableMobileCard,
  TableMobileCardRow,
  TableMobileCardSection,
} from "../ui/TableMobileCard";

function formatFlowUnits(
  row: FlowsApiRow,
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


function showTickerColumn(rows: readonly FlowsApiRow[]): boolean {
  return rows.some((r) => r.ticker != null && String(r.ticker).trim() !== "");
}

function showUsdColumn(rows: readonly FlowsApiRow[]): boolean {
  return rows.some((r) => r.amount_usd != null && Number.isFinite(r.amount_usd));
}

function showCounterpartColumn(rows: readonly FlowsApiRow[]): boolean {
  return rows.some((r) => r.counterpart_account_name != null && r.counterpart_account_name.trim() !== "");
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
  row: FlowsApiRow;
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
        <TableMobileCardRow label={labels.amountClp} value={formatOrDash(row.amount_clp, formatClp)} />
        {showFlowUsdCol ? (
          <TableMobileCardRow label={labels.amountUsd} value={formatOrDash(row.amount_usd, formatUsdFine)} />
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

export type FlowsFilterState = {
  year: string;
  type: string;
  account_id: string;
  category: string;
  q: string;
  personal_only: boolean;
  /** Inclusive YYYY-MM-DD bounds (raw input values). */
  date_from: string;
  date_to: string;
  /** Raw amount inputs; digits-only parse, exact suppresses min/max. */
  amount_exact: string;
  amount_min: string;
  amount_max: string;
};

export const DEFAULT_FLOWS_FILTER_STATE: FlowsFilterState = {
  year: "",
  type: "",
  account_id: "",
  category: "",
  q: "",
  personal_only: false,
  date_from: "",
  date_to: "",
  amount_exact: "",
  amount_min: "",
  amount_max: "",
};

export function FlowsTable({
  rows,
  total,
  page,
  pageSize,
  onPageChange,
  loading,
  showAccountColumn = false,
  showUnitsColumn = true,
  movementUnitsKind,
  emptyMessage,
  filteredEmptyMessage,
  filterOptions,
  filterState,
  onFilterChange,
}: {
  rows: readonly FlowsApiRow[];
  total: number;
  page: number;
  pageSize: number;
  onPageChange: (page: number) => void;
  loading?: boolean;
  showAccountColumn?: boolean;
  /** Off for consolidated group tables (mixed instruments). */
  showUnitsColumn?: boolean;
  movementUnitsKind?: (slug: string) => "shares" | "coin";
  emptyMessage?: string;
  filteredEmptyMessage?: string;
  filterOptions?: FlowsFilterOptions;
  filterState?: FlowsFilterState;
  onFilterChange?: (patch: Partial<FlowsFilterState>) => void;
}) {
  const { t } = useTranslation();
  const showFlowTickerCol = showTickerColumn(rows);
  const showFlowUsdCol = showUsdColumn(rows);
  const showCounterpartCol = showCounterpartColumn(rows);

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

  const colSpan = flowsColumnCount(
    showAccountColumn,
    showFlowTickerCol,
    showFlowUsdCol,
    showUnitsColumn,
    showCounterpartCol
  );

  const hasActiveFilter = filterState
    ? filterState.year || filterState.type || filterState.account_id || filterState.category ||
      filterState.q || filterState.personal_only || filterState.date_from || filterState.date_to ||
      filterState.amount_exact || filterState.amount_min || filterState.amount_max
    : false;

  const filterBar =
    filterOptions && filterState && onFilterChange ? (
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: "0.5rem",
          alignItems: "center",
          fontSize: "0.875rem",
        }}
      >
        {filterOptions.years.length > 0 ? (
          <select
            value={filterState.year}
            onChange={(e) => onFilterChange({ year: e.target.value, account_id: filterState.account_id })}
            aria-label={t("flows.filters.year")}
          >
            <option value="">{t("flows.filters.allYears")}</option>
            {filterOptions.years.map((y) => (
              <option key={y} value={y}>
                {y}
              </option>
            ))}
          </select>
        ) : null}

        {filterOptions.types.length > 0 ? (
          <select
            value={filterState.type}
            onChange={(e) => onFilterChange({ type: e.target.value })}
            aria-label={t("flows.filters.type")}
          >
            <option value="">{t("flows.filters.allTypes")}</option>
            {filterOptions.types.map((tp) => (
              <option key={tp.value} value={tp.value}>
                {tp.label}
              </option>
            ))}
          </select>
        ) : null}

        {showAccountColumn && filterOptions.accounts.length > 0 ? (
          <select
            value={filterState.account_id}
            onChange={(e) => onFilterChange({ account_id: e.target.value })}
            aria-label={t("flows.filters.account")}
          >
            <option value="">{t("flows.filters.allAccounts")}</option>
            {filterOptions.accounts.map((a) => (
              <option key={a.id} value={String(a.id)}>
                {a.name}
              </option>
            ))}
          </select>
        ) : null}

        {showAccountColumn && filterOptions.categories.length > 0 ? (
          <select
            value={filterState.category}
            onChange={(e) => onFilterChange({ category: e.target.value })}
            aria-label={t("flows.filters.category")}
          >
            <option value="">{t("flows.filters.allCategories")}</option>
            {filterOptions.categories.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        ) : null}

        <input
          type="search"
          value={filterState.q}
          onChange={(e) => onFilterChange({ q: e.target.value })}
          placeholder={t("flows.filters.notePlaceholder")}
          style={{ minWidth: "10rem", maxWidth: "16rem" }}
        />

        <input
          type="date"
          value={filterState.date_from}
          onChange={(e) => onFilterChange({ date_from: e.target.value })}
          aria-label={t("flows.filters.dateFrom")}
        />
        <input
          type="date"
          value={filterState.date_to}
          onChange={(e) => onFilterChange({ date_to: e.target.value })}
          aria-label={t("flows.filters.dateTo")}
        />
        <input
          type="text"
          inputMode="numeric"
          value={filterState.amount_exact}
          onChange={(e) => onFilterChange({ amount_exact: e.target.value })}
          placeholder={t("flows.filters.amountExact")}
          style={{ width: "7rem" }}
        />
        <input
          type="text"
          inputMode="numeric"
          value={filterState.amount_min}
          disabled={Boolean(filterState.amount_exact.trim())}
          onChange={(e) => onFilterChange({ amount_min: e.target.value })}
          placeholder={t("flows.filters.amountMin")}
          style={{ width: "6.5rem" }}
        />
        <input
          type="text"
          inputMode="numeric"
          value={filterState.amount_max}
          disabled={Boolean(filterState.amount_exact.trim())}
          onChange={(e) => onFilterChange({ amount_max: e.target.value })}
          placeholder={t("flows.filters.amountMax")}
          style={{ width: "6.5rem" }}
        />

        {filterState.personal_only !== undefined ? (
          <label style={{ display: "flex", alignItems: "center", gap: "0.3rem" }}>
            <input
              type="checkbox"
              checked={filterState.personal_only}
              onChange={(e) => onFilterChange({ personal_only: e.target.checked })}
            />
            {t("accountDetail.flowsPersonalOnly")}
          </label>
        ) : null}
      </div>
    ) : null;

  const header = (
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
        <th className="desktop-only flows-table__note">{t("accountDetail.flowNoteColumn")}</th>
        <th className="mobile-only" aria-hidden="true" />
      </tr>
    </thead>
  );

  return (
    <PaginatedTable
      page={page}
      pageSize={pageSize}
      total={total}
      onPageChange={onPageChange}
      filters={filterBar}
      loading={loading}
    >
      <Table
        key={`flows-table-page-${page}`}
        header={header}
        tableClassName="table--parallel-mobile flows-table"
        tableStyle={{ whiteSpace: "nowrap" }}
      >
        {rows.length === 0 ? (
          <tr>
            <td colSpan={colSpan} className="muted">
              {hasActiveFilter
                ? (filteredEmptyMessage ?? t("accountDetail.flowsFilteredEmpty"))
                : (emptyMessage ?? t("accountDetail.flowsEmpty"))}
            </td>
          </tr>
        ) : (
          rows.map((row) => (
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
              <td className="mono desktop-only">{formatOrDash(row.amount_clp, formatClp)}</td>
              {showFlowUsdCol ? (
                <td className="mono desktop-only">{formatOrDash(row.amount_usd, formatUsdFine)}</td>
              ) : null}
              {showUnitsColumn ? (
                <td className="mono desktop-only">
                  {formatFlowUnits(row, movementUnitsKind)}
                </td>
              ) : null}
              {showCounterpartCol ? (
                <td className="desktop-only">
                  {row.counterpart_account_name
                    ? `${row.transfer_direction === "out" ? "→" : row.transfer_direction === "in" ? "←" : ""} ${row.counterpart_account_name}`.trim()
                    : "—"}
                </td>
              ) : null}
              <td
                className="muted desktop-only flows-table__note"
                title={row.note ?? undefined}
              >{row.note ?? "—"}</td>
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
        )}
      </Table>
    </PaginatedTable>
  );
}
