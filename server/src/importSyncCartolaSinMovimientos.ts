import fs from "node:fs";
import path from "node:path";
import { db } from "./db.js";
import type { ImportSyncDocumentKind } from "./importSyncDocumentTypes.js";
import {
  loadCartolaParsedPdfJsonEntries,
  resolveCartolaParsedPdfJsonPath,
  type CartolaParsedPdfJsonEntry,
} from "./importSyncDocumentFilePath.js";

/** Keyed by the file's identity on disk, so a re-parse shows without a restart. */
const parsedJsonCache = new Map<
  ImportSyncDocumentKind,
  { stamp: string; rows: CartolaParsedPdfJsonEntry[] }
>();

function cachedParsedJsonEntries(
  kind: ImportSyncDocumentKind
): CartolaParsedPdfJsonEntry[] {
  const jsonPath = resolveCartolaParsedPdfJsonPath(kind);
  let stamp = "missing";
  try {
    const stat = fs.statSync(jsonPath);
    stamp = `${stat.ino}|${stat.mtimeMs}|${stat.size}`;
  } catch {
    // No parse output yet: the loader answers [] for a missing file.
  }
  const hit = parsedJsonCache.get(kind);
  if (hit?.stamp === stamp) return hit.rows;
  const rows = loadCartolaParsedPdfJsonEntries(kind);
  parsedJsonCache.set(kind, { stamp, rows });
  return rows;
}

/**
 * Whether the import-sync matrix should show ○ (sin movimientos) for a cartola cell: the file's
 * import rows listed no movements (the import refuses none while the saldo moved,
 * `assertCartolaMonthWrote`), or, with no import row, the parser read none and flagged the banner.
 * Never reads the PDF.
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
      `SELECT COUNT(*) AS n, COALESCE(SUM(movement_count), 0) AS total
       FROM checking_cartola_imports
       WHERE account_id = ? AND source_file = ?`
    )
    .get(accountId, basename) as { n: number; total: number };
  if (Number(dbRow.n) > 0) return Number(dbRow.total) === 0;

  for (const entry of cachedParsedJsonEntries(documentKind)) {
    if (entry.source_file !== basename || entry.parse_status !== "ok") continue;
    const mvCount = entry.movements?.length ?? 0;
    if (mvCount > 0) return false;
    if (entry.cartola_sin_movimientos === true) return true;
  }
  return false;
}
