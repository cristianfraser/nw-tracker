import { Input } from "@crfrsr/ui";
import { cn } from "../../cn";
import { useTranslation } from "../../i18n";
import { resolveNavTreeLabel } from "../../sidebarNavFromApi";
import type { FlowsApiRow, FlowsFilterOptions } from "../../types";
import { formatClp, formatInstrumentUnits, formatUsdFine } from "../../format";
import { useCurrencies } from "../../queries/hooks";
import { PaginatedTable } from "../ui/PaginatedTable";
import { FlowRows, flowAccountsCell, type FlowRowItem } from "./FlowRows";
import styles from "./FlowsTable.module.css";

function formatFlowUnits(
  row: FlowsApiRow,
  unitsKind: "shares" | "coin" | "contracts" = "shares"
): string | null {
  if (
    row.units_delta == null ||
    !Number.isFinite(row.units_delta) ||
    Math.abs(row.units_delta) <= 1e-12
  ) {
    return null;
  }
  return formatInstrumentUnits(
    row.units_delta,
    unitsKind
  );
}


function formatMovementLeg(amount: number, currency: string): string {
  if (currency === "usd") return formatUsdFine(amount);
  if (currency === "clp") return formatClp(amount);
  // eur is schema-reserved; no movements carry it yet — surface raw rather than mislabel.
  return `${amount} ${currency.toUpperCase()}`;
}

/** Single Monto cell: native amount; fx conversions show both legs («$X → US$Y»). */
function formatMovementAmount(row: FlowsApiRow): string {
  const primary = formatMovementLeg(row.amount, row.currency);
  if (row.counter_amount != null && row.counter_currency != null) {
    return `${primary} → ${formatMovementLeg(row.counter_amount, row.counter_currency)}`;
  }
  return primary;
}

export type FlowsFilterState = {
  year: string;
  type: string;
  account_id: string;
  bucket: string;
  q: string;
  personal_only: boolean;
  /** Inclusive YYYY-MM-DD bounds (raw input values). */
  date_from: string;
  date_to: string;
  /** Raw amount inputs, read by `parseFlowsAmountFilter` (FlowsPanel); exact suppresses min/max. */
  amount_exact: string;
  amount_min: string;
  amount_max: string;
  /** Currency the amount filters compare against. */
  amount_currency: string;
};

export const DEFAULT_FLOWS_FILTER_STATE: FlowsFilterState = {
  year: "",
  type: "",
  account_id: "",
  bucket: "",
  q: "",
  personal_only: false,
  date_from: "",
  date_to: "",
  amount_exact: "",
  amount_min: "",
  amount_max: "",
  amount_currency: "clp",
};

/** Every loaded currency, in the server's order (core currencies first), the current choice always listed. */
export function amountFilterCurrencyCodes(loaded: readonly string[] | undefined, current: string): string[] {
  const codes = new Set<string>(loaded ?? []);
  codes.add(current);
  return [...codes];
}

