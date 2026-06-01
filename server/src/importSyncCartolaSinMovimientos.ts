import path from "node:path";
import { cartolaPdfIndicatesSinMovimientos } from "./cartolaSinMovimientos.js";
import { db } from "./db.js";
import type { ImportSyncDocumentKind } from "./importSyncDocumentCoverage.js";
import {
  loadCartolaParsedPdfJsonEntries,
  type CartolaParsedPdfJsonEntry,
} from "./importSyncDocumentFilePath.js";

const parsedJsonCache = new Map<
  ImportSyncDocumentKind,
  CartolaParsedPdfJsonEntry[]
>();

function cachedParsedJsonEntries(
  kind: ImportSyncDocumentKind
): CartolaParsedPdfJsonEntry[] {
  let rows = parsedJsonCache.get(kind);
  if (!rows) {
    rows = loadCartolaParsedPdfJsonEntries(kind);
    parsedJsonCache.set(kind, rows);
  }
  return rows;
}

/** @internal test hook */
export function clearImportSyncCartolaSinMovimientosCache(): void {
  parsedJsonCache.clear();
}

/**
 * Whether the import-sync matrix should show ○ (sin movimientos) for a cartola cell.
 * Uses imported / parsed movement totals — not whole-PDF banner text alone.
 */
export function importSyncCartolaSinMovimientosForMonth(opts: {
  accountId: number;
  documentKind: ImportSyncDocumentKind;
  filePath: string | null;
}): boolean {
  const { accountId, documentKind, filePath } = opts;
  if (!filePath) return false;
  if (documentKind !== "checking_cartola" && documentKind !== "cuenta_vista_cartola") {
    return false;
  }

  const basename = path.basename(filePath);

  const dbRow = db
    .prepare(
      `SELECT COALESCE(SUM(movement_count), 0) AS total
       FROM checking_cartola_imports
       WHERE account_id = ? AND source_file = ?`
    )
    .get(accountId, basename) as { total: number };
  if (Number(dbRow.total) > 0) return false;

  for (const entry of cachedParsedJsonEntries(documentKind)) {
    if (entry.source_file !== basename || entry.parse_status !== "ok") continue;
    const mvCount = entry.movements?.length ?? 0;
    if (mvCount > 0) return false;
    if (entry.cartola_sin_movimientos === true) return true;
  }

  return cartolaPdfIndicatesSinMovimientos(filePath);
}
