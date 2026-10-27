import { useMemo } from "react";
import i18n from "./i18n";
import { useGroupConsolidatedTables } from "./queries/hooks";
import type { DisplayUnit } from "./queries/keys";
import type { ConsolidatedMonthlyPerfRow, PeriodReturnsPayload } from "./types";

export type GroupInfoTableAccount = {
  id: number;
  name: string;
  /** Optional: dashboard/page-bundle rows may omit category_slug. */
  category_slug?: string;
};

/**
 * Consolidated rows in the display unit: the payload's own rows when its unit matches (or is
 * `uf`, which never converts); null for a held prior-unit payload — callers fall back to
 * placeholder rows.
 */
export function consolidatedRowsForDisplay(
  rows: ConsolidatedMonthlyPerfRow[],
  sourceUnit: "clp" | "usd" | "uf",
  displayUnit: DisplayUnit
): ConsolidatedMonthlyPerfRow[] | null {
  const wanted = displayUnit === "usd" ? "usd" : "clp";
  return sourceUnit === wanted || sourceUnit === "uf" ? rows : null;
}

/** Same rule for the period-returns strip: the payload when its unit matches (or is `uf`), null
 * for a held prior-unit payload. */
function periodReturnsForDisplay(
  payload: PeriodReturnsPayload,
  displayUnit: DisplayUnit
): PeriodReturnsPayload | null {
  const wanted = displayUnit === "usd" ? "usd" : "clp";
  return payload.unit === wanted || payload.unit === "uf" ? payload : null;
}

export function useGroupInfoConsolidatedTables(
  portfolioGroupSlug: string,
  _accounts: readonly GroupInfoTableAccount[],
  displayUnit: DisplayUnit,
  enabled: boolean
) {
  const { data, isPending, isPlaceholderData, isError, error } = useGroupConsolidatedTables(
    portfolioGroupSlug,
    displayUnit,
    enabled
  );
  // Pending only (not background refetch): callers substitute placeholder rows while
  // tablesLoading, and a refetch must keep showing the already-loaded rows.
  const tablesLoading = enabled && isPending;

  const consolidatedMonthlyPerf = useMemo(
    () =>
      data
        ? (consolidatedRowsForDisplay(data.consolidated_monthly, data.unit, displayUnit) ?? [])
        : [],
    [data, displayUnit]
  );

  // undefined = not here yet (pending, disabled, or held prior-unit data):
  // callers render the table frame dimmed. null = the server sends none (or the fetch failed):
  // callers leave the table out.
  const periodReturns = useMemo((): PeriodReturnsPayload | null | undefined => {
    if (!data) return isError ? null : undefined;
    if (!data.period_returns) return null;
    return periodReturnsForDisplay(data.period_returns, displayUnit) ?? undefined;
  }, [data, isError, displayUnit]);

  const tableFlags = useMemo(() => {
    const slugs = _accounts.map((a) => a.category_slug);
    return {
      isMortgageAccount: slugs.length > 0 && slugs.every((s) => s === "mortgage"),
    };
  }, [_accounts]);

  return {
    consolidatedMonthlyPerf,
    periodReturns,
    tableFlags,
    tablesLoading,
    /** The payload on hand is the previous unit's (held while the new one loads). */
    tablesHeld: isPlaceholderData,
    tablesError: isError
      ? error instanceof Error
        ? error.message
        : i18n.t("common.loadFailedTables")
      : null,
  };
}
