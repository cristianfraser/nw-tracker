/**
 * Inbox hook: `cfraser/inbox/certificado_de_transacciones.csv` → canonical CSV + archive.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readCommaCsvRecords } from "./ccParsedCommaCsv.js";
import { resolveCfraserCsvDir, resolveCfraserInboxDir } from "./cfraserPaths.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../..");

export const FINTUAL_CERTIFICADO_CANONICAL_NAME = "fintual-certificado-de-transacciones.csv";

const REQUIRED_COLUMNS = [
  "fecha",
  ["id_inversión", "id_inversion"],
  "aporte_pesos_chilenos",
  "rescate_pesos_chilenos",
  "aporte_cuotas",
  "rescate_cuotas",
] as const;

export function fintualCertificadoArchiveDir(cfraserDir: string): string {
  return path.join(cfraserDir, "fintual-certificado");
}

export function findFintualCertificadoInboxCsv(_cfraserDir?: string): string | null {
  const inbox = resolveCfraserInboxDir();
  if (!fs.existsSync(inbox)) return null;
  const exact = path.join(inbox, "certificado_de_transacciones.csv");
  if (fs.existsSync(exact)) return exact;
  for (const name of fs.readdirSync(inbox)) {
    if (!name.toLowerCase().endsWith(".csv")) continue;
    const lower = name.toLowerCase();
    if (lower.includes("certificado") && lower.includes("transacciones")) {
      return path.join(inbox, name);
    }
  }
  return null;
}

function normHeader(s: string): string {
  return String(s ?? "")
    .trim()
    .replace(/^\ufeff/, "")
    .toLowerCase()
    .replace(/\s+/g, "_");
}

function headerKeysFromCsv(csvPath: string): Set<string> {
  const text = fs.readFileSync(csvPath, "utf8");
  const firstLine = text.split(/\r?\n/, 1)[0] ?? "";
  return new Set(
    firstLine.split(",").map((h) => normHeader(h.replace(/^"|"$/g, "")))
  );
}

function hasRequiredColumn(keys: Set<string>, col: string | readonly string[]): boolean {
  if (typeof col === "string") return keys.has(col);
  return col.some((c) => keys.has(c));
}

/** Fail fast if the CSV is not a Fintual certificado de transacciones export. */
export function validateFintualCertificadoCsv(csvPath: string): number {
  const keys = headerKeysFromCsv(csvPath);
  const missing = REQUIRED_COLUMNS.filter((col) => !hasRequiredColumn(keys, col));
  if (missing.length > 0) {
    const labels = missing.map((col) => (typeof col === "string" ? col : col.join("|"))).join(", ");
    throw new Error(
      `Fintual certificado CSV missing required column(s): ${labels} (${csvPath})`
    );
  }
  const rows = readCommaCsvRecords(csvPath);
  if (rows.length === 0) {
    throw new Error(`Fintual certificado CSV has no data rows: ${csvPath}`);
  }
  return rows.length;
}

export type ProcessFintualCertificadoInboxResult = {
  inboxPath: string | null;
  csvPath: string | null;
  rows: number;
  archivedTo: string | null;
};

/** Install inbox certificado CSV as `cfraser/fintual-certificado-de-transacciones.csv`. */
export function processFintualCertificadoInboxCsv(opts?: {
  cfraserDir?: string;
  dryRun?: boolean;
}): ProcessFintualCertificadoInboxResult {
  const cfraserDir = opts?.cfraserDir ?? resolveCfraserCsvDir();
  const dryRun = opts?.dryRun ?? false;
  const inboxPath = findFintualCertificadoInboxCsv(cfraserDir);
  if (!inboxPath) {
    return { inboxPath: null, csvPath: null, rows: 0, archivedTo: null };
  }

  const rows = validateFintualCertificadoCsv(inboxPath);

  const csvPath = path.join(cfraserDir, FINTUAL_CERTIFICADO_CANONICAL_NAME);
  const archiveDir = fintualCertificadoArchiveDir(cfraserDir);
  const archivedTo = path.join(archiveDir, path.basename(inboxPath));

  if (!dryRun) {
    fs.copyFileSync(inboxPath, csvPath);
    fs.mkdirSync(archiveDir, { recursive: true });
    if (fs.existsSync(archivedTo)) fs.unlinkSync(archivedTo);
    fs.renameSync(inboxPath, archivedTo);
  }

  return { inboxPath, csvPath, rows, archivedTo: dryRun ? null : archivedTo };
}

export function repoRootFromServerSrc(): string {
  return REPO_ROOT;
}
