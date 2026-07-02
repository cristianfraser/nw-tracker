import type { DashboardNavSnapshotResponse, DashboardResponse } from "../types";
import type { DisplayUnit } from "./keys";

/** True when localStorage has a nav-snapshot row for this unit (CLP fallback for USD). */
export function hasDashboardNavSnapshotCache(unit: DisplayUnit): boolean {
  if (readDashboardNavSnapshotCache(unit) != null) return true;
  if (unit === "usd" && readDashboardNavSnapshotCache("clp") != null) return true;
  return false;
}

/** Bump when cached snapshot shape changes (v3 adds `nw_bucket_totals`, v4 `chart_shape`). */
const STORAGE_PREFIX = "nw:dashboard-nav-snapshot-v4";
const LEGACY_STORAGE_PREFIXES = ["nw:dashboard-nav-snapshot-v3"];

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
    for (const prefix of LEGACY_STORAGE_PREFIXES) {
      localStorage.removeItem(`${prefix}:${unit}`);
    }
  } catch {
    // quota / private mode
  }
}
