import { useMemo } from "react";
import { consolidateAccountFlowRows } from "./accountFlows";
import { useGroupConsolidatedTables } from "./queries/hooks";
import type { DisplayUnit } from "./queries/keys";

export type GroupInfoTableAccount = {
  id: number;
  name: string;
  category_slug: string;
};

export function useGroupInfoConsolidatedTables(
  groupSlug: string,
  subgroup: string | undefined,
  _accounts: readonly GroupInfoTableAccount[],
  displayUnit: DisplayUnit,
  enabled: boolean
) {
  const { data, isPending, isFetching, isError, error } = useGroupConsolidatedTables(
    groupSlug,
    subgroup,
    displayUnit,
    enabled
  );
  const tablesLoading = enabled && (isPending || isFetching);

  const consolidatedMonthlyPerf = useMemo(
    () => data?.consolidated_monthly ?? [],
    [data?.consolidated_monthly]
  );

  const consolidatedFlows = useMemo(() => {
    const byAccount = data?.account_movements ?? [];
    if (!byAccount.length) return [];
    return consolidateAccountFlowRows(
      byAccount.map((d) => ({
        id: d.account_id,
        name: d.name,
        category_slug: d.category_slug,
        movements: d.movements,
      }))
    );
  }, [data?.account_movements]);

  const tableFlags = useMemo(() => {
    const slugs = _accounts.map((a) => a.category_slug);
    return {
      isMortgageAccount: slugs.length > 0 && slugs.every((s) => s === "mortgage"),
    };
  }, [_accounts]);

  return {
    consolidatedMonthlyPerf,
    consolidatedFlows,
    tableFlags,
    tablesLoading,
    tablesError: isError
      ? error instanceof Error
        ? error.message
        : "Failed to load tables"
      : null,
  };
}
