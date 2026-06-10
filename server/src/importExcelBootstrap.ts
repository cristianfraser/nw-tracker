import { db } from "./db.js";

const existingBookValuationStmt = db.prepare(`
  SELECT 1 AS ok FROM valuations v
  INNER JOIN accounts a ON a.id = v.account_id
  INNER JOIN asset_groups g ON g.id = a.asset_group_id
  WHERE (a.notes LIKE 'import:excel%' OR a.notes LIKE 'import:cfraser%')
    AND g.slug != 'cuenta_corriente'
    AND g.slug NOT LIKE '%__cuenta_corriente'
  LIMIT 1
`);

/** True when the DB already has sheet-import book valuations (not a fresh bootstrap). */
export function importExcelHasExistingBookData(): boolean {
  return existingBookValuationStmt.get() != null;
}

export function importExcelArgvForceWipe(argv: readonly string[] = process.argv): boolean {
  return argv.includes("--force-wipe");
}

/** Full sheet rebuild: empty book data or explicit `--force-wipe`. */
export function importExcelShouldSheetRebuild(argv: readonly string[] = process.argv): boolean {
  return importExcelArgvForceWipe(argv) || !importExcelHasExistingBookData();
}
