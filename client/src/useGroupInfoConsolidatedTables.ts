import { useMemo } from "react";
import i18n from "./i18n";
import {
  convertConsolidatedMonthlyRowsUnit,
  convertPeriodReturnsUnit,
  resolveClpPerUsdForKeepPrev,
} from "./placeholders/keepPrevBundleUnit";
import { readFxLatestCache } from "./queries/fxLatestCache";
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
 * Consolidated rows in the display unit: pass-through when the payload already matches (or is
 * `uf`, which never converts); during a CLP↔USD switch the held prior-unit rows are FX-converted
 * so the table keeps values instead of blanking. Returns null when unconvertible (no FX rate) —
 * callers fall back to placeholder rows.
 */
export function consolidatedRowsForDisplay(
  rows: ConsolidatedMonthlyPerfRow[],
  sourceUnit: "clp" | "usd" | "uf",
  displayUnit: DisplayUnit
): ConsolidatedMonthlyPerfRow[] | null {
  const wanted = displayUnit === "usd" ? "usd" : "clp";
  if (sourceUnit === wanted || sourceUnit === "uf") return rows;
  const rate = resolveClpPerUsdForKeepPrev(undefined, readFxLatestCache());
  if (rate == null) return null;
  return convertConsolidatedMonthlyRowsUnit(rows, sourceUnit, displayUnit, rate);
}

/** Same keep-previous conversion for the period-returns strip (null when unconvertible). */
function periodReturnsForDisplay(
  payload: PeriodReturnsPayload,
  displayUnit: DisplayUnit
): PeriodReturnsPayload | null {
  const wanted = displayUnit === "usd" ? "usd" : "clp";
  if (payload.unit === wanted || payload.unit === "uf") return payload;
  const rate = resolveClpPerUsdForKeepPrev(undefined, readFxLatestCache());
  if (rate == null) return null;
  return convertPeriodReturnsUnit(payload, displayUnit, rate);
}

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
    () =>
      data
        ? (consolidatedRowsForDisplay(data.consolidated_monthly, data.unit, displayUnit) ?? [])
        : [],
    [data, displayUnit]
  );

  const periodReturns = useMemo(
    () =>
      data?.period_returns ? periodReturnsForDisplay(data.period_returns, displayUnit) : null,
    [data?.period_returns, displayUnit]
  );

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
    tablesError: isError
      ? error instanceof Error
        ? error.message
        : i18n.t("common.loadFailedTables")
      : null,
  };
}
