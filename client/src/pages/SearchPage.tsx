import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { FlowsTable, type FlowsFilterState } from "../components/account/FlowsTable";
import { useFlowsSearch, type FlowsQueryFilters } from "../queries/hooks";

const PAGE_SIZE = 50;

const DEFAULT_FILTER_STATE: FlowsFilterState = {
  year: "",
  type: "",
  account_id: "",
  category: "",
  q: "",
  personal_only: false,
};

type AmountFilterState = {
  date_from: string;
  date_to: string;
  amount_exact: string;
  amount_min: string;
  amount_max: string;
};

const DEFAULT_AMOUNT_STATE: AmountFilterState = {
  date_from: "",
  date_to: "",
  amount_exact: "",
  amount_min: "",
  amount_max: "",
};

/** CLP amounts are integers; grouping separators in the input are ignored ("1.325.724" ≡ "1325724"). */
function parseAmount(raw: string): number | undefined {
  const digits = raw.replace(/\D/g, "");
  if (!digits) return undefined;
  const n = Number(digits);
  return Number.isFinite(n) ? n : undefined;
}

export function SearchPage() {
  const { t } = useTranslation();
  const [page, setPage] = useState(1);
  const [filterState, setFilterState] = useState<FlowsFilterState>(DEFAULT_FILTER_STATE);
  const [extra, setExtra] = useState<AmountFilterState>(DEFAULT_AMOUNT_STATE);

  const amountExact = parseAmount(extra.amount_exact);
  const filters: FlowsQueryFilters = useMemo(
    () => ({
      page,
      pageSize: PAGE_SIZE,
      year: filterState.year || undefined,
      type: filterState.type || undefined,
      account_id: filterState.account_id ? Number(filterState.account_id) : undefined,
      category: filterState.category || undefined,
      q: filterState.q || undefined,
      date_from: extra.date_from || undefined,
      date_to: extra.date_to || undefined,
      // exact wins; the server rejects exact + min/max combined.
      amount_exact: amountExact,
      amount_min: amountExact == null ? parseAmount(extra.amount_min) : undefined,
      amount_max: amountExact == null ? parseAmount(extra.amount_max) : undefined,
    }),
    [page, filterState, extra, amountExact]
  );
  const { data, error, isPending, isFetching } = useFlowsSearch(filters);

  const handleFilterChange = useCallback((patch: Partial<FlowsFilterState>) => {
    setFilterState((prev) => ({ ...prev, ...patch }));
    setPage(1);
  }, []);
  const handleExtraChange = (patch: Partial<AmountFilterState>) => {
    setExtra((prev) => ({ ...prev, ...patch }));
    setPage(1);
  };

  return (
    <main>
      <h1>{t("search.title")}</h1>
      <p className="muted">{t("search.intro")}</p>
      <div className="flows-filters">
        <label>
          {t("search.dateFrom")}{" "}
          <input
            type="date"
            value={extra.date_from}
            onChange={(e) => handleExtraChange({ date_from: e.target.value })}
          />
        </label>{" "}
        <label>
          {t("search.dateTo")}{" "}
          <input
            type="date"
            value={extra.date_to}
            onChange={(e) => handleExtraChange({ date_to: e.target.value })}
          />
        </label>{" "}
        <label>
          {t("search.amountExact")}{" "}
          <input
            type="text"
            inputMode="numeric"
            size={12}
            value={extra.amount_exact}
            onChange={(e) => handleExtraChange({ amount_exact: e.target.value })}
          />
        </label>{" "}
        <label>
          {t("search.amountMin")}{" "}
          <input
            type="text"
            inputMode="numeric"
            size={12}
            disabled={amountExact != null}
            value={extra.amount_min}
            onChange={(e) => handleExtraChange({ amount_min: e.target.value })}
          />
        </label>{" "}
        <label>
          {t("search.amountMax")}{" "}
          <input
            type="text"
            inputMode="numeric"
            size={12}
            disabled={amountExact != null}
            value={extra.amount_max}
            onChange={(e) => handleExtraChange({ amount_max: e.target.value })}
          />
        </label>
      </div>
      {error ? (
        <p className="error">{error instanceof Error ? error.message : t("common.loadFailed")}</p>
      ) : (
        <FlowsTable
          rows={data?.rows ?? []}
          total={data?.total ?? 0}
          page={data?.page ?? page}
          pageSize={PAGE_SIZE}
          onPageChange={setPage}
          loading={isPending || isFetching}
          showAccountColumn
          filterOptions={data?.filter_options}
          filterState={filterState}
          onFilterChange={handleFilterChange}
          emptyMessage={t("search.empty")}
          filteredEmptyMessage={t("search.emptyFiltered")}
        />
      )}
    </main>
  );
}
