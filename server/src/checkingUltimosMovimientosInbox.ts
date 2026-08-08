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
  parse_errors: string[];
  archived_to: string | null;
};

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
    rows_parsed: result.inserted + result.skipped_duplicate,
    inserted: result.inserted,
    skipped_duplicate: result.skipped_duplicate,
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
