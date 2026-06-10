import type { DashboardNavSnapshotResponse } from "../types";
import type { DisplayUnit } from "./keys";

const STORAGE_PREFIX = "nw:dashboard-nav-snapshot-v2";

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
