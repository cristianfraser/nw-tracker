import type { DisplayUnit } from "./keys";
import type { GroupPageShell } from "./groupPageShell";
import { persistedPayload, readPersistedPayload, writePersistedPayload } from "./persistedPayloadCache";

const GROUP_SHELL = persistedPayload(
  "group_shell",
  (v): v is GroupPageShell =>
    v != null &&
    typeof v === "object" &&
    Array.isArray((v as GroupPageShell).accounts) &&
    Array.isArray((v as GroupPageShell).dashAccounts)
);

/** True when localStorage has a group-page shell row for this unit. */
export function hasGroupPageShellCache(portfolioGroup: string, unit: DisplayUnit): boolean {
  return readGroupPageShellCache(portfolioGroup, unit) != null;
}

export function readGroupPageShellCache(
  portfolioGroup: string,
  unit: DisplayUnit
): GroupPageShell | undefined {
  return readPersistedPayload(GROUP_SHELL, [portfolioGroup, unit]);
}

export function writeGroupPageShellCache(
  portfolioGroup: string,
  unit: DisplayUnit,
  shell: GroupPageShell
): void {
  writePersistedPayload(GROUP_SHELL, [portfolioGroup, unit], shell);
}
