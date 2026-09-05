import fs from "node:fs";
import path from "node:path";
import { resolveCfraserCsvDir } from "./cfraserPaths.js";
import { importCcWebPasteLines } from "./accountImports.js";
import { masterAccountIdForSantanderAccount } from "./santanderAccountMap.js";
import {
  santanderMovementsByAccount,
  type SantanderMovementsFile,
} from "./santanderCardMovements.js";

/** Where `scraper/` stages fetched movement files. */
export function resolveSantanderMovementsDir(): string {
  return path.join(resolveCfraserCsvDir(), "santander-movements");
}

/** Fetched files, oldest first, so a backlog imports in the order it was captured. */
export function listSantanderMovementFiles(dir = resolveSantanderMovementsDir()): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((name) => /^card-movements-.*\.json$/.test(name))
    .sort()
    .map((name) => path.join(dir, name));
}

export type SantanderAccountImportResult = {
  account: string;
  account_id: number;
  lines_parsed: number;
  inserted: number;
  skipped_duplicate: number;
  /** Cuota-billing reference rows (`CUOT: N OPER: M`) the feed lists at a facturación close. */
  skipped_cuota_billing: number;
  batch_id: number | null;
};

export type SantanderMovementsImportResult = {
  file: string;
  accounts: SantanderAccountImportResult[];
};

/**
 * Import one fetched movements file.
 *
 * Re-importing the same file is harmless: the lines carry the same `ccOneShotDedupeKey` a manual
 * paste would produce, so repeats are skipped as duplicates. That is what makes a daily fetch of an
 * overlapping window (the feed returns the whole unbilled period every time) safe to run.
 */
export function importSantanderMovementsFile(file: string): SantanderMovementsImportResult {
  const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as SantanderMovementsFile;
  const grouped = santanderMovementsByAccount(parsed);

  const accounts: SantanderAccountImportResult[] = [];
  for (const group of grouped) {
    const accountId = masterAccountIdForSantanderAccount(group.account);
    const result = importCcWebPasteLines(
      accountId,
      { lines: group.lines, errors: [] },
      "cc_santander_fetch"
    );
    accounts.push({
      account: group.account,
      account_id: accountId,
      lines_parsed: result.lines_parsed,
      inserted: result.inserted,
      skipped_duplicate: result.skipped_duplicate,
      skipped_cuota_billing: result.skipped_cuota_billing,
      batch_id: result.batch_id,
    });
  }
  return { file: path.basename(file), accounts };
}

/**
 * Import every staged file, then move each into `imported/`.
 *
 * Archiving rather than deleting keeps the raw feed around: it is the only copy of what the bank
 * actually returned on a given day, and re-importing it is idempotent if it is ever needed.
 */
export function importStagedSantanderMovements(dir = resolveSantanderMovementsDir()): SantanderMovementsImportResult[] {
  const files = listSantanderMovementFiles(dir);
  const results: SantanderMovementsImportResult[] = [];
  for (const file of files) {
    results.push(importSantanderMovementsFile(file));
    const archive = path.join(dir, "imported");
    fs.mkdirSync(archive, { recursive: true });
    fs.renameSync(file, path.join(archive, path.basename(file)));
  }
  return results;
}
