import { useCallback, useMemo, useState } from "react";
import { useDisplayPreferences } from "../../context/DisplayPreferencesContext";
import { parseFlowsAmountFilter } from "../../flowsAmountFilter";
import { useTranslation } from "../../i18n";
import { useGroupFlows, useAccountFlows, type FlowsQueryFilters } from "../../queries/hooks";
import { DEFAULT_FLOWS_FILTER_STATE, FlowsTable, type FlowsFilterState } from "./FlowsTable";

const PAGE_SIZE = 20;

/**
 * Extended filters shared by both panel variants (exact wins over min/max, like the server),
 * plus the first amount field that isn't a number.
 */
function extraFiltersFromState(fs: FlowsFilterState): {
  filters: Partial<FlowsQueryFilters>;
  amountError: string | null;
} {
  const exact = parseFlowsAmountFilter(fs.amount_exact);
  const min = exact.value == null ? parseFlowsAmountFilter(fs.amount_min) : null;
  const max = exact.value == null ? parseFlowsAmountFilter(fs.amount_max) : null;
  const hasAmountFilter = exact.value != null || min?.value != null || max?.value != null;
  return {
    filters: {
      date_from: fs.date_from || undefined,
      date_to: fs.date_to || undefined,
      amount_exact: exact.value,
      amount_min: min?.value,
      amount_max: max?.value,
      // Only meaningful alongside an amount filter; omitted otherwise so query keys stay stable.
      amount_currency:
        hasAmountFilter && fs.amount_currency && fs.amount_currency !== "clp"
          ? fs.amount_currency
          : undefined,
    },
    amountError: exact.error ?? min?.error ?? max?.error ?? null,
  };
}

type GroupFlowsPanelProps = {
  kind: "group";
  groupSlug: string;
  showUnitsColumn?: boolean;
};

type AccountFlowsPanelProps = {
  kind: "account";
  accountId: number | string;
  movementUnitsKind?: (slug: string) => "shares" | "coin";
  showPersonalOnlyFilter?: boolean;
};

export type FlowsPanelProps = (GroupFlowsPanelProps | AccountFlowsPanelProps) & {
  enabled?: boolean;
};

function GroupFlowsPanel({
  groupSlug,
  showUnitsColumn = false,
  enabled = true,
}: GroupFlowsPanelProps & { enabled?: boolean }) {
  const { t } = useTranslation();
  const { decimalSeparator, language } = useDisplayPreferences();
  const [page, setPage] = useState(1);
  const [filterState, setFilterState] = useState<FlowsFilterState>(DEFAULT_FLOWS_FILTER_STATE);

  // The separator setting decides how a typed amount reads, and the message is translated:
  // both key the parse.
  const extra = useMemo(
    () => extraFiltersFromState(filterState),
    [filterState, decimalSeparator, language]
  );
  const filters = useMemo(
    (): FlowsQueryFilters => ({
      page,
      pageSize: PAGE_SIZE,
      year: filterState.year || undefined,
      type: filterState.type || undefined,
      account_id: filterState.account_id ? Number(filterState.account_id) : undefined,
      bucket: filterState.bucket || undefined,
      q: filterState.q || undefined,
      ...extra.filters,
    }),
    [page, filterState, extra]
  );

  const { data, isFetching, isPending } = useGroupFlows(groupSlug, filters, enabled);

  const handleFilterChange = useCallback((patch: Partial<FlowsFilterState>) => {
    setFilterState((prev) => ({ ...prev, ...patch }));
    setPage(1);
  }, []);

  // Disabled by the caller (the group is not named yet) or not loaded yet: the table frame, dimmed.
  return (
    <FlowsTable
      rows={data?.rows ?? []}
      total={data?.total ?? 0}
      page={data?.page ?? page}
      pageSize={PAGE_SIZE}
      onPageChange={setPage}
      loading={isPending || isFetching}
      showAccountColumn
      showUnitsColumn={showUnitsColumn}
      emptyMessage={t("accountDetail.flowsEmpty")}
      filteredEmptyMessage={t("accountDetail.flowsFilteredEmpty")}
      filterOptions={data?.filter_options}
      filterState={filterState}
      onFilterChange={handleFilterChange}
      amountFilterError={extra.amountError}
    />
  );
}

function AccountFlowsPanel({
  accountId,
  movementUnitsKind,
  showPersonalOnlyFilter = true,
  enabled = true,
}: AccountFlowsPanelProps & { enabled?: boolean }) {
  const { t } = useTranslation();
  const { decimalSeparator, language } = useDisplayPreferences();
  const [page, setPage] = useState(1);
  const [filterState, setFilterState] = useState<FlowsFilterState>(DEFAULT_FLOWS_FILTER_STATE);

  const id = String(accountId);

  // The separator setting decides how a typed amount reads, and the message is translated:
  // both key the parse.
  const extra = useMemo(
    () => extraFiltersFromState(filterState),
    [filterState, decimalSeparator, language]
  );
  const filters = useMemo(
    (): FlowsQueryFilters => ({
      page,
      pageSize: PAGE_SIZE,
      year: filterState.year || undefined,
      type: filterState.type || undefined,
      q: filterState.q || undefined,
      personal_only: filterState.personal_only || undefined,
      ...extra.filters,
    }),
    [page, filterState, extra]
  );

  const { data, isFetching } = useAccountFlows(id, filters, enabled);

  const handleFilterChange = useCallback((patch: Partial<FlowsFilterState>) => {
    setFilterState((prev) => ({ ...prev, ...patch }));
    setPage(1);
  }, []);

  // Only show personal_only checkbox if explicitly requested and filter option meaningful
  const filterStateForTable = showPersonalOnlyFilter
    ? filterState
    : { ...filterState, personal_only: false };

  return (
    <FlowsTable
      rows={data?.rows ?? []}
      total={data?.total ?? 0}
      page={data?.page ?? page}
      pageSize={PAGE_SIZE}
      onPageChange={setPage}
      loading={isFetching}
      showAccountColumn={false}
      movementUnitsKind={movementUnitsKind}
      emptyMessage={t("accountDetail.flowsEmpty")}
      filteredEmptyMessage={t("accountDetail.flowsFilteredEmpty")}
      filterOptions={data?.filter_options}
      filterState={filterStateForTable}
      onFilterChange={handleFilterChange}
      amountFilterError={extra.amountError}
    />
  );
}

export function FlowsPanel(props: FlowsPanelProps) {
  if (props.kind === "group") {
    return <GroupFlowsPanel {...props} />;
  }
  return <AccountFlowsPanel {...props} />;
}
