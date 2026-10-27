import type { DisplayUnit } from "./keys";
import type { GroupPageShell } from "./groupPageShell";

/** v2 adds `first_month`. */
const STORAGE_PREFIX = "nw:group-shell-v2";

/** True when localStorage has a group-page shell row for this unit. */
export function hasGroupPageShellCache(portfolioGroup: string, unit: DisplayUnit): boolean {
  return readGroupPageShellCache(portfolioGroup, unit) != null;
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
    localStorage.removeItem(`nw:group-shell-v1:${portfolioGroup}:${unit}`);
  } catch {
    // quota / private mode
  }
}
