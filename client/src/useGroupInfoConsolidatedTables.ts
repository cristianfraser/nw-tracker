import { useMemo } from "react";
import { consolidateAccountFlowRows } from "./accountFlows";
import { consolidateAccountMonthlyPerf } from "./groupPageConsolidatedTables";
import { useGroupAccountMovements, useGroupAccountsMonthlyPerformance } from "./queries/hooks";
import type { DisplayUnit } from "./queries/keys";

export type GroupInfoTableAccount = {
  id: number;
  name: string;
  category_slug: string;
};

export function useGroupInfoConsolidatedTables(
  accounts: readonly GroupInfoTableAccount[],
  displayUnit: DisplayUnit,
  enabled: boolean
) {
  const groupPerfQueries = useGroupAccountsMonthlyPerformance(accounts, displayUnit, enabled);
  const groupMovementsQueries = useGroupAccountMovements(accounts, enabled);

  const consolidatedMonthlyPerf = useMemo(() => {
    const payloads = groupPerfQueries
      .map((q) => q.data)
      .filter((d): d is NonNullable<typeof d> => d != null && d.monthly.length > 0);
    if (!payloads.length) return [];
    return consolidateAccountMonthlyPerf(payloads);
  }, [groupPerfQueries]);

  const consolidatedFlows = useMemo(() => {
    const byAccount = groupMovementsQueries
      .map((q) => q.data)
      .filter((d): d is NonNullable<typeof d> => d != null);
    if (!byAccount.length) return [];
    return consolidateAccountFlowRows(
      byAccount.map((d) => ({
        id: d.account.id,
        name: d.account.name,
        category_slug: d.account.category_slug,
        movements: d.movements,
      }))
    );
  }, [groupMovementsQueries]);

  const tableFlags = useMemo(() => {
    const slugs = accounts.map((a) => a.category_slug);
    return {
      isMortgageAccount: slugs.length > 0 && slugs.every((s) => s === "mortgage"),
    };
  }, [accounts]);

  const tablesLoading =
    groupPerfQueries.some((q) => q.isPending) || groupMovementsQueries.some((q) => q.isPending);

  return {
    consolidatedMonthlyPerf,
    consolidatedFlows,
    tableFlags,
    tablesLoading,
  };
}
