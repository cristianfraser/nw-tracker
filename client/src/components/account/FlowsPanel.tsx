import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "../../i18n";
import { useGroupFlows, useAccountFlows, type FlowsQueryFilters } from "../../queries/hooks";
import { DEFAULT_FLOWS_FILTER_STATE, FlowsTable, type FlowsFilterState } from "./FlowsTable";

const PAGE_SIZE = 20;

/** CLP amounts are integers; grouping separators are ignored ("1.325.724" ≡ "1325724"). */
function parseAmountFilter(raw: string): number | undefined {
  const digits = raw.replace(/\D/g, "");
  if (!digits) return undefined;
  const n = Number(digits);
  return Number.isFinite(n) ? n : undefined;
}

/** Extended filters shared by both panel variants (exact wins over min/max, like the server). */
function extraFiltersFromState(fs: FlowsFilterState): Partial<FlowsQueryFilters> {
  const exact = parseAmountFilter(fs.amount_exact);
  return {
    date_from: fs.date_from || undefined,
    date_to: fs.date_to || undefined,
    amount_exact: exact,
    amount_min: exact == null ? parseAmountFilter(fs.amount_min) : undefined,
    amount_max: exact == null ? parseAmountFilter(fs.amount_max) : undefined,
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
  const [page, setPage] = useState(1);
  const [filterState, setFilterState] = useState<FlowsFilterState>(DEFAULT_FLOWS_FILTER_STATE);

  const filters = useMemo(
    (): FlowsQueryFilters => ({
      page,
      pageSize: PAGE_SIZE,
      year: filterState.year || undefined,
      type: filterState.type || undefined,
      account_id: filterState.account_id ? Number(filterState.account_id) : undefined,
      category: filterState.category || undefined,
      q: filterState.q || undefined,
      ...extraFiltersFromState(filterState),
    }),
    [page, filterState]
  );

  const { data, isFetching } = useGroupFlows(groupSlug, filters, enabled);

  const handleFilterChange = useCallback((patch: Partial<FlowsFilterState>) => {
    setFilterState((prev) => ({ ...prev, ...patch }));
    setPage(1);
  }, []);

  if (!data && !isFetching) return null;

  return (
    <FlowsTable
      rows={data?.rows ?? []}
      total={data?.total ?? 0}
      page={data?.page ?? page}
      pageSize={PAGE_SIZE}
      onPageChange={setPage}
      loading={isFetching}
      showAccountColumn
      showUnitsColumn={showUnitsColumn}
      emptyMessage={t("accountDetail.flowsEmpty")}
      filteredEmptyMessage={t("accountDetail.flowsFilteredEmpty")}
      filterOptions={data?.filter_options}
      filterState={filterState}
      onFilterChange={handleFilterChange}
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
  const [page, setPage] = useState(1);
  const [filterState, setFilterState] = useState<FlowsFilterState>(DEFAULT_FLOWS_FILTER_STATE);

  const id = String(accountId);

  const filters = useMemo(
    (): FlowsQueryFilters => ({
      page,
      pageSize: PAGE_SIZE,
      year: filterState.year || undefined,
      type: filterState.type || undefined,
      q: filterState.q || undefined,
      personal_only: filterState.personal_only || undefined,
      ...extraFiltersFromState(filterState),
    }),
    [page, filterState]
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
    />
  );
}

export function FlowsPanel(props: FlowsPanelProps) {
  if (props.kind === "group") {
    return <GroupFlowsPanel {...props} />;
  }
  return <AccountFlowsPanel {...props} />;
}
