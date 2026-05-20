import { insertAppMessage } from "./appMessages.js";

export type SyncChangeGroup =
  | "afp"
  | "sbif_usd"
  | "sbif_eur"
  | "sbif_uf"
  | "sbif_utm"
  | "sbif_ipc"
  | "fintual"
  | "tickers";

export type SyncFieldChange = {
  group: SyncChangeGroup;
  label: string;
  oldValue: string;
  newValue: string;
  oldDate: string | null;
  newDate: string | null;
};

export type SyncStepError = {
  step: string;
  message: string;
};

export type SyncRunLogOptions = {
  /** Fintual API was checked (≥18:00) and no mapped goal NAV changed. */
  fintualNoChange?: boolean;
  /** Step failures (sync continues; listed under Errors in the log body). */
  errors?: SyncStepError[];
};

/** CLP balance integers for sync log lines. */
export function formatSyncClp(n: number): string {
  if (!Number.isFinite(n)) return "—";
  return String(Math.round(n));
}

/** FX rate (USD/EUR per CLP) with two decimals. */
export function formatSyncFxRate(n: number): string {
  if (!Number.isFinite(n)) return "—";
  return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** UF (CLP per UF) with two decimals. */
export function formatSyncUfRate(n: number): string {
  if (!Number.isFinite(n)) return "—";
  return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** Equity close in USD. */
export function formatSyncUsdClose(n: number): string {
  if (!Number.isFinite(n)) return "—";
  return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 4 });
}

const FLAT_GROUP_ORDER: SyncChangeGroup[] = [
  "afp",
  "sbif_usd",
  "sbif_eur",
  "sbif_uf",
  "sbif_utm",
  "sbif_ipc",
];

const SECTION_GROUPS: { group: SyncChangeGroup; title: string }[] = [
  { group: "fintual", title: "Fintual" },
  { group: "tickers", title: "Tickers" },
];

function formatDatedValue(date: string | null, value: string): string {
  if (date && /^\d{4}-\d{2}-\d{2}$/.test(date)) return `${date} ${value}`;
  return value;
}

function formatChangeLine(c: SyncFieldChange, indent = ""): string {
  const oldPart = formatDatedValue(c.oldDate, c.oldValue);
  const newPart = formatDatedValue(c.newDate, c.newValue);
  return `${indent}- ${c.label}: ${oldPart} > ${newPart}`;
}

export function formatSyncLogBody(
  staleSources: string[],
  changes: SyncFieldChange[],
  opts?: SyncRunLogOptions
): string {
  const lines: string[] = [];
  lines.push(`Stale: ${staleSources.length ? staleSources.join(", ") : "none"}`);

  const errors = opts?.errors ?? [];
  const hasFintualSection =
    opts?.fintualNoChange === true || changes.some((c) => c.group === "fintual");
  const hasAnyContent = changes.length > 0 || hasFintualSection || errors.length > 0;

  if (!hasAnyContent) {
    lines.push("No changes");
    return lines.join("\n");
  }

  if (changes.length > 0 || hasFintualSection) {
    lines.push("Changes:");
  } else {
    lines.push("Changes: none");
  }

  for (const g of FLAT_GROUP_ORDER) {
    for (const c of changes.filter((x) => x.group === g)) {
      lines.push(formatChangeLine(c));
    }
  }

  for (const { group, title } of SECTION_GROUPS) {
    if (group === "fintual") {
      const fintualChanges = changes.filter((c) => c.group === "fintual");
      if (fintualChanges.length === 0 && !opts?.fintualNoChange) continue;
      lines.push(`${title}:`);
      if (fintualChanges.length === 0) {
        lines.push("    - No change");
      } else {
        for (const c of fintualChanges) {
          lines.push(formatChangeLine(c, "    "));
        }
      }
      continue;
    }
    const sectionChanges = changes.filter((c) => c.group === group);
    if (!sectionChanges.length) continue;
    lines.push(`${title}:`);
    for (const c of sectionChanges) {
      lines.push(formatChangeLine(c, "    "));
    }
  }

  if (errors.length > 0) {
    lines.push("Errors:");
    for (const err of errors) {
      lines.push(`- ${err.step}: ${err.message}`);
    }
  }

  return lines.join("\n");
}

export function insertSyncRunLog(
  staleSources: string[],
  changes: SyncFieldChange[],
  dryRun: boolean,
  opts?: SyncRunLogOptions
): void {
  const body = formatSyncLogBody(staleSources, changes, opts);
  const title = `Sync ${new Date().toISOString().slice(0, 19).replace("T", " ")} UTC`;
  insertAppMessage("log", title, body, dryRun);
}
