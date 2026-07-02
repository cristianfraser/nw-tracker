import { useMemo } from "react";
import i18n from "./i18n";
import { useGroupConsolidatedTables } from "./queries/hooks";
import type { DisplayUnit } from "./queries/keys";

export type GroupInfoTableAccount = {
  id: number;
  name: string;
  category_slug: string;
};

export function useGroupInfoConsolidatedTables(
  portfolioGroupSlug: string,
  _accounts: readonly GroupInfoTableAccount[],
  displayUnit: DisplayUnit,
  enabled: boolean
) {
  const { data, isPending, isError, error } = useGroupConsolidatedTables(
    portfolioGroupSlug,
    displayUnit,
    enabled
  );
  // Pending only (not background refetch): callers substitute placeholder rows while
  // tablesLoading, and a refetch must keep showing the already-loaded rows.
  const tablesLoading = enabled && isPending;

  const consolidatedMonthlyPerf = useMemo(
    () => data?.consolidated_monthly ?? [],
    [data?.consolidated_monthly]
  );

  const tableFlags = useMemo(() => {
    const slugs = _accounts.map((a) => a.category_slug);
    return {
      isMortgageAccount: slugs.length > 0 && slugs.every((s) => s === "mortgage"),
    };
  }, [_accounts]);

  return {
    consolidatedMonthlyPerf,
    tableFlags,
    tablesLoading,
    tablesError: isError
      ? error instanceof Error
        ? error.message
        : i18n.t("common.loadFailedTables")
      : null,
  };
}
