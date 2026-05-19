import { insertAppMessage } from "./appMessages.js";

export type SyncFieldChange = {
  label: string;
  oldValue: string;
  newValue: string;
};

export function formatSyncLogBody(staleSources: string[], changes: SyncFieldChange[]): string {
  const lines: string[] = [];
  lines.push(`Stale: ${staleSources.length ? staleSources.join(", ") : "none"}`);
  if (changes.length === 0) {
    lines.push("Changes: none");
    return lines.join("\n");
  }
  lines.push("Changes:");
  for (const c of changes) {
    lines.push(`${c.label}: ${c.oldValue}`);
    lines.push(`    > ${c.newValue}`);
  }
  return lines.join("\n");
}

export function insertSyncRunLog(
  staleSources: string[],
  changes: SyncFieldChange[],
  dryRun: boolean
): void {
  const body = formatSyncLogBody(staleSources, changes);
  const title = `Sync ${new Date().toISOString().slice(0, 19).replace("T", " ")} UTC`;
  insertAppMessage("log", title, body, dryRun);
}
