import type { DisplayUnit } from "./keys";
import type { GroupPageShell } from "./groupPageShell";

const STORAGE_PREFIX = "nw:group-shell-v1";

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
