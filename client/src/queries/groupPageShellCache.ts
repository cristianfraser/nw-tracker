import type { DisplayUnit } from "./keys";
import type { GroupPageShell } from "./groupPageShell";

const STORAGE_PREFIX = "nw:group-shell-v1";

/** True when localStorage has a group-page shell row (CLP fallback for USD). */
export function hasGroupPageShellCache(portfolioGroup: string, unit: DisplayUnit): boolean {
  if (readGroupPageShellCache(portfolioGroup, unit) != null) return true;
  if (unit === "usd" && readGroupPageShellCache(portfolioGroup, "clp") != null) return true;
  return false;
}

function storageKey(portfolioGroup: string, unit: DisplayUnit): string {
  return `${STORAGE_PREFIX}:${portfolioGroup}:${unit}`;
}

export function readGroupPageShellCache(
  portfolioGroup: string,
  unit: DisplayUnit
): GroupPageShell | undefined {
  try {
    const raw = localStorage.getItem(storageKey(portfolioGroup, unit));
    if (!raw) return undefined;
    return JSON.parse(raw) as GroupPageShell;
  } catch {
    return undefined;
  }
}

export function writeGroupPageShellCache(
  portfolioGroup: string,
  unit: DisplayUnit,
  shell: GroupPageShell
): void {
  try {
    localStorage.setItem(storageKey(portfolioGroup, unit), JSON.stringify(shell));
  } catch {
    // quota / private mode
  }
}
