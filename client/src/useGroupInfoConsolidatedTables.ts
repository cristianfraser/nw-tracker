import { useMemo } from "react";
import i18n from "./i18n";
import { useGroupConsolidatedTables } from "./queries/hooks";
import { useHeldUnitQuery } from "./queries/heldUnitPayload";
import { queryKeys, type DisplayUnit } from "./queries/keys";
import type { ConsolidatedMonthlyPerfRow, PeriodReturnsPayload } from "./types";
import { queryLoadError } from "./queries/pageShapeReady";

export type { GroupInfoTableAccount } from "./groupInfoTableAccount";
import type { GroupInfoTableAccount } from "./groupInfoTableAccount";

const EMPTY_ROWS: ConsolidatedMonthlyPerfRow[] = [];

export function useGroupInfoConsolidatedTables(
  portfolioGroupSlug: string,
  _accounts: readonly GroupInfoTableAccount[],
  displayUnit: DisplayUnit,
  enabled: boolean
) {
  const query = useGroupConsolidatedTables(portfolioGroupSlug, displayUnit, enabled);
  const { isError, error } = query;
  // The tables on screen: this unit's, or the ones held across a unit switch — shown in THEIR
  // unit (`tablesUnit`), dimmed, never converted.
  const shown = useHeldUnitQuery(query, {
    queryKey: queryKeys.groupConsolidatedTables(portfolioGroupSlug, displayUnit),
    unit: displayUnit,
    enabled: enabled && Boolean(portfolioGroupSlug),
  });
  const data = shown.data;
  // Nothing to show yet (not a background refetch): callers substitute placeholder rows, and a
  // refetch keeps showing the rows already loaded.
  const tablesLoading = enabled && data === undefined && query.isPending;

  const consolidatedMonthlyPerf = data?.consolidated_monthly ?? EMPTY_ROWS;
  const consolidatedYearlyPerf = data?.consolidated_yearly ?? EMPTY_ROWS;

  // undefined = not here yet (pending or disabled): callers render the table frame dimmed.
  // null = the server sends none (or the fetch failed): callers leave the table out.
  const periodReturns = useMemo((): PeriodReturnsPayload | null | undefined => {
    if (!data) return isError ? null : undefined;
    return data.period_returns ?? null;
  }, [data, isError]);

  const tableFlags = useMemo(() => {
    const slugs = _accounts.map((a) => a.category_slug);
    return {
      isMortgageAccount: slugs.length > 0 && slugs.every((s) => s === "mortgage"),
    };
  }, [_accounts]);

  return {
    consolidatedMonthlyPerf,
    consolidatedYearlyPerf,
    periodReturns,
    tableFlags,
    tablesLoading,
    /** The tables on hand are held from before (another unit or page), dimmed. */
    tablesHeld: shown.held,
    /** The unit the rows and the period returns are in (the held payload's own while held). */
    tablesUnit: data?.unit ?? displayUnit,
    tablesError: queryLoadError({ data, error })
      ? error instanceof Error
        ? error.message
        : i18n.t("common.loadFailedTables")
      : null,
  };
}
