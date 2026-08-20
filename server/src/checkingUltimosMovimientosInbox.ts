import fs from "node:fs";
import path from "node:path";

import { importCheckingRecentXlsx } from "./accountImports.js";
import { checkingAccountId } from "./checkingCartolaImport.js";
import { parseUltimosMovimientosBuffer } from "./checkingUltimosMovimientosParse.js";
import { resolveCfraserCsvDir, resolveCfraserInboxDir } from "./cfraserPaths.js";

/**
 * «ultimos movimientos-Cuenta Corriente.xlsx» — the daily web session's checking download
 * (`fetchCheckingMovements` in scraper/src/santander/checking.ts drops it in the inbox).
 * The browser may suffix re-downloads (` (1)`), so the match is prefix-based.
 */
const ULTIMOS_MOVIMIENTOS_FILE_RE = /^ultimos movimientos.*\.xlsx$/i;

export function isUltimosMovimientosXlsxFilename(name: string): boolean {
  return ULTIMOS_MOVIMIENTOS_FILE_RE.test(String(name ?? "").trim());
}

/** Staged files in the inbox, oldest mtime first, so a backlog imports in capture order. */
export function listUltimosMovimientosInboxFiles(dir = resolveCfraserInboxDir()): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter(isUltimosMovimientosXlsxFilename)
    .map((name) => path.join(dir, name))
    .sort((a, b) => fs.statSync(a).mtimeMs - fs.statSync(b).mtimeMs);
}

export function ultimosMovimientosArchiveDir(cfraserDir = resolveCfraserCsvDir()): string {
  return path.join(cfraserDir, "checking-ultimos-movimientos", "imported");
}

export type UltimosMovimientosInboxFileResult = {
  file: string;
  rows_parsed: number;
  inserted: number;
  skipped_duplicate: number;
  skipped_superseded_by_cartola: number;
  skipped_superseded_by_transfer: number;
  parse_errors: string[];
  archived_to: string | null;
};

/**
 * One log line per imported file with every skip reason visible — a bank row absorbed by an
 * internal transfer leg (e.g. a synthesized Fintual retiro) must be readable in the nightly
 * summary, not silently missing from the arithmetic. Zero-count superseded reasons are omitted
 * so the ordinary all-duplicates night keeps its familiar short shape.
 */
export function formatUltimosInboxFileSummary(r: UltimosMovimientosInboxFileResult): string {
  const parts = [`${r.inserted} inserted`, `${r.skipped_duplicate} duplicate(s)`];
  if (r.skipped_superseded_by_cartola > 0) {
    parts.push(`${r.skipped_superseded_by_cartola} superseded by cartola`);
  }
  if (r.skipped_superseded_by_transfer > 0) {
    parts.push(`${r.skipped_superseded_by_transfer} superseded by transfer`);
  }
  const archived = r.archived_to ? `; archived ${r.archived_to}` : "";
  return `${r.file}: ${r.rows_parsed} row(s) parsed, ${parts.join(", ")}${archived}`;
}

/**
 * Import one staged «últimos movimientos» xlsx into the cuenta corriente and archive it.
 * The download's filename is constant, so the archived copy is date-stamped from the file's
 * mtime (the fetch day); a same-day re-run overwrites its own archive copy.
 */
export function importUltimosMovimientosInboxFile(
  file: string,
  opts?: { archiveDir?: string; dryRun?: boolean }
): UltimosMovimientosInboxFileResult {
  const buffer = fs.readFileSync(file);
  const basename = path.basename(file);

  if (opts?.dryRun) {
    const parsed = parseUltimosMovimientosBuffer(buffer, basename);
    return {
      file: basename,
      rows_parsed: parsed.movements.length,
      inserted: 0,
      skipped_duplicate: 0,
      skipped_superseded_by_cartola: 0,
      skipped_superseded_by_transfer: 0,
      parse_errors: parsed.errors,
      archived_to: null,
    };
  }

  const result = importCheckingRecentXlsx(checkingAccountId(), buffer, basename);
  if (result.format !== "ultimos_movimientos") {
    throw new Error(
      `${basename}: expected an ultimos-movimientos workbook, importer resolved format "${result.format}"`
    );
  }

  const archiveDir = opts?.archiveDir ?? ultimosMovimientosArchiveDir();
  fs.mkdirSync(archiveDir, { recursive: true });
  const mtimeYmd = new Date(fs.statSync(file).mtimeMs).toISOString().slice(0, 10);
  const archivedTo = path.join(archiveDir, `${mtimeYmd} ${basename}`);
  if (fs.existsSync(archivedTo)) fs.unlinkSync(archivedTo);
  fs.renameSync(file, archivedTo);

  return {
    file: basename,
    rows_parsed:
      result.inserted +
      result.skipped_duplicate +
      result.skipped_superseded_by_cartola +
      result.skipped_superseded_by_transfer,
    inserted: result.inserted,
    skipped_duplicate: result.skipped_duplicate,
    skipped_superseded_by_cartola: result.skipped_superseded_by_cartola,
    skipped_superseded_by_transfer: result.skipped_superseded_by_transfer,
    parse_errors: result.parse_errors,
    archived_to: archivedTo,
  };
}

export function importUltimosMovimientosInboxFiles(opts?: {
  inboxDir?: string;
  archiveDir?: string;
  dryRun?: boolean;
}): UltimosMovimientosInboxFileResult[] {
  return listUltimosMovimientosInboxFiles(opts?.inboxDir).map((file) =>
    importUltimosMovimientosInboxFile(file, { archiveDir: opts?.archiveDir, dryRun: opts?.dryRun })
  );
}
