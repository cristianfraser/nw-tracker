import type { DashboardNavSnapshotResponse, DashboardResponse } from "../types";
import type { DisplayUnit } from "./keys";

/** Bump when cached snapshot shape changes (e.g. v3 adds `nw_bucket_totals`). */
const STORAGE_PREFIX = "nw:dashboard-nav-snapshot-v3";

/** Strip full dashboard totals to nav-snapshot bucket fields (server canonical card headers). */
export function nwBucketTotalsFromDashTotals(
  totals: DashboardResponse["totals"]
): DashboardNavSnapshotResponse["nw_bucket_totals"] {
  return {
    net_worth_clp: totals.net_worth_clp,
    real_estate_clp: totals.real_estate_clp,
    retirement_clp: totals.retirement_clp,
    brokerage_clp: totals.brokerage_clp,
    cash_eqs_clp: totals.cash_eqs_clp,
    prior_closes: totals.prior_closes,
    net_worth_usd: totals.net_worth_usd,
    real_estate_usd: totals.real_estate_usd,
    retirement_usd: totals.retirement_usd,
    brokerage_usd: totals.brokerage_usd,
    cash_eqs_usd: totals.cash_eqs_usd,
  };
}

function storageKey(unit: DisplayUnit): string {
  return `${STORAGE_PREFIX}:${unit}`;
}

export function readDashboardNavSnapshotCache(
  unit: DisplayUnit
): DashboardNavSnapshotResponse | undefined {
  try {
    const raw = localStorage.getItem(storageKey(unit));
    if (!raw) return undefined;
    return JSON.parse(raw) as DashboardNavSnapshotResponse;
  } catch {
    return undefined;
  }
}

export function writeDashboardNavSnapshotCache(
  unit: DisplayUnit,
  snapshot: DashboardNavSnapshotResponse
): void {
  try {
    localStorage.setItem(storageKey(unit), JSON.stringify(snapshot));
  } catch {
    // quota / private mode
  }
}