export function FlowsTable({
  rows,
  total,
  page,
  pageSize,
  onPageChange,
  loading,
  showAccountColumn = false,
  showUnitsColumn = true,
  unitsKind,
  emptyMessage,
  filteredEmptyMessage,
  filterOptions,
  filterState,
  onFilterChange,
  amountFilterError,
}: {
  rows: readonly FlowsApiRow[];
  total: number;
  page: number;
  pageSize: number;
  onPageChange: (page: number) => void;
  /** Rows pending or held prior data: the table dims; with no rows yet it shows its header only, not the empty message. */
  loading?: boolean;
  showAccountColumn?: boolean;
  /** Off for consolidated group tables (mixed instruments). */
  showUnitsColumn?: boolean;
  unitsKind?: "shares" | "coin" | "contracts";
  emptyMessage?: string;
  filteredEmptyMessage?: string;
  filterOptions?: FlowsFilterOptions;
  filterState?: FlowsFilterState;
  onFilterChange?: (patch: Partial<FlowsFilterState>) => void;
  /** Why a typed amount filter isn't a number (that filter is left out of the query). */
  amountFilterError?: string | null;
}) {
  const { t } = useTranslation();
  const { data: currencies } = useCurrencies();
  const amountCurrencyCodes = amountFilterCurrencyCodes(
    currencies?.currencies.map((c) => c.code).filter((code) => code !== "uf"),
    filterState?.amount_currency || "clp"
  );
  const hasActiveFilter = filterState
    ? filterState.year || filterState.type || filterState.account_id || filterState.bucket ||
      filterState.q || filterState.personal_only || filterState.date_from || filterState.date_to ||
      filterState.amount_exact || filterState.amount_min || filterState.amount_max
    : false;

  // Before the first page arrives the bar is drawn with every select (each with only its «all»
  // choice, disabled), so it takes its loaded height and the list below does not move.
  const optionsPending = filterOptions == null && Boolean(loading);
  const opts = filterOptions ?? { years: [], types: [], accounts: [], buckets: [] };
  const filterBar =
    (filterOptions || optionsPending) && filterState && onFilterChange ? (
      <div className={styles.filterBar}>
        {optionsPending || opts.years.length > 0 ? (
          <select
            disabled={optionsPending}
            value={filterState.year}
            onChange={(e) => onFilterChange({ year: e.target.value, account_id: filterState.account_id })}
            aria-label={t("flows.filters.year")}
          >
            <option value="">{t("flows.filters.allYears")}</option>
            {opts.years.map((y) => (
              <option key={y} value={y}>
                {y}
              </option>
            ))}
          </select>
        ) : null}

        {optionsPending || opts.types.length > 0 ? (
          <select
            disabled={optionsPending}
            value={filterState.type}
            onChange={(e) => onFilterChange({ type: e.target.value })}
            aria-label={t("flows.filters.type")}
          >
            <option value="">{t("flows.filters.allTypes")}</option>
            {opts.types.map((tp) => (
              <option key={tp.value} value={tp.value}>
                {tp.label}
              </option>
            ))}
          </select>
        ) : null}

        {showAccountColumn && (optionsPending || opts.accounts.length > 0) ? (
          <select
            disabled={optionsPending}
            value={filterState.account_id}
            onChange={(e) => onFilterChange({ account_id: e.target.value })}
            aria-label={t("flows.filters.account")}
          >
            <option value="">{t("flows.filters.allAccounts")}</option>
            {opts.accounts.map((a) => (
              <option key={a.id} value={String(a.id)}>
                {a.name}
              </option>
            ))}
          </select>
        ) : null}

        {showAccountColumn && (optionsPending || opts.buckets.length > 0) ? (
          <select
            disabled={optionsPending}
            value={filterState.bucket}
            onChange={(e) => onFilterChange({ bucket: e.target.value })}
            aria-label={t("flows.filters.bucket")}
          >
            <option value="">{t("flows.filters.allBuckets")}</option>
            {opts.buckets.map((b) => (
              <option key={b.slug} value={b.slug}>
                {resolveNavTreeLabel(b)}
              </option>
            ))}
          </select>
        ) : null}

        <div className={styles.filterWide}>
          <Input
            type="search"
            value={filterState.q}
            onChange={(e) => onFilterChange({ q: e.target.value })}
            placeholder={t("flows.filters.notePlaceholder")}
          />
        </div>

        <div className={styles.filterMedium}>
          <Input
            type="date"
            value={filterState.date_from}
            onChange={(e) => onFilterChange({ date_from: e.target.value })}
            aria-label={t("flows.filters.dateFrom")}
          />
        </div>
        <div className={styles.filterMedium}>
          <Input
            type="date"
            value={filterState.date_to}
            onChange={(e) => onFilterChange({ date_to: e.target.value })}
            aria-label={t("flows.filters.dateTo")}
          />
        </div>
        <select
          value={filterState.amount_currency || "clp"}
          onChange={(e) => onFilterChange({ amount_currency: e.target.value })}
          aria-label={t("flows.filters.amountCurrency")}
        >
          {amountCurrencyCodes.map((code) => (
            <option key={code} value={code}>
              {code.toUpperCase()}
            </option>
          ))}
        </select>
        <div className={styles.filterNarrow}>
          <Input
            type="text"
            inputMode="numeric"
            value={filterState.amount_exact}
            onChange={(e) => onFilterChange({ amount_exact: e.target.value })}
            placeholder={t("flows.filters.amountExact")}
          />
        </div>
        <div className={styles.filterTiny}>
          <Input
            type="text"
            inputMode="numeric"
            value={filterState.amount_min}
            disabled={Boolean(filterState.amount_exact.trim())}
            onChange={(e) => onFilterChange({ amount_min: e.target.value })}
            placeholder={t("flows.filters.amountMin")}
          />
        </div>
        <div className={styles.filterTiny}>
          <Input
            type="text"
            inputMode="numeric"
            value={filterState.amount_max}
            disabled={Boolean(filterState.amount_exact.trim())}
            onChange={(e) => onFilterChange({ amount_max: e.target.value })}
            placeholder={t("flows.filters.amountMax")}
          />
        </div>

        {filterState.personal_only !== undefined ? (
          <label className={styles.checkLabel}>
            <input
              type="checkbox"
              checked={filterState.personal_only}
              onChange={(e) => onFilterChange({ personal_only: e.target.checked })}
            />
            {t("accountDetail.flowsPersonalOnly")}
          </label>
        ) : null}
        {amountFilterError ? (
          <span className={cn("error", styles.filterError)}>
            {amountFilterError}
          </span>
        ) : null}
      </div>
    ) : null;

  const items: FlowRowItem[] = rows.map((row) => ({
    key: row.key,
    date: row.occurred_on,
    type: row.flow_type_label,
    accounts: flowAccountsCell(showAccountColumn ? "group" : "account", row),
    amount: formatMovementAmount(row),
    units: showUnitsColumn ? formatFlowUnits(row, unitsKind) : null,
    note: (row.display_note ?? row.note)?.trim() || null,
    noteTitle: row.display_note != null && row.note?.trim() ? row.note : null,
  }));

  const emptyText = hasActiveFilter
    ? (filteredEmptyMessage ?? t("accountDetail.flowsFilteredEmpty"))
    : (emptyMessage ?? t("accountDetail.flowsEmpty"));

  return (
    <PaginatedTable
      page={page}
      pageSize={pageSize}
      total={total}
      onPageChange={onPageChange}
      filters={filterBar}
      loading={loading}
    >
      <FlowRows
        rows={items}
        bothAccounts={showAccountColumn}
        accountsLabel={
          showAccountColumn
            ? t("accountDetail.flowAccountsColumn")
            : t("accountDetail.movements.counterpartAccount")
        }
        emptyMessage={loading ? null : emptyText}
        placeholderRows={loading ? pageSize : 0}
      />
    </PaginatedTable>
  );
}
