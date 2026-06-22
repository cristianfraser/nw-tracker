import { insertAppMessage } from "./appMessages.js";
import { db } from "./db.js";

export type SyncChangeGroup =
  | "afp"
  | "sbif_usd"
  | "sbif_eur"
  | "sbif_uf"
  | "sbif_utm"
  | "sbif_ipc"
  | "fintual"
  | "stocks_nyse"
  | "yahoo_fx_usd"
  | "crypto_eod"
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

export type SyncStepNote = {
  step: string;
  message: string;
};

export type SyncRunLogOptions = {
  /** Fintual API was checked (≥18:00) and no mapped goal NAV changed. */
  fintualNoChange?: boolean;
  /** Per-step outcomes (fetch ran, rows upserted, skipped, etc.). */
  notes?: SyncStepNote[];
  /** Step failures (sync continues; listed under Errors in the log body). */
  errors?: SyncStepError[];
};

/** CLP balance integers for sync log lines. */
function normalizeIntlNum(s: string): string {
  return s.replace(/\u202f|\u2007|\u00a0/g, " ").trim();
}

const intEsCl0 = new Intl.NumberFormat("es-CL", {
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
});

const intEsCl2 = new Intl.NumberFormat("es-CL", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const intEsCl2to4 = new Intl.NumberFormat("es-CL", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 4,
});

const intEsClDecimal = new Intl.NumberFormat("es-CL", {
  minimumFractionDigits: 0,
  maximumFractionDigits: 4,
});

/** Whole CLP amounts (e.g. `28.824.791`). */
export function formatSyncClp(n: number): string {
  if (!Number.isFinite(n)) return "—";
  return normalizeIntlNum(intEsCl0.format(Math.round(n)));
}

/** FX rate (USD/EUR per CLP) with two decimals (e.g. `981,59`). */
export function formatSyncFxRate(n: number): string {
  if (!Number.isFinite(n)) return "—";
  return normalizeIntlNum(intEsCl2.format(n));
}

/** UF (CLP per UF) with two decimals (e.g. `39.123,45`). */
export function formatSyncUfRate(n: number): string {
  if (!Number.isFinite(n)) return "—";
  return normalizeIntlNum(intEsCl2.format(n));
}

/** Equity / crypto close in USD (e.g. `733,73`). */
export function formatSyncUsdClose(n: number): string {
  if (!Number.isFinite(n)) return "—";
  return normalizeIntlNum(intEsCl2to4.format(n));
}

/** Index / ratio with optional decimals (e.g. IPC). */
export function formatSyncIndex(n: number): string {
  if (!Number.isFinite(n)) return "—";
  return normalizeIntlNum(intEsClDecimal.format(n));
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
  { group: "stocks_nyse", title: "NYSE stocks" },
  { group: "yahoo_fx_usd", title: "Yahoo USD/CLP" },
  { group: "crypto_eod", title: "Crypto" },
  { group: "tickers", title: "Tickers" },
];

function formatDatedValue(date: string | null, value: string): string {
  if (date && /^\d{4}-\d{2}-\d{2}$/.test(date)) return `${date} ${value}`;
  return value;
}

/** Parse es-CL formatted sync values back to numbers (for delta suffix). */
function parseSyncFormattedNumber(raw: string): number | null {
  const s = normalizeIntlNum(raw);
  if (!s || s === "—" || s.startsWith("+")) return null;
  const neg = s.startsWith("-") || s.startsWith("−");
  const body = s.replace(/^[-−+]/, "").trim();
  if (!body) return null;
  const normalized = body.replace(/\./g, "").replace(",", ".");
  const n = Number(normalized);
  if (!Number.isFinite(n)) return null;
  return neg ? -n : n;
}

function formatDeltaForGroup(group: SyncChangeGroup, delta: number): string {
  switch (group) {
    case "afp":
    case "fintual":
      return formatSyncClp(delta);
    case "sbif_usd":
    case "sbif_eur":
    case "yahoo_fx_usd":
      return formatSyncFxRate(delta);
    case "sbif_uf":
      return formatSyncUfRate(delta);
    case "stocks_nyse":
    case "crypto_eod":
      return formatSyncUsdClose(delta);
    case "sbif_ipc":
    case "sbif_utm":
    case "tickers":
      return formatSyncIndex(delta);
    default:
      return formatSyncIndex(delta);
  }
}

function formatChangeDeltaSuffix(c: SyncFieldChange): string {
  const oldN = parseSyncFormattedNumber(c.oldValue);
  const newN = parseSyncFormattedNumber(c.newValue);
  if (oldN == null || newN == null) return "";
  const delta = newN - oldN;
  if (Math.abs(delta) < 1e-12) return "";
  const absFormatted = formatDeltaForGroup(c.group, Math.abs(delta));
  const signed = delta > 0 ? `+${absFormatted}` : `-${absFormatted}`;
  return ` (${signed})`;
}

function formatChangeLine(c: SyncFieldChange, indent = ""): string {
  const oldPart = formatDatedValue(c.oldDate, c.oldValue);
  const newPart = formatDatedValue(c.newDate, c.newValue);
  return `${indent}- ${c.label}: ${oldPart} > ${newPart}${formatChangeDeltaSuffix(c)}`;
}

export type EquityEodRow = { trade_date: string; close_usd: number };

/** Build a sync-log change when trade date or close moved forward. */
export function equityEodSyncFieldChange(
  group: Extract<SyncChangeGroup, "stocks_nyse" | "crypto_eod">,
  label: string,
  before: EquityEodRow | null,
  after: EquityEodRow | null
): SyncFieldChange | null {
  if (after == null) return null;
  if (
    before != null &&
    before.trade_date === after.trade_date &&
    Math.abs(before.close_usd - after.close_usd) < 1e-8
  ) {
    return null;
  }
  return {
    group,
    label,
    oldValue: before != null ? formatSyncUsdClose(before.close_usd) : "—",
    newValue: formatSyncUsdClose(after.close_usd),
    oldDate: before?.trade_date ?? null,
    newDate: after.trade_date,
  };
}

export function formatSyncLogBody(
  staleSources: string[],
  changes: SyncFieldChange[],
  opts?: SyncRunLogOptions
): string {
  const lines: string[] = [];
  lines.push(`Stale: ${staleSources.length ? staleSources.join(", ") : "none"}`);

  const errors = opts?.errors ?? [];
  const notes = opts?.notes ?? [];
  const hasFintualSection =
    opts?.fintualNoChange === true || changes.some((c) => c.group === "fintual");
  const hasAnyContent = changes.length > 0 || hasFintualSection || notes.length > 0 || errors.length > 0;

  if (!hasAnyContent) {
    lines.push("No changes");
    return lines.join("\n");
  }

  if (notes.length > 0) {
    lines.push("Steps:");
    for (const n of notes) {
      lines.push(`- ${n.step}: ${n.message}`);
    }
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

/** Latest `global-sync` log row in `app_messages` (kind=log, title `Sync`). */
export function lastSyncRunCreatedAt(): string | null {
  const row = db
    .prepare(
      `SELECT created_at FROM app_messages
       WHERE kind = 'log' AND title LIKE 'Sync%'
       ORDER BY created_at DESC, id DESC
       LIMIT 1`
    )
    .get() as { created_at: string } | undefined;
  return row?.created_at ?? null;
}

export function insertSyncRunLog(
  staleSources: string[],
  changes: SyncFieldChange[],
  dryRun: boolean,
  opts?: SyncRunLogOptions
): void {
  const body = formatSyncLogBody(staleSources, changes, opts);
  insertAppMessage("log", "Sync", body, dryRun);
}
